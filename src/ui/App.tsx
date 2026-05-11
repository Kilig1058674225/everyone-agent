import { useCallback, useMemo, useRef, useState, type ReactNode } from "react";
import { Box, Text, useApp, useInput } from "ink";
import { query } from "../core/index.js";
import { getToolsApiParams } from "../tools/index.js";
import type { ContentBlock, Message } from "../types/index.js";
import { Spinner } from "./components/Spinner.js";

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
        const loop = query({
          messages: nextMessages,
          model,
          system,
          tools: toolsApiParams,
          toolContext: {
            cwd: process.cwd(),
            abortSignal: abort.signal,
          },
          signal: abort.signal,
        });

        let accumulatedText = "";

        while (true) {
          const { value, done } = await loop.next();

          if (done) {
            nextMessages = value.state.messages;
            setMessages(nextMessages);
            messagesRef.current = nextMessages;
            setStreamingText("");
            setLastUsage({
              input: value.usage.input_tokens,
              output: value.usage.output_tokens,
            });

            if (value.terminationReason === "aborted") {
              setInfoMessage("Interrupted.");
            } else if (value.terminationReason === "max_turns") {
              setInfoMessage("Stopped after reaching the tool turn limit.");
            } else if (value.terminationReason === "model_error") {
              setErrorText(
                value.error instanceof Error
                  ? value.error.message
                  : value.error
                    ? String(value.error)
                    : "Model request failed.",
              );
            }

            break;
          }

          switch (value.type) {
            case "turn_start":
              accumulatedText = "";
              setStreamingText("");
              setSpinnerLabel("Thinking");
              break;

            case "text":
              accumulatedText += value.text;
              setStreamingText(accumulatedText);
              break;

            case "tool_use_start":
              setToolCalls((prev) => [
                ...prev,
                { id: value.id, name: value.name },
              ]);
              setSpinnerLabel(`Running ${value.name}`);
              break;

            case "tool_use_done":
              setToolCalls((prev) =>
                prev.map((toolCall) =>
                  toolCall.id === value.id
                    ? {
                        ...toolCall,
                        resultLength: value.resultLength,
                        isError: value.isError,
                      }
                    : toolCall,
                ),
              );
              break;

            case "assistant_message":
            case "tool_result_message":
              nextMessages = [...nextMessages, value.message];
              setMessages(nextMessages);
              messagesRef.current = nextMessages;
              setStreamingText("");
              break;

            case "error":
              if (!abort.signal.aborted) {
                setErrorText(value.message);
              }
              break;
          }
        }
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
    [exit, model, system, toolsApiParams],
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
