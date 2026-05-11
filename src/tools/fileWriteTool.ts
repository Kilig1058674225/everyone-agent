import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Tool, ToolContext, ToolResult } from "./Tool.js";
import { pathExists, resolveWorkspacePath } from "./utils.js";

interface FileWriteInput {
  file_path: string;
  content: string;
}

function parseInput(input: Record<string, unknown>): FileWriteInput {
  const filePath = input.file_path;
  const content = input.content;

  if (typeof filePath !== "string" || !filePath.trim()) {
    throw new Error('Missing required string parameter "file_path".');
  }

  if (typeof content !== "string") {
    throw new Error('Missing required string parameter "content".');
  }

  return { file_path: filePath, content };
}

export const fileWriteTool: Tool = {
  name: "Write",
  description:
    "Create or overwrite a UTF-8 text file in the current workspace. Creates parent directories when needed.",
  inputSchema: {
    type: "object",
    properties: {
      file_path: {
        type: "string",
        description: "Path to write, relative to the current workspace.",
      },
      content: {
        type: "string",
        description: "Complete file content to write.",
      },
    },
    required: ["file_path", "content"],
  },

  async call(
    rawInput: Record<string, unknown>,
    context: ToolContext,
  ): Promise<ToolResult> {
    try {
      if (context.abortSignal?.aborted) {
        return { content: "Error: Write was interrupted.", isError: true };
      }

      const input = parseInput(rawInput);
      const resolved = resolveWorkspacePath(input.file_path, context.cwd);
      const existed = await pathExists(resolved);

      await mkdir(path.dirname(resolved), { recursive: true });
      await writeFile(resolved, input.content, {
        encoding: "utf-8",
        signal: context.abortSignal,
      });

      return {
        content: `${existed ? "Updated" : "Created"} file: ${resolved} (${input.content.length} chars)`,
      };
    } catch (error) {
      return {
        content: error instanceof Error ? `Error: ${error.message}` : String(error),
        isError: true,
      };
    }
  },

  isReadOnly(): boolean {
    return false;
  },

  isEnabled(): boolean {
    return true;
  },
};
