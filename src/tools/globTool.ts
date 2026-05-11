import path from "node:path";
import type { Tool, ToolContext, ToolResult } from "./Tool.js";
import {
  isNodeError,
  listFilesRecursive,
  resolveWorkspacePath,
  runCommand,
  truncateOutput,
} from "./utils.js";

interface GlobInput {
  pattern: string;
  path?: string;
  limit: number;
}

function parseInput(input: Record<string, unknown>): GlobInput {
  const pattern = input.pattern;
  const searchPath = input.path;
  const limit = input.limit;

  if (typeof pattern !== "string" || !pattern) {
    throw new Error('Missing required string parameter "pattern".');
  }

  if (searchPath !== undefined && typeof searchPath !== "string") {
    throw new Error('"path" must be a string when provided.');
  }

  if (
    limit !== undefined &&
    (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1)
  ) {
    throw new Error('"limit" must be a positive integer when provided.');
  }

  return { pattern, path: searchPath, limit: limit ?? 200 };
}

function wildcardToRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  const withGlobStars = escaped.replaceAll("**", "\u0000");
  const withStars = withGlobStars.replaceAll("*", "[^/]*");
  const withQuestions = withStars.replaceAll("?", ".");
  const regexSource = withQuestions.replaceAll("\u0000", ".*");

  return new RegExp(`^${regexSource}$`);
}

export const globTool: Tool = {
  name: "Glob",
  description:
    "Find files by glob pattern in the workspace. Prefer this over Bash for file discovery.",
  inputSchema: {
    type: "object",
    properties: {
      pattern: {
        type: "string",
        description: 'Glob pattern, for example "**/*.ts" or "src/tools/*.ts".',
      },
      path: {
        type: "string",
        description: "Optional directory to search within.",
      },
      limit: {
        type: "number",
        description: "Maximum number of file paths to return. Defaults to 200.",
      },
    },
    required: ["pattern"],
  },

  async call(
    rawInput: Record<string, unknown>,
    context: ToolContext,
  ): Promise<ToolResult> {
    try {
      const input = parseInput(rawInput);
      const root = input.path
        ? resolveWorkspacePath(input.path, context.cwd)
        : context.cwd;

      try {
        const result = await runCommand(
          "rg",
          [
            "--files",
            "--hidden",
            "-g",
            "!.git",
            "-g",
            "!node_modules",
            "-g",
            "!dist",
            "-g",
            input.pattern,
            root,
          ],
          {
            cwd: context.cwd,
            signal: context.abortSignal,
          },
        );

        if (result.exitCode === 0) {
          const lines = result.stdout
            .split(/\r?\n/)
            .filter(Boolean)
            .slice(0, input.limit);
          return { content: lines.length ? lines.join("\n") : "No files found." };
        }

        if (result.exitCode === 1) {
          return { content: "No files found." };
        }

        return {
          content: `Error: rg --files failed with exit code ${result.exitCode}\n${result.stderr}`,
          isError: true,
        };
      } catch (error) {
        if (!isNodeError(error) || error.code !== "ENOENT") {
          throw error;
        }
      }

      const regex = wildcardToRegExp(input.pattern.replaceAll("\\", "/"));
      const files = await listFilesRecursive(root, context.abortSignal);
      const matches = files
        .map((file) => path.relative(context.cwd, file).replaceAll("\\", "/"))
        .filter((file) => regex.test(file))
        .slice(0, input.limit);

      return {
        content: matches.length
          ? truncateOutput(matches.join("\n"))
          : "No files found.",
      };
    } catch (error) {
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
