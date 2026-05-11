import { useCallback, useMemo, useRef, useState, type ReactNode } from "react";
import { Box, Text, useApp, useInput } from "ink";
import { streamMessage } from "../services/api/index.js";
import {
  findToolByName,
  getToolsApiParams,
  type ToolContext,
} from "../tools/index.js";
import type {
  ContentBlock,
  Message,
  StreamEvent,
  StreamResult,
  ToolResultBlock,
} from "../types/index.js";
import { Spinner } from "./components/Spinner.js";

const MAX_TOOL_TURNS = 50;

interface AppProps {
  model: string;
  system?: string;
}

interface ToolCallInfo {
  id: string;
  name: string;
  resultLength?: number;
  isError?: boolean;
}

function extractAssistantText(message: Message): string {
  if (typeof message.content === "string") {
    return message.content;
  }

  return message.content
    .filter((block): block is Extract<ContentBlock, { type: "text" }> => {
      return block.type === "text";
    })
    .map((block) => block.text)
    .join("");
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function App({ model, system }: AppProps): ReactNode {
  const { exit } = useApp();
  const toolsApiParams = useMemo(() => getToolsApiParams(), []);

  const [messages, setMessages] = useState<Message[]>([]);
  const [inputValue, setInputValue] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [spinnerLabel, setSpinnerLabel] = useState("Thinking");
  const [streamingText, setStreamingText] = useState("");
  const [toolCalls, setToolCalls] = useState<ToolCallInfo[]>([]);
  const [lastUsage, setLastUsage] = useState<{
    input: number;
    output: number;
  } | null>(null);
  const [infoMessage, setInfoMessage] = useState<string | null>(null);
  const [errorText, setErrorText] = useState<string | null>(null);

  const abortRef = useRef<AbortController | null>(null);
  const messagesRef = useRef<Message[]>([]);
  messagesRef.current = messages;

  const runStreamingTurn = useCallback(
    async (
      currentMessages: Message[],
      signal?: AbortSignal,
    ): Promise<StreamResult | null> => {
      const generator = streamMessage({
        messages: [...currentMessages],
        model,
        system,
        tools: toolsApiParams,
        signal,
      });

      let accumulatedText = "";

      while (true) {
        const { value, done } = await generator.next();

        if (done) {
          return value ?? null;
        }

        const event: StreamEvent = value;

        switch (event.type) {
          case "text":
            accumulatedText += event.text;
            setStreamingText(accumulatedText);
            break;

          case "tool_use_start":
            setToolCalls((prev) => [
              ...prev,
              { id: event.id, name: event.name },
            ]);
            setSpinnerLabel("Using tool");
            break;

          case "error":
            if (!signal?.aborted) {
              setErrorText(event.message);
            }
            return null;
        }
      }
    },
    [model, system, toolsApiParams],
  );

  const executeTools = useCallback(
    async (
      contentBlocks: ContentBlock[],
      signal?: AbortSignal,
    ): Promise<Message> => {
      const toolUseBlocks = contentBlocks.filter(
        (block): block is Extract<ContentBlock, { type: "tool_use" }> => {
          return block.type === "tool_use";
        },
      );
      const toolResults: ToolResultBlock[] = [];
      const toolContext: ToolContext = {
        cwd: process.cwd(),
        abortSignal: signal,
      };

      for (const block of toolUseBlocks) {
        if (signal?.aborted) {
          break;
        }

        const tool = findToolByName(block.name);

        if (!tool) {
          const content = `Error: Unknown tool "${block.name}".`;
          toolResults.push({
            type: "tool_result",
            tool_use_id: block.id,
            content,
            is_error: true,
          });
          setToolCalls((prev) =>
            prev.map((toolCall) =>
              toolCall.id === block.id
                ? {
                    ...toolCall,
                    resultLength: content.length,
                    isError: true,
                  }
                : toolCall,
            ),
          );
          continue;
        }

        setSpinnerLabel(`Running ${tool.name}`);
        const result = await tool.call(block.input, toolContext);

        toolResults.push({
          type: "tool_result",
          tool_use_id: block.id,
          content: result.content,
          ...(result.isError ? { is_error: true } : {}),
        });

        setToolCalls((prev) =>
          prev.map((toolCall) =>
            toolCall.id === block.id
              ? {
                  ...toolCall,
                  resultLength: result.content.length,
                  isError: result.isError,
                }
              : toolCall,
          ),
        );
      }

      return { role: "user", content: toolResults };
    },
    [],
  );

  const handleSubmit = useCallback(
    async (text: string): Promise<void> => {
      const trimmed = text.trim();

      if (!trimmed) {
        return;
      }

      if (trimmed === "/exit" || trimmed === "/quit") {
        exit();
        return;
      }

      if (trimmed === "/clear") {
        setMessages([]);
        messagesRef.current = [];
        setInputValue("");
        setInfoMessage("Conversation cleared.");
        setErrorText(null);
        setLastUsage(null);
        return;
      }

      if (trimmed === "/history") {
        setInfoMessage(`${messagesRef.current.length} messages in conversation.`);
        setErrorText(null);
        return;
      }

      setStreamingText("");
      setToolCalls([]);
      setErrorText(null);
      setInfoMessage(null);
      setLastUsage(null);
      setIsLoading(true);
      setSpinnerLabel("Thinking");

      const userMessage: Message = { role: "user", content: trimmed };
      let nextMessages = [...messagesRef.current, userMessage];
      setMessages(nextMessages);
      messagesRef.current = nextMessages;

      const abort = new AbortController();
      abortRef.current = abort;

      try {
        let totalInputTokens = 0;
        let totalOutputTokens = 0;
        let turnCount = 0;

        while (turnCount < MAX_TOOL_TURNS) {
          turnCount += 1;
          setStreamingText("");
          setSpinnerLabel("Thinking");

          const result = await runStreamingTurn(nextMessages, abort.signal);

          if (!result || abort.signal.aborted) {
            break;
          }

          totalInputTokens += result.usage.input_tokens;
          totalOutputTokens += result.usage.output_tokens;

          const assistantMessage: Message = result.assistantMessage;
          nextMessages = [...nextMessages, assistantMessage];
          setMessages(nextMessages);
          messagesRef.current = nextMessages;
          setStreamingText("");

          const contentBlocks = result.assistantMessage.content;

          if (
            result.stopReason === "tool_use" &&
            Array.isArray(contentBlocks)
          ) {
            const toolResultMessage = await executeTools(
              contentBlocks,
              abort.signal,
            );

            if (abort.signal.aborted) {
              break;
            }

            nextMessages = [...nextMessages, toolResultMessage];
            setMessages(nextMessages);
            messagesRef.current = nextMessages;
            continue;
          }

          break;
        }

        setLastUsage({
          input: totalInputTokens,
          output: totalOutputTokens,
        });
      } catch (error) {
        if (abort.signal.aborted) {
          setInfoMessage("Interrupted.");
        } else {
          setErrorText(getErrorMessage(error));
        }
      } finally {
        setIsLoading(false);
        abortRef.current = null;
      }
    },
    [executeTools, exit, runStreamingTurn],
  );

  useInput((input, key) => {
    if (key.ctrl && input === "c") {
      if (abortRef.current) {
        abortRef.current.abort();
        abortRef.current = null;
        setIsLoading(false);
        setStreamingText("");
        setInfoMessage("Interrupted.");
      }

      return;
    }

    if (key.ctrl && input === "d") {
      exit();
      return;
    }

    if (isLoading) {
      return;
    }

    if (key.return) {
      const text = inputValue;
      setInputValue("");
      void handleSubmit(text);
      return;
    }

    if (key.backspace || key.delete) {
      setInputValue((prev) => prev.slice(0, -1));
      return;
    }

    if (input && !key.ctrl && !key.meta) {
      setInputValue((prev) => prev + input);
    }
  });

  return (
    <Box flexDirection="column" paddingX={1}>
      <Box marginBottom={1}>
        <Text bold color="cyan">
          Easy Agent
        </Text>
        <Text dimColor> ({model})</Text>
      </Box>

      <Text dimColor>
        Type a message. Ctrl+C interrupts, Ctrl+D exits. Commands: /clear,
        /history, /exit
      </Text>

      {messages.map((message, index) => {
        if (message.role === "user" && typeof message.content === "string") {
          return (
            <Box key={`user-${index}`} marginTop={1}>
              <Text color="green" bold>
                {"> "}
              </Text>
              <Text>{message.content}</Text>
            </Box>
          );
        }

        if (message.role === "assistant") {
          const text = extractAssistantText(message);

          if (!text) {
            return null;
          }

          return (
            <Box key={`assistant-${index}`}>
              <Text color="magenta">{"| "}</Text>
              <Text>{text}</Text>
            </Box>
          );
        }

        return null;
      })}

      {toolCalls.map((toolCall) => (
        <Box key={toolCall.id} marginLeft={2}>
          {toolCall.resultLength === undefined ? (
            <Text color="yellow">Using tool: {toolCall.name}</Text>
          ) : (
            <Text color={toolCall.isError ? "red" : "green"}>
              {toolCall.name} ({toolCall.resultLength} chars)
            </Text>
          )}
        </Box>
      ))}

      {isLoading && !streamingText && <Spinner label={spinnerLabel} />}

      {isLoading && streamingText && (
        <Box>
          <Text color="magenta">{"| "}</Text>
          <Text>{streamingText}</Text>
        </Box>
      )}

      {errorText && <Text color="red">! {errorText}</Text>}
      {infoMessage && <Text dimColor>{infoMessage}</Text>}

      {lastUsage && !isLoading && (
        <Text dimColor>
          tokens: {lastUsage.input} in / {lastUsage.output} out
        </Text>
      )}

      {!isLoading && (
        <Box marginTop={1}>
          <Text color="green" bold>
            {"> "}
          </Text>
          <Text>{inputValue}</Text>
          <Text dimColor>_</Text>
        </Box>
      )}
    </Box>
  );
}
