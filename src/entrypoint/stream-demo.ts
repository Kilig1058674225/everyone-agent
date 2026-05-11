#!/usr/bin/env node

import "dotenv/config";

import { streamMessage } from "../services/api/index.js";

async function main(): Promise<void> {
  const prompt = process.argv.slice(2).join(" ").trim() || "用一句话解释什么是 Agentic Loop";

  const gen = streamMessage({
    messages: [{ role: "user", content: prompt }],
    system: "You are a helpful assistant. Reply in Chinese.",
  });

  let result;
  let hasError = false;

  while (true) {
    const { value, done } = await gen.next();

    if (done) {
      result = value;
      break;
    }

    switch (value.type) {
      case "text":
        process.stdout.write(value.text);
        break;
      case "message_done":
        console.log(
          `\nTokens: ${value.usage.input_tokens} in / ${value.usage.output_tokens} out`,
        );
        break;
      case "error":
        console.error(value.message);
        hasError = true;
        break;
    }
  }

  if (result) {
    console.log(`Stop reason: ${result.stopReason}`);
  }

  if (hasError) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
