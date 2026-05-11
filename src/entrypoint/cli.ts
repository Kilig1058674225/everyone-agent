#!/usr/bin/env node

import "dotenv/config";

const VERSION = "0.1.0";

function readArgValue(name: string): string | undefined {
  const index = process.argv.indexOf(name);

  if (index === -1) {
    return undefined;
  }

  return process.argv[index + 1];
}

async function main(): Promise<void> {
  if (process.argv.includes("--version") || process.argv.includes("-v")) {
    console.log(`easy-agent v${VERSION}`);
    process.exit(0);
  }

  if (process.argv.includes("--help") || process.argv.includes("-h")) {
    console.log(`easy-agent v${VERSION}

Usage:
  agent [--model <model>]

Commands:
  /clear    Clear conversation history
  /history  Show message count
  /exit     Exit the app

Keys:
  Ctrl+C    Interrupt the current request
  Ctrl+D    Exit the app`);
    process.exit(0);
  }

  const [{ createElement }, { render }, { App }, { DEFAULT_MODEL }] =
    await Promise.all([
      import("react"),
      import("ink"),
      import("../ui/index.js"),
      import("../services/api/index.js"),
    ]);

  const model = readArgValue("--model") ?? DEFAULT_MODEL;
  const system =
    "You are a helpful AI coding assistant. Be concise and direct.";

  const { waitUntilExit } = render(createElement(App, { model, system }));
  await waitUntilExit();
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Fatal: ${message}`);
  process.exit(1);
});
