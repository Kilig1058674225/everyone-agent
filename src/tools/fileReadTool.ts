import { readdir, readFile } from "node:fs/promises";
import type { Tool, ToolContext, ToolResult } from "./Tool.js";
import {
  addLineNumbers,
  isNodeError,
  resolveWorkspacePath,
} from "./utils.js";

interface FileReadInput {
  file_path: string;
  offset: number;
  limit?: number;
}

function parseInput(input: Record<string, unknown>): FileReadInput {
  const filePath = input.file_path;
  const offset = input.offset;
  const limit = input.limit;

  if (typeof filePath !== "string" || !filePath.trim()) {
    throw new Error('Missing required string parameter "file_path".');
  }

  if (
    offset !== undefined &&
    (typeof offset !== "number" || !Number.isInteger(offset) || offset < 1)
  ) {
    throw new Error('"offset" must be a positive integer when provided.');
  }

  if (
    limit !== undefined &&
    (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1)
  ) {
    throw new Error('"limit" must be a positive integer when provided.');
  }

  return {
    file_path: filePath,
    offset: offset ?? 1,
    limit,
  };
}

export const fileReadTool: Tool = {
  name: "Read",
  description:
    "Read a UTF-8 text file from the current workspace. Use offset and limit for large files.",
  inputSchema: {
    type: "object",
    properties: {
      file_path: {
        type: "string",
        description: "Path to the file, relative to the current workspace.",
      },
      offset: {
        type: "number",
        description: "Starting line number, 1-indexed. Defaults to 1.",
      },
      limit: {
        type: "number",
        description: "Maximum number of lines to read.",
      },
    },
    required: ["file_path"],
  },

  async call(
    rawInput: Record<string, unknown>,
    context: ToolContext,
  ): Promise<ToolResult> {
    try {
      if (context.abortSignal?.aborted) {
        return { content: "Error: Read was interrupted.", isError: true };
      }

      const input = parseInput(rawInput);
      const resolved = resolveWorkspacePath(input.file_path, context.cwd);
      const raw = await readFile(resolved, {
        encoding: "utf-8",
        signal: context.abortSignal,
      });

      const allLines = raw.split(/\r?\n/);
      const startIndex = input.offset - 1;

      if (startIndex >= allLines.length) {
        return {
          content: `Error: Offset ${input.offset} is past the end of ${input.file_path} (${allLines.length} lines).`,
          isError: true,
        };
      }

      const endIndex =
        input.limit === undefined ? allLines.length : startIndex + input.limit;
      const selected = allLines.slice(startIndex, endIndex);
      const numbered = addLineNumbers(selected.join("\n"), input.offset);

      return {
        content: `${resolved} (${allLines.length} lines)\n${numbered}`,
      };
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") {
        return {
          content: `Error: File not found: ${String(rawInput.file_path)}`,
          isError: true,
        };
      }

      if (isNodeError(error) && error.code === "EISDIR") {
        const inputPath =
          typeof rawInput.file_path === "string" ? rawInput.file_path : "";
        const resolved = resolveWorkspacePath(inputPath, context.cwd);
        const entries = await readdir(resolved, { withFileTypes: true });
        const listing = entries
          .slice(0, 200)
          .map((entry) => `${entry.isDirectory() ? "dir " : "file"}\t${entry.name}`)
          .join("\n");

        return {
          content: `Path is a directory: ${resolved}\n${listing || "(empty)"}`,
          isError: true,
        };
      }

      return {
        content: error instanceof Error ? `Error: ${error.message}` : String(error),
        isError: true,
      };
    }
  },

  isReadOnly(): boolean {
    return true;
  },

  isEnabled(): boolean {
    return true;
  },
};
