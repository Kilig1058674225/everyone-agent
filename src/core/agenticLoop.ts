import type { Tool as AnthropicTool } from "@anthropic-ai/sdk/resources/messages/messages";
import { streamMessage } from "../services/api/index.js";
import { findToolByName, type ToolContext } from "../tools/index.js";
import type {
  ContentBlock,
  Message,
  StreamEvent,
  ToolResultBlock,
  Usage,
} from "../types/index.js";

export const DEFAULT_MAX_TOOL_TURNS = 50;

export type LoopTerminationReason =
  | "completed"
  | "aborted"
  | "model_error"
  | "max_turns";

export interface LoopState {
  messages: Message[];
  turnCount: number;
  aborted: boolean;
}

export interface QueryParams {
  messages: Message[];
  model?: string;
  system?: string;
  tools?: AnthropicTool[];
  toolContext: ToolContext;
  maxTurns?: number;
  signal?: AbortSignal;
}

export interface QueryResult {
  state: LoopState;
  usage: Usage;
  terminationReason: LoopTerminationReason;
  stopReason: string;
  error?: unknown;
}

export interface ToolExecutionInfo {
  id: string;
  name: string;
  resultLength: number;
  isError?: boolean;
}

export interface RunToolsResult {
  message: Message;
  executions: ToolExecutionInfo[];
}

export type QueryEvent =
  | Extract<StreamEvent, { type: "text" | "tool_use_start" }>
  | QueryAssistantMessageEvent
  | QueryToolUseDoneEvent
  | QueryToolResultMessageEvent
  | QueryTurnStartEvent
  | QueryErrorEvent;

export interface QueryTurnStartEvent {
  type: "turn_start";
  turnCount: number;
}

export interface QueryAssistantMessageEvent {
  type: "assistant_message";
  message: Message;
  stopReason: string;
  usage: Usage;
}

export interface QueryToolUseDoneEvent {
  type: "tool_use_done";
  id: string;
  name: string;
  resultLength: number;
  isError?: boolean;
}

export interface QueryToolResultMessageEvent {
  type: "tool_result_message";
  message: Message;
}

export interface QueryErrorEvent {
  type: "error";
  message: string;
  error?: unknown;
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function getToolUseBlocks(
  contentBlocks: ContentBlock[],
): Array<Extract<ContentBlock, { type: "tool_use" }>> {
  return contentBlocks.filter(
    (block): block is Extract<ContentBlock, { type: "tool_use" }> => {
      return block.type === "tool_use";
    },
  );
}

export async function runTools(
  contentBlocks: ContentBlock[],
  toolContext: ToolContext,
): Promise<RunToolsResult> {
  const toolResults: ToolResultBlock[] = [];
  const executions: ToolExecutionInfo[] = [];

  for (const block of getToolUseBlocks(contentBlocks)) {
    if (toolContext.abortSignal?.aborted) {
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
      executions.push({
        id: block.id,
        name: block.name,
        resultLength: content.length,
        isError: true,
      });
      continue;
    }

    try {
      const result = await tool.call(block.input, toolContext);
      toolResults.push({
        type: "tool_result",
        tool_use_id: block.id,
        content: result.content,
        ...(result.isError ? { is_error: true } : {}),
      });
      executions.push({
        id: block.id,
        name: block.name,
        resultLength: result.content.length,
        isError: result.isError,
      });
    } catch (error) {
      const content = `Error: ${toErrorMessage(error)}`;
      toolResults.push({
        type: "tool_result",
        tool_use_id: block.id,
        content,
        is_error: true,
      });
      executions.push({
        id: block.id,
        name: block.name,
        resultLength: content.length,
        isError: true,
      });
    }
  }

  return {
    message: { role: "user", content: toolResults },
    executions,
  };
}

export async function* query(
  params: QueryParams,
): AsyncGenerator<QueryEvent, QueryResult> {
  const maxTurns = params.maxTurns ?? DEFAULT_MAX_TOOL_TURNS;
  let state: LoopState = {
    messages: [...params.messages],
    turnCount: 0,
    aborted: false,
  };
  const totalUsage: Usage = { input_tokens: 0, output_tokens: 0 };
  let stopReason = "";

  while (state.turnCount < maxTurns) {
    if (params.signal?.aborted) {
      state = { ...state, aborted: true };
      return {
        state,
        usage: totalUsage,
        terminationReason: "aborted",
        stopReason,
      };
    }

    state = { ...state, turnCount: state.turnCount + 1 };
    yield { type: "turn_start", turnCount: state.turnCount };

    let streamResult;
    let streamHadError = false;

    try {
      const stream = streamMessage({
        messages: state.messages,
        model: params.model,
        system: params.system,
        tools: params.tools,
        signal: params.signal,
      });

      while (true) {
        const { value, done } = await stream.next();

        if (done) {
          streamResult = value;
          break;
        }

        if (value.type === "text" || value.type === "tool_use_start") {
          yield value;
        } else if (value.type === "error") {
          streamHadError = true;
          yield value;
        }
      }
    } catch (error) {
      yield { type: "error", message: toErrorMessage(error), error };
      return {
        state,
        usage: totalUsage,
        terminationReason: params.signal?.aborted ? "aborted" : "model_error",
        stopReason,
        error,
      };
    }

    if (params.signal?.aborted) {
      state = { ...state, aborted: true };
      return {
        state,
        usage: totalUsage,
        terminationReason: "aborted",
        stopReason,
      };
    }

    if (!streamResult || streamHadError || streamResult.stopReason === "error") {
      return {
        state,
        usage: totalUsage,
        terminationReason: "model_error",
        stopReason: streamResult?.stopReason ?? stopReason,
        error:
          streamResult?.error ??
          (streamHadError ? "Model stream returned an error event." : undefined),
      };
    }

    totalUsage.input_tokens += streamResult.usage.input_tokens;
    totalUsage.output_tokens += streamResult.usage.output_tokens;
    stopReason = streamResult.stopReason;

    const assistantMessage: Message = streamResult.assistantMessage;
    state = {
      ...state,
      messages: [...state.messages, assistantMessage],
    };
    yield {
      type: "assistant_message",
      message: assistantMessage,
      stopReason,
      usage: streamResult.usage,
    };

    const contentBlocks = assistantMessage.content;

    if (stopReason !== "tool_use" || !Array.isArray(contentBlocks)) {
      return {
        state,
        usage: totalUsage,
        terminationReason: "completed",
        stopReason,
      };
    }

    const toolsResult = await runTools(contentBlocks, {
      ...params.toolContext,
      abortSignal: params.signal,
    });

    for (const execution of toolsResult.executions) {
      yield { type: "tool_use_done", ...execution };
    }

    if (params.signal?.aborted) {
      state = { ...state, aborted: true };
      return {
        state,
        usage: totalUsage,
        terminationReason: "aborted",
        stopReason,
      };
    }

    state = {
      ...state,
      messages: [...state.messages, toolsResult.message],
    };
    yield { type: "tool_result_message", message: toolsResult.message };
  }

  return {
    state,
    usage: totalUsage,
    terminationReason: "max_turns",
    stopReason,
  };
}
