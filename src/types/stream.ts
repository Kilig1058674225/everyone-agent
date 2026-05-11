import type { AssistantMessage, Message } from "./message.js";
import type { Tool as AnthropicTool } from "@anthropic-ai/sdk/resources/messages/messages";

export interface Usage {
  input_tokens: number;
  output_tokens: number;
}

export interface StreamRequestParams {
  messages: Message[];
  system?: string;
  model?: string;
  maxTokens?: number;
  signal?: AbortSignal;
  tools?: AnthropicTool[];
}

export interface StreamResult {
  assistantMessage: AssistantMessage;
  usage: Usage;
  stopReason: string;
}

export type StreamEvent =
  | StreamTextEvent
  | StreamToolUseStartEvent
  | StreamToolUseInputEvent
  | StreamMessageStartEvent
  | StreamMessageDoneEvent
  | StreamErrorEvent;

export interface StreamTextEvent {
  type: "text";
  text: string;
}

export interface StreamToolUseStartEvent {
  type: "tool_use_start";
  id: string;
  name: string;
  index: number;
}

export interface StreamToolUseInputEvent {
  type: "tool_use_input";
  id?: string;
  index: number;
  partialJson: string;
}

export interface StreamMessageStartEvent {
  type: "message_start";
  messageId: string;
}

export interface StreamMessageDoneEvent {
  type: "message_done";
  stopReason: string;
  usage: Usage;
}

export interface StreamErrorEvent {
  type: "error";
  message: string;
  error?: unknown;
}
