import type {
  MessageParam,
  Tool as AnthropicTool,
} from "@anthropic-ai/sdk/resources/messages/messages";
import type {
  ContentBlock,
  StreamEvent,
  StreamRequestParams,
  StreamResult,
  TextBlock,
  ToolUseBlock,
  Usage,
} from "../../types/index.js";
import {
  DEFAULT_MAX_TOKENS,
  DEFAULT_MODEL,
  getAnthropicClient,
} from "./client.js";

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function parseToolInput(json: string): Record<string, unknown> {
  const value = JSON.parse(json) as unknown;

  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }

  return { value };
}

export async function* streamMessage(
  params: StreamRequestParams,
): AsyncGenerator<StreamEvent, StreamResult> {
  const client = getAnthropicClient();

  const contentBlocks: ContentBlock[] = [];
  const toolInputJsonByIndex = new Map<number, string>();
  const toolUseIdByIndex = new Map<number, string>();
  const usage: Usage = { input_tokens: 0, output_tokens: 0 };
  let stopReason = "";

  try {
    const stream = client.messages.stream(
      {
        model: params.model ?? DEFAULT_MODEL,
        max_tokens: params.maxTokens ?? DEFAULT_MAX_TOKENS,
        messages: params.messages as MessageParam[],
        stream: true,
        ...(params.system ? { system: params.system } : {}),
        ...(params.tools ? { tools: params.tools as AnthropicTool[] } : {}),
      },
      { signal: params.signal },
    );

    for await (const event of stream) {
      switch (event.type) {
        case "message_start":
          usage.input_tokens = event.message.usage.input_tokens;
          yield { type: "message_start", messageId: event.message.id };
          break;

        case "content_block_start":
          if (event.content_block.type === "text") {
            contentBlocks[event.index] = { type: "text", text: "" };
          } else if (event.content_block.type === "tool_use") {
            const block: ToolUseBlock = {
              type: "tool_use",
              id: event.content_block.id,
              name: event.content_block.name,
              input: {},
            };

            contentBlocks[event.index] = block;
            toolInputJsonByIndex.set(event.index, "");
            toolUseIdByIndex.set(event.index, block.id);

            yield {
              type: "tool_use_start",
              id: block.id,
              name: block.name,
              index: event.index,
            };
          }
          break;

        case "content_block_delta":
          if (event.delta.type === "text_delta") {
            const block = contentBlocks[event.index];

            if (block?.type === "text") {
              block.text += event.delta.text;
            } else {
              contentBlocks[event.index] = {
                type: "text",
                text: event.delta.text,
              };
            }

            yield { type: "text", text: event.delta.text };
          } else if (event.delta.type === "input_json_delta") {
            const previous = toolInputJsonByIndex.get(event.index) ?? "";
            toolInputJsonByIndex.set(
              event.index,
              previous + event.delta.partial_json,
            );

            yield {
              type: "tool_use_input",
              id: toolUseIdByIndex.get(event.index),
              index: event.index,
              partialJson: event.delta.partial_json,
            };
          }
          break;

        case "content_block_stop": {
          const block = contentBlocks[event.index];
          const inputJson = toolInputJsonByIndex.get(event.index);

          if (block?.type === "tool_use" && inputJson) {
            block.input = parseToolInput(inputJson);
          }

          toolInputJsonByIndex.delete(event.index);
          toolUseIdByIndex.delete(event.index);
          break;
        }

        case "message_delta":
          usage.output_tokens = event.usage.output_tokens;
          stopReason = event.delta.stop_reason ?? "";
          break;

        case "message_stop":
          yield { type: "message_done", stopReason, usage };
          break;
      }
    }
  } catch (error) {
    yield { type: "error", message: toErrorMessage(error), error };

    return {
      assistantMessage: { role: "assistant", content: contentBlocks },
      usage,
      stopReason: "error",
    };
  }

  return {
    assistantMessage: { role: "assistant", content: contentBlocks },
    usage,
    stopReason,
  };
}
