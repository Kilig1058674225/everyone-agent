import type { Tool as AnthropicTool } from "@anthropic-ai/sdk/resources/messages/messages";
import { fileReadTool } from "./fileReadTool.js";
import type { Tool } from "./Tool.js";

const ALL_TOOLS: Tool[] = [fileReadTool];

export function getAllTools(): Tool[] {
  return ALL_TOOLS.filter((tool) => tool.isEnabled());
}

export function findToolByName(name: string): Tool | undefined {
  return getAllTools().find((tool) => tool.name === name);
}

export function toolToApiParam(tool: Tool): AnthropicTool {
  return {
    name: tool.name,
    description: tool.description,
    input_schema: tool.inputSchema,
  };
}

export function getToolsApiParams(): AnthropicTool[] {
  return getAllTools().map(toolToApiParam);
}

export { fileReadTool };
export type { JSONSchema, Tool, ToolContext, ToolResult } from "./Tool.js";
