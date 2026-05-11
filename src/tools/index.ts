import type { Tool as AnthropicTool } from "@anthropic-ai/sdk/resources/messages/messages";
import { bashTool } from "./bashTool.js";
import { fileEditTool } from "./fileEditTool.js";
import { fileReadTool } from "./fileReadTool.js";
import { fileWriteTool } from "./fileWriteTool.js";
import { globTool } from "./globTool.js";
import { grepTool } from "./grepTool.js";
import type { Tool } from "./Tool.js";

const ALL_TOOLS: Tool[] = [
  fileReadTool,
  fileWriteTool,
  fileEditTool,
  grepTool,
  globTool,
  bashTool,
];

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

export {
  bashTool,
  fileEditTool,
  fileReadTool,
  fileWriteTool,
  globTool,
  grepTool,
};
export { isReadOnlyShellCommand } from "./bashTool.js";
export type { JSONSchema, Tool, ToolContext, ToolResult } from "./Tool.js";
