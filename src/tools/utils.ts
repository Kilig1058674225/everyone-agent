import { spawn } from "node:child_process";
import { readdir, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export const DEFAULT_OUTPUT_LIMIT = 30_000;

export interface CommandResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export function expandHome(filePath: string): string {
  if (filePath === "~") {
    return os.homedir();
  }

  if (filePath.startsWith("~/") || filePath.startsWith("~\\")) {
    return path.join(os.homedir(), filePath.slice(2));
  }

  return filePath;
}

export function ensureInsideCwd(resolvedPath: string, cwd: string): void {
  const resolvedCwd = path.resolve(cwd);
  const relative = path.relative(resolvedCwd, resolvedPath);

  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Path is outside the workspace: ${resolvedPath}`);
  }
}

export function resolveWorkspacePath(filePath: string, cwd: string): string {
  const resolved = path.resolve(cwd, expandHome(filePath));
  ensureInsideCwd(resolved, cwd);
  return resolved;
}

export function addLineNumbers(content: string, startLine: number): string {
  const lines = content.split("\n");
  const padWidth = String(startLine + lines.length - 1).length;

  return lines
    .map((line, index) => {
      const lineNumber = String(startLine + index).padStart(padWidth, " ");
      return `${lineNumber}\t${line}`;
    })
    .join("\n");
}

export function truncateOutput(
  text: string,
  limit = DEFAULT_OUTPUT_LIMIT,
): string {
  if (text.length <= limit) {
    return text;
  }

  return `${text.slice(0, limit)}\n\n[Output truncated to ${limit} characters]`;
}

export function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

export function normalizeQuotes(value: string): string {
  return value
    .replaceAll("\u201c", '"')
    .replaceAll("\u201d", '"')
    .replaceAll("\u2018", "'")
    .replaceAll("\u2019", "'");
}

export async function pathExists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath);
    return true;
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return false;
    }

    throw error;
  }
}

export async function listFilesRecursive(
  root: string,
  signal?: AbortSignal,
): Promise<string[]> {
  const files: string[] = [];
  const ignored = new Set([".git", "node_modules", "dist"]);

  async function visit(current: string): Promise<void> {
    if (signal?.aborted) {
      return;
    }

    const entries = await readdir(current, { withFileTypes: true });

    for (const entry of entries) {
      if (signal?.aborted) {
        return;
      }

      if (ignored.has(entry.name)) {
        continue;
      }

      const fullPath = path.join(current, entry.name);

      if (entry.isDirectory()) {
        await visit(fullPath);
      } else if (entry.isFile()) {
        files.push(fullPath);
      }
    }
  }

  await visit(root);
  return files;
}

export function runCommand(
  command: string,
  args: string[],
  options: {
    cwd: string;
    signal?: AbortSignal;
    timeoutMs?: number;
    outputLimit?: number;
  },
): Promise<CommandResult> {
  const timeoutMs = options.timeoutMs ?? 120_000;
  const outputLimit = options.outputLimit ?? DEFAULT_OUTPUT_LIMIT;

  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timedOut = false;

    const child = spawn(command, args, {
      cwd: options.cwd,
      windowsHide: true,
      shell: false,
      env: process.env,
    });

    const finish = (result: CommandResult): void => {
      if (settled) {
        return;
      }

      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      resolve({
        ...result,
        stdout: truncateOutput(result.stdout, outputLimit),
        stderr: truncateOutput(result.stderr, outputLimit),
      });
    };

    const onAbort = (): void => {
      child.kill();
      finish({
        exitCode: null,
        stdout,
        stderr: `${stderr}\n[Process aborted]`.trim(),
        timedOut: false,
      });
    };

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);

    options.signal?.addEventListener("abort", onAbort, { once: true });

    child.stdout.setEncoding("utf-8");
    child.stderr.setEncoding("utf-8");

    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });

    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });

    child.on("error", (error) => {
      if (settled) {
        return;
      }

      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      reject(error);
    });

    child.on("close", (exitCode) => {
      finish({
        exitCode,
        stdout,
        stderr: timedOut
          ? `${stderr}\n[Process timed out after ${timeoutMs}ms]`.trim()
          : stderr,
        timedOut,
      });
    });
  });
}
