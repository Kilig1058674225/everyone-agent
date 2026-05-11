import { readFile, writeFile } from "node:fs/promises";
import type { Tool, ToolContext, ToolResult } from "./Tool.js";
import {
  addLineNumbers,
  normalizeQuotes,
  resolveWorkspacePath,
} from "./utils.js";

interface FileEditInput {
  file_path: string;
  old_string: string;
  new_string: string;
}

function parseInput(input: Record<string, unknown>): FileEditInput {
  const filePath = input.file_path;
  const oldString = input.old_string;
  const newString = input.new_string;

  if (typeof filePath !== "string" || !filePath.trim()) {
    throw new Error('Missing required string parameter "file_path".');
  }

  if (typeof oldString !== "string" || oldString.length === 0) {
    throw new Error('Missing required string parameter "old_string".');
  }

  if (typeof newString !== "string") {
    throw new Error('Missing required string parameter "new_string".');
  }

  return {
    file_path: filePath,
    old_string: normalizeQuotes(oldString),
    new_string: normalizeQuotes(newString),
  };
}

function countOccurrences(content: string, needle: string): number {
  let count = 0;
  let index = content.indexOf(needle);

  while (index !== -1) {
    count += 1;
    index = content.indexOf(needle, index + needle.length);
  }

  return count;
}

function getPreview(content: string, changedIndex: number): string {
  const before = content.slice(0, changedIndex);
  const startLine = before.split(/\r?\n/).length;
  const lines = content.split(/\r?\n/).slice(
    Math.max(0, startLine - 3),
    startLine + 5,
  );
  const previewStart = Math.max(1, startLine - 2);

  return addLineNumbers(lines.join("\n"), previewStart);
}

export const fileEditTool: Tool = {
  name: "Edit",
  description:
    "Replace one exact, unique text occurrence in a UTF-8 file inside the current workspace.",
  inputSchema: {
    type: "object",
    properties: {
      file_path: {
        type: "string",
        description: "File to edit, relative to the current workspace.",
      },
      old_string: {
        type: "string",
        description: "Exact text to replace. Must appear exactly once.",
      },
      new_string: {
        type: "string",
        description: "Replacement text.",
      },
    },
    required: ["file_path", "old_string", "new_string"],
  },

  async call(
    rawInput: Record<string, unknown>,
    context: ToolContext,
  ): Promise<ToolResult> {
    try {
      if (context.abortSignal?.aborted) {
        return { content: "Error: Edit was interrupted.", isError: true };
      }

      const input = parseInput(rawInput);
      const resolved = resolveWorkspacePath(input.file_path, context.cwd);
      const original = await readFile(resolved, {
        encoding: "utf-8",
        signal: context.abortSignal,
      });
      const matches = countOccurrences(original, input.old_string);

      if (matches === 0) {
        return {
          content: `Error: old_string was not found in ${input.file_path}.`,
          isError: true,
        };
      }

      if (matches > 1) {
        return {
          content: `Error: old_string appears ${matches} times in ${input.file_path}. Provide a larger unique context.`,
          isError: true,
        };
      }

      const changedIndex = original.indexOf(input.old_string);
      const updated = original.replace(input.old_string, input.new_string);

      await writeFile(resolved, updated, {
        encoding: "utf-8",
        signal: context.abortSignal,
      });

      return {
        content: `Updated file: ${resolved}\nPreview:\n${getPreview(updated, changedIndex)}`,
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
