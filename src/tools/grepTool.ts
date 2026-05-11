import { readFile } from "node:fs/promises";
import path from "node:path";
import type { Tool, ToolContext, ToolResult } from "./Tool.js";
import {
  isNodeError,
  listFilesRecursive,
  resolveWorkspacePath,
  runCommand,
  truncateOutput,
} from "./utils.js";

interface GrepInput {
  pattern: string;
  path?: string;
  include?: string;
}

function parseInput(input: Record<string, unknown>): GrepInput {
  const pattern = input.pattern;
  const searchPath = input.path;
  const include = input.include;

  if (typeof pattern !== "string" || !pattern) {
    throw new Error('Missing required string parameter "pattern".');
  }

  if (searchPath !== undefined && typeof searchPath !== "string") {
    throw new Error('"path" must be a string when provided.');
  }

  if (include !== undefined && typeof include !== "string") {
    throw new Error('"include" must be a string when provided.');
  }

  return { pattern, path: searchPath, include };
}

function wildcardToRegExp(pattern: string): RegExp {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replaceAll("*", ".*")
    .replaceAll("?", ".");

  return new RegExp(`^${escaped}$`);
}

async function fallbackGrep(
  input: GrepInput,
  context: ToolContext,
): Promise<string> {
  const root = input.path
    ? resolveWorkspacePath(input.path, context.cwd)
    : context.cwd;
  const files = await listFilesRecursive(root, context.abortSignal);
  const includeRegex = input.include ? wildcardToRegExp(input.include) : null;
  let patternRegex: RegExp | null = null;

  try {
    patternRegex = new RegExp(input.pattern);
  } catch {
    patternRegex = null;
  }

  const matches: string[] = [];

  for (const file of files) {
    if (context.abortSignal?.aborted) {
      break;
    }

    const relative = path.relative(context.cwd, file).replaceAll("\\", "/");

    if (includeRegex && !includeRegex.test(relative)) {
      continue;
    }

    let raw = "";

    try {
      raw = await readFile(file, "utf-8");
    } catch {
      continue;
    }

    const lines = raw.split(/\r?\n/);

    lines.forEach((line, index) => {
      const column =
        patternRegex === null ? line.indexOf(input.pattern) : line.search(patternRegex);

      if (column !== -1) {
        matches.push(`${relative}:${index + 1}:${column + 1}:${line}`);
      }
    });
  }

  return matches.join("\n");
}

export const grepTool: Tool = {
  name: "Grep",
  description:
    "Search file contents in the workspace. Prefer this over Bash for content search.",
  inputSchema: {
    type: "object",
    properties: {
      pattern: {
        type: "string",
        description: "Search pattern. Interpreted by ripgrep when available.",
      },
      path: {
        type: "string",
        description: "Optional file or directory path to search within.",
      },
      include: {
        type: "string",
        description: 'Optional glob filter, for example "*.ts" or "src/**/*.tsx".',
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
      const searchPath = input.path
        ? resolveWorkspacePath(input.path, context.cwd)
        : context.cwd;
      const args = [
        "--line-number",
        "--column",
        "--no-heading",
        "--color",
        "never",
        "--hidden",
        "-g",
        "!.git",
        "-g",
        "!node_modules",
        "-g",
        "!dist",
      ];

      if (input.include) {
        args.push("-g", input.include);
      }

      args.push("--", input.pattern, searchPath);

      try {
        const result = await runCommand("rg", args, {
          cwd: context.cwd,
          signal: context.abortSignal,
        });

        if (result.exitCode === 0) {
          return { content: truncateOutput(result.stdout) };
        }

        if (result.exitCode === 1) {
          return { content: "No matches found." };
        }

        return {
          content: `Error: rg failed with exit code ${result.exitCode}\n${result.stderr}`,
          isError: true,
        };
      } catch (error) {
        if (!isNodeError(error) || error.code !== "ENOENT") {
          throw error;
        }
      }

      const fallback = await fallbackGrep(input, context);
      return { content: fallback ? truncateOutput(fallback) : "No matches found." };
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
