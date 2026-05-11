import type { Tool, ToolContext, ToolResult } from "./Tool.js";
import { runCommand } from "./utils.js";

interface BashInput {
  command: string;
  timeout_ms: number;
}

const READ_ONLY_COMMANDS = new Set([
  "cat",
  "dir",
  "echo",
  "find",
  "grep",
  "head",
  "ls",
  "pwd",
  "rg",
  "tail",
  "type",
  "where",
  "which",
  "Get-ChildItem",
  "Get-Content",
  "Select-String",
]);

const READ_ONLY_GIT_SUBCOMMANDS = new Set([
  "branch",
  "diff",
  "log",
  "show",
  "status",
]);

function parseInput(input: Record<string, unknown>): BashInput {
  const command = input.command;
  const timeout = input.timeout_ms;

  if (typeof command !== "string" || !command.trim()) {
    throw new Error('Missing required string parameter "command".');
  }

  if (
    timeout !== undefined &&
    (typeof timeout !== "number" || !Number.isInteger(timeout) || timeout < 1)
  ) {
    throw new Error('"timeout_ms" must be a positive integer when provided.');
  }

  return { command, timeout_ms: timeout ?? 120_000 };
}

function splitCommandSegments(command: string): string[] {
  return command
    .split(/&&|\|\||[|;]/)
    .map((segment) => segment.trim())
    .filter(Boolean);
}

function getCommandWords(segment: string): string[] {
  const matches = segment.match(/"[^"]*"|'[^']*'|\S+/g) ?? [];
  return matches.map((word) => word.replace(/^['"]|['"]$/g, ""));
}

function isReadOnlySegment(segment: string): boolean {
  if (/[<>]/.test(segment)) {
    return false;
  }

  const words = getCommandWords(segment);
  const command = words[0];

  if (!command) {
    return true;
  }

  if (command === "git") {
    return READ_ONLY_GIT_SUBCOMMANDS.has(words[1] ?? "");
  }

  if (command === "npm" || command === "pnpm" || command === "yarn") {
    return words[1] === "--version" || words[1] === "-v";
  }

  return READ_ONLY_COMMANDS.has(command);
}

export function isReadOnlyShellCommand(command: string): boolean {
  return splitCommandSegments(command).every(isReadOnlySegment);
}

export const bashTool: Tool = {
  name: "Bash",
  description:
    "Run a shell command in the current workspace. Use for builds, tests, and commands that other tools cannot express. Output is truncated.",
  inputSchema: {
    type: "object",
    properties: {
      command: {
        type: "string",
        description: "Shell command to run.",
      },
      timeout_ms: {
        type: "number",
        description: "Timeout in milliseconds. Defaults to 120000.",
      },
    },
    required: ["command"],
  },

  async call(
    rawInput: Record<string, unknown>,
    context: ToolContext,
  ): Promise<ToolResult> {
    try {
      const input = parseInput(rawInput);
      const isWindows = process.platform === "win32";
      const shell = isWindows ? "powershell.exe" : "sh";
      const args = isWindows
        ? ["-NoLogo", "-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", input.command]
        : ["-lc", input.command];
      const result = await runCommand(shell, args, {
        cwd: context.cwd,
        signal: context.abortSignal,
        timeoutMs: input.timeout_ms,
      });
      const parts = [
        `Command: ${input.command}`,
        `Exit code: ${result.exitCode ?? "none"}`,
      ];

      if (result.stdout) {
        parts.push(`stdout:\n${result.stdout}`);
      }

      if (result.stderr) {
        parts.push(`stderr:\n${result.stderr}`);
      }

      if (result.timedOut) {
        parts.push("Command timed out.");
      }

      return {
        content: parts.join("\n\n"),
        isError: result.exitCode !== 0 || result.timedOut,
      };
    } catch (error) {
      return {
        content: error instanceof Error ? `Error: ${error.message}` : String(error),
        isError: true,
      };
    }
  },

  isReadOnly(input?: Record<string, unknown>): boolean {
    if (!input || typeof input.command !== "string") {
      return false;
    }

    return isReadOnlyShellCommand(input.command);
  },

  isEnabled(): boolean {
    return true;
  },
};
