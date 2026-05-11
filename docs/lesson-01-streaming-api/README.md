# Lesson 01: 打通 LLM 流式通信

这一节的目标是让程序真正能和模型通信，并且不是等一整段回复回来后再显示，而是一边接收一边处理。

也就是从：

```txt
发送请求 -> 等很久 -> 一次性得到完整回复
```

变成：

```txt
发送请求 -> 收到一点 -> 处理一点 -> 再收到一点 -> 再处理一点
```

这就是流式通信。

## 当前已实现的文件

本节对应这些文件：

- `src/types/message.ts`
- `src/types/stream.ts`
- `src/types/index.ts`
- `src/services/api/client.ts`
- `src/services/api/streaming.ts`
- `src/services/api/index.ts`
- `src/entrypoint/stream-demo.ts`
- `.env.example`

你可以按照本教程顺序读代码。

## 1. 为什么必须流式

如果不用流式，程序流程是：

```txt
用户输入问题
  -> 发请求
    -> 终端等待几秒甚至几十秒
      -> 一次性打印完整回复
```

这种体验在 CLI 里很差。

因为终端如果长时间没有输出，用户会以为程序卡死了。

流式方式是：

```txt
用户输入问题
  -> 发请求
    -> 模型生成一点
      -> 我们收到一点
        -> 终端显示一点
```

所以用户能马上看到程序在工作。

更重要的是，后续做工具调用时，流式事件里可能会出现：

```json
{
  "type": "tool_use",
  "name": "Read",
  "input": {
    "path": "src/index.ts"
  }
}
```

这意味着模型不是只返回文字，它还可能要求程序调用工具。

所以第一节不仅要解决“文字逐字显示”，还要提前把消息结构设计成能支持工具调用。

## 2. 消息类型 message.ts

对应文件：`src/types/message.ts`

核心代码：

```ts
export interface TextBlock {
  type: "text";
  text: string;
}

export interface ToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface ToolResultBlock {
  type: "tool_result";
  tool_use_id: string;
  content: string | ContentBlock[];
  is_error?: boolean;
}

export type ContentBlock = TextBlock | ToolUseBlock | ToolResultBlock;
```

这里先理解一个关键词：联合类型。

```ts
export type ContentBlock = TextBlock | ToolUseBlock | ToolResultBlock;
```

意思是：

```txt
ContentBlock 可以是 TextBlock
也可以是 ToolUseBlock
也可以是 ToolResultBlock
```

为什么要这样设计？

因为 assistant 的一条回复不一定只有文字。

它可能是：

```ts
[
  { type: "text", text: "我先读取文件。" },
  { type: "tool_use", id: "toolu_1", name: "Read", input: { path: "src/index.ts" } }
]
```

这就是教程里说的 Content Block 数组。

## 3. UserMessage 和 AssistantMessage

还是在 `src/types/message.ts`。

```ts
export interface UserMessage {
  role: "user";
  content: string | ContentBlock[];
}

export interface AssistantMessage {
  role: "assistant";
  content: string | ContentBlock[];
}

export type Message = UserMessage | AssistantMessage;
```

这里的 `role` 是固定字符串。

```ts
role: "user";
```

表示这个字段只能是 `"user"`，不能是别的字符串。

普通用户输入时，用字符串就够了：

```ts
{ role: "user", content: "你好" }
```

但工具结果需要 content block：

```ts
{
  role: "user",
  content: [
    {
      type: "tool_result",
      tool_use_id: "toolu_1",
      content: "文件内容..."
    }
  ]
}
```

所以 `content` 必须写成：

```ts
string | ContentBlock[]
```

不能只写：

```ts
string
```

## 4. 流事件类型 stream.ts

对应文件：`src/types/stream.ts`

模型流式返回时，会产生很多底层事件。

但上层 UI 不应该直接依赖 Anthropic SDK 的事件类型。

所以我们定义自己的事件：

```ts
export type StreamEvent =
  | StreamTextEvent
  | StreamToolUseStartEvent
  | StreamToolUseInputEvent
  | StreamMessageStartEvent
  | StreamMessageDoneEvent
  | StreamErrorEvent;
```

这也是联合类型。

意思是 `StreamEvent` 可能是这六种事件之一。

## 5. 为什么不直接用 SDK 的事件类型

这点很重要。

如果 UI 层直接写：

```ts
RawMessageStreamEvent
```

那 UI 就和 Anthropic SDK 绑死了。

以后如果你想接 OpenAI 兼容接口，就会很麻烦。

我们现在做了一层转换：

```txt
Anthropic SDK 原始事件
  -> streamMessage 转换
    -> 我们自己的 StreamEvent
      -> UI 消费 StreamEvent
```

这样未来接 OpenAI，只需要新增一个 adapter：

```txt
OpenAI SSE
  -> 转成 StreamEvent
```

UI 不用改。

这叫抽象层。

## 6. Usage 类型

`src/types/stream.ts` 里还有：

```ts
export interface Usage {
  input_tokens: number;
  output_tokens: number;
}
```

它记录 token 用量。

当前我们只是打印：

```txt
tokens: 12 in / 30 out
```

后续会用它做：

- token 预算管理
- 上下文压缩
- 成本估算

## 7. StreamRequestParams

```ts
export interface StreamRequestParams {
  messages: Message[];
  system?: string;
  model?: string;
  maxTokens?: number;
  signal?: AbortSignal;
}
```

这个类型表示调用 `streamMessage()` 时可以传什么参数。

字段解释：

- `messages`：上下文消息，必填
- `system`：系统提示词，可选
- `model`：模型名，可选
- `maxTokens`：最大输出 token，可选
- `signal`：中断请求用，可选

注意 `?` 的意思是可选。

例如：

```ts
system?: string;
```

表示可以传，也可以不传。

## 8. API Client client.ts

对应文件：`src/services/api/client.ts`

这一层专门负责创建 Anthropic SDK 客户端。

核心代码：

```ts
let clientInstance: Anthropic | null = null;

export function getAnthropicClient(options?: {
  apiKey?: string;
  baseURL?: string;
  headers?: Record<string, string>;
}): Anthropic {
  if (clientInstance && !options) {
    return clientInstance;
  }

  const client = new Anthropic({
    apiKey: options?.apiKey ?? process.env.ANTHROPIC_AUTH_TOKEN,
    baseURL: normalizeAnthropicBaseURL(
      options?.baseURL ?? process.env.ANTHROPIC_BASE_URL,
    ),
    defaultHeaders: {
      "User-Agent": DEFAULT_USER_AGENT,
      ...options?.headers,
    },
  });

  if (!options) {
    clientInstance = client;
  }

  return client;
}
```

## 9. 什么是单例

这里的：

```ts
let clientInstance: Anthropic | null = null;
```

就是缓存一个 client。

第一次调用：

```ts
getAnthropicClient()
```

会创建新 client。

第二次调用：

```ts
getAnthropicClient()
```

会复用之前的 client。

这叫单例。

为什么要这样？

因为 client 没必要每次请求都重新创建。

但如果传了 options：

```ts
getAnthropicClient({ apiKey: "..." })
```

就会创建新的 client，不走缓存。

这给以后验证 API key、临时切换 baseURL 留了空间。

## 10. 环境变量和 dotenv

`.env.example` 里记录了：

```env
ANTHROPIC_AUTH_TOKEN=
ANTHROPIC_BASE_URL=https://api.anthropic.com
ANTHROPIC_MODEL=claude-sonnet-4-20250514
MODEL_MAX_TOKENS=128000
ANTHROPIC_USER_AGENT=Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36
```

Node.js 默认不会自动读取 `.env`。

所以入口文件里要有：

```ts
import "dotenv/config";
```

当前这些文件里有：

- `src/entrypoint/cli.ts`
- `src/entrypoint/stream-demo.ts`

这表示程序启动时会先读取 `.env`，然后 `process.env.xxx` 才能拿到值。

## 11. 为什么 max tokens 要转成 number

在 `.env` 里写：

```env
MODEL_MAX_TOKENS=128000
```

读到 Node 里时，它不是数字，而是字符串：

```ts
"128000"
```

所以不能直接写：

```ts
export const DEFAULT_MAX_TOKENS = process.env.MODEL_MAX_TOKENS || 128000;
```

因为这会得到：

```ts
string | number
```

而 SDK 要求：

```ts
max_tokens: number
```

所以我们写了：

```ts
function readNumberEnv(name: string, fallback: number): number {
  const value = process.env[name];

  if (!value) {
    return fallback;
  }

  const parsed = Number(value);

  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }

  return parsed;
}

export const DEFAULT_MAX_TOKENS = readNumberEnv("MODEL_MAX_TOKENS", 128000);
```

这样 `.env` 字符串会被转成真正的数字。

## 12. baseURL 的坑

你实际测试时遇到了 404。

原因是 Anthropic SDK 自己会请求：

```txt
POST /v1/messages
```

所以如果 `.env` 写：

```env
ANTHROPIC_BASE_URL=https://cli.74100369.xyz/v1
```

最终可能会变成：

```txt
https://cli.74100369.xyz/v1/v1/messages
```

路径重复了，于是 404。

正确写法是服务根地址：

```env
ANTHROPIC_BASE_URL=https://cli.74100369.xyz
```

为了减少出错，我们加了：

```ts
export function normalizeAnthropicBaseURL(
  baseURL: string | undefined,
): string | undefined {
  if (!baseURL) {
    return undefined;
  }

  const trimmed = baseURL.trim().replace(/\/+$/, "");

  if (trimmed.endsWith("/v1/messages")) {
    return trimmed.slice(0, -"/v1/messages".length);
  }

  if (trimmed.endsWith("/v1")) {
    return trimmed.slice(0, -"/v1".length);
  }

  return trimmed;
}
```

它会把这些写法：

```txt
https://cli.74100369.xyz/v1
https://cli.74100369.xyz/v1/messages
```

都归一化成：

```txt
https://cli.74100369.xyz
```

## 13. User-Agent 的坑

你实际测试时还遇到了：

```txt
403 Your request was blocked.
```

这是服务入口被 Cloudflare 拦了。

我们在 client 里加了：

```ts
defaultHeaders: {
  "User-Agent": DEFAULT_USER_AGENT,
  ...options?.headers,
}
```

默认值来自：

```ts
export const DEFAULT_USER_AGENT =
  process.env.ANTHROPIC_USER_AGENT ||
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
```

这样所有 API 请求都会带上浏览器风格的 User-Agent。

## 14. streamMessage 的整体职责

对应文件：`src/services/api/streaming.ts`

这是第一节最核心的文件。

函数签名：

```ts
export async function* streamMessage(
  params: StreamRequestParams,
): AsyncGenerator<StreamEvent, StreamResult> {
  // ...
}
```

先看三个关键词。

### 14.1 async

表示函数里可以使用：

```ts
await
```

因为请求模型是异步的。

### 14.2 function*

带 `*` 的函数是 Generator。

Generator 可以多次返回值。

普通函数：

```ts
return value;
```

只能返回一次。

Generator：

```ts
yield value1;
yield value2;
yield value3;
```

可以产出很多次。

### 14.3 AsyncGenerator

`async function*` 结合起来，就是异步生成器。

它适合处理：

```txt
一边等待网络数据
一边不断产出事件
```

这正好就是流式 API。

## 15. streamMessage 初始化

代码：

```ts
const client = getAnthropicClient();

const contentBlocks: ContentBlock[] = [];
const toolInputJsonByIndex = new Map<number, string>();
const toolUseIdByIndex = new Map<number, string>();
const usage: Usage = { input_tokens: 0, output_tokens: 0 };
let stopReason = "";
```

这些变量各自负责：

- `client`：API 客户端
- `contentBlocks`：最终 assistant 消息内容
- `toolInputJsonByIndex`：临时保存工具参数 JSON 碎片
- `toolUseIdByIndex`：记录某个 content block 对应的 tool id
- `usage`：token 用量
- `stopReason`：模型为什么停止

## 16. 发起 SDK 流式请求

```ts
const stream = client.messages.stream(
  {
    model: params.model ?? DEFAULT_MODEL,
    max_tokens: params.maxTokens ?? DEFAULT_MAX_TOKENS,
    messages: params.messages as MessageParam[],
    stream: true,
    ...(params.system ? { system: params.system } : {}),
  },
  { signal: params.signal },
);
```

这里几个点很重要。

### 16.1 默认值

```ts
params.model ?? DEFAULT_MODEL
```

如果调用方传了 model，就用调用方的。

如果没传，就用默认 model。

`??` 是空值合并运算符。

只有左边是 `null` 或 `undefined` 时，才会用右边。

### 16.2 system 可选

```ts
...(params.system ? { system: params.system } : {})
```

如果有 system，就把它展开进请求对象。

如果没有，就展开空对象。

这样请求里不会出现：

```ts
system: undefined
```

### 16.3 signal 中断

```ts
{ signal: params.signal }
```

这让第二节的 Ctrl+C 可以取消请求。

## 17. for await 读取流

```ts
for await (const event of stream) {
  switch (event.type) {
    // ...
  }
}
```

普通 `for` 是遍历同步数组：

```ts
for (const item of items) {}
```

`for await` 是遍历异步数据流。

模型不是一次性返回所有事件，而是慢慢推送。

所以要用：

```ts
for await
```

## 18. message_start

```ts
case "message_start":
  usage.input_tokens = event.message.usage.input_tokens;
  yield { type: "message_start", messageId: event.message.id };
  break;
```

这表示一条 assistant 消息开始了。

我们做两件事：

1. 记录输入 token 数
2. 向上层产出自己的 `message_start` 事件

`yield` 的意思是把事件交给消费端。

消费端可以马上处理，而不是等整个函数结束。

## 19. content_block_start

```ts
case "content_block_start":
  if (event.content_block.type === "text") {
    contentBlocks[event.index] = { type: "text", text: "" };
  } else if (event.content_block.type === "tool_use") {
    // ...
  }
  break;
```

一个 assistant 消息里可以有多个 content block。

`event.index` 表示当前是第几个 block。

如果是文字：

```ts
contentBlocks[event.index] = { type: "text", text: "" };
```

先占位，后续收到文本 delta 时再追加。

如果是工具调用：

```ts
const block: ToolUseBlock = {
  type: "tool_use",
  id: event.content_block.id,
  name: event.content_block.name,
  input: {},
};
```

先创建工具调用块。

然后产出事件：

```ts
yield {
  type: "tool_use_start",
  id: block.id,
  name: block.name,
  index: event.index,
};
```

UI 层可以用它显示：

```txt
Using tool: Read
```

## 20. content_block_delta: text_delta

```ts
if (event.delta.type === "text_delta") {
  const block = contentBlocks[event.index];

  if (block?.type === "text") {
    block.text += event.delta.text;
  } else {
    contentBlocks[event.index] = {
      type: "text",
      text: event.delta.text,
    };
  }

  yield { type: "text", text: event.delta.text };
}
```

这是打字机效果的来源。

例如模型可能分三次返回：

```txt
你
好
！
```

每收到一次，我们就：

1. 累积到最终消息 `contentBlocks`
2. `yield` 一个 `text` 事件给 UI

UI 收到后就能立刻显示。

## 21. content_block_delta: input_json_delta

```ts
else if (event.delta.type === "input_json_delta") {
  const previous = toolInputJsonByIndex.get(event.index) ?? "";
  toolInputJsonByIndex.set(
    event.index,
    previous + event.delta.partial_json,
  );

  yield {
    type: "tool_use_input",
    id: toolUseIdByIndex.get(event.index),
    index: event.index,
    partialJson: event.delta.partial_json,
  };
}
```

工具参数 JSON 是碎片化到达的。

比如完整 JSON 是：

```json
{"path":"src/index.ts"}
```

流式时可能分成：

```txt
{"path":"src/
index.ts"}
```

所以不能每收到一点就 `JSON.parse()`。

必须先拼起来：

```ts
previous + event.delta.partial_json
```

等 block 结束再解析。

## 22. content_block_stop

```ts
case "content_block_stop": {
  const block = contentBlocks[event.index];
  const inputJson = toolInputJsonByIndex.get(event.index);

  if (block?.type === "tool_use" && inputJson) {
    block.input = parseToolInput(inputJson);
  }

  toolInputJsonByIndex.delete(event.index);
  toolUseIdByIndex.delete(event.index);
  break;
}
```

这里表示一个 content block 结束了。

如果这个 block 是工具调用，并且收集到了 JSON 字符串，就解析：

```ts
block.input = parseToolInput(inputJson);
```

然后清理临时 Map。

## 23. parseToolInput

```ts
function parseToolInput(json: string): Record<string, unknown> {
  const value = JSON.parse(json) as unknown;

  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }

  return { value };
}
```

工具参数通常应该是对象：

```json
{"path":"src/index.ts"}
```

但为了更稳，如果解析出来不是对象，比如：

```json
"hello"
```

我们包装成：

```ts
{ value: "hello" }
```

这样 `ToolUseBlock.input` 永远是：

```ts
Record<string, unknown>
```

## 24. message_delta

```ts
case "message_delta":
  usage.output_tokens = event.usage.output_tokens;
  stopReason = event.delta.stop_reason ?? "";
  break;
```

这里拿到两个重要信息：

- 输出 token 数
- 停止原因

停止原因可能是：

- `end_turn`：正常结束
- `max_tokens`：达到 token 上限
- `tool_use`：模型请求调用工具
- `stop_sequence`：遇到停止序列

下一节工具系统会特别关注：

```txt
tool_use
```

## 25. message_stop

```ts
case "message_stop":
  yield { type: "message_done", stopReason, usage };
  break;
```

这表示流结束了。

我们向 UI 产出：

```ts
{
  type: "message_done",
  stopReason,
  usage
}
```

UI 可以用它显示 token 用量。

## 26. 函数最终 return

```ts
return {
  assistantMessage: { role: "assistant", content: contentBlocks },
  usage,
  stopReason,
};
```

这里和 `yield` 不一样。

`yield` 是过程中产出的事件。

`return` 是整个 Generator 结束后的最终结果。

消费端可以这样拿：

```ts
const { value, done } = await generator.next();

if (done) {
  // value 就是 StreamResult
}
```

第二节的 `App.tsx` 就是这么消费的。

## 27. 错误处理

```ts
catch (error) {
  yield { type: "error", message: toErrorMessage(error), error };

  return {
    assistantMessage: { role: "assistant", content: contentBlocks },
    usage,
    stopReason: "error",
  };
}
```

如果请求失败，比如：

- key 错误
- 网络错误
- 403
- 404

我们先 `yield` 一个错误事件。

这样 UI 可以显示错误。

然后 return 一个结果，避免整个进程直接爆出很长的 stack trace。

## 28. 验证脚本 stream-demo.ts

对应文件：`src/entrypoint/stream-demo.ts`

它是第一节的最小验证程序。

核心：

```ts
const gen = streamMessage({
  messages: [{ role: "user", content: prompt }],
  system: "You are a helpful assistant. Reply in Chinese.",
});
```

然后手动消费 Generator：

```ts
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
      break;
  }
}
```

这里还没有 Ink。

所以它直接用：

```ts
process.stdout.write(value.text);
```

这正好说明第一节和第二节的关系：

```txt
第一节：证明 streamMessage 能产出事件
第二节：用 Ink 消费这些事件并渲染 UI
```

## 29. 如何运行第一节 demo

先准备 `.env`。

可以参考 `.env.example`。

然后运行：

```bash
npx tsx src/entrypoint/stream-demo.ts
```

也可以传入自己的问题：

```bash
npx tsx src/entrypoint/stream-demo.ts "用一句话解释什么是 Agentic Loop"
```

如果正常，会看到回复逐段打印出来。

## 30. 第一节完成后的架构

第一节结束时，调用链是：

```txt
stream-demo.ts
  -> streamMessage()
    -> getAnthropicClient()
      -> Anthropic SDK
        -> SSE / stream events
```

返回时：

```txt
SDK Raw Event
  -> streamMessage switch
    -> StreamEvent
      -> stream-demo.ts 打印
```

这就是后续 UI、工具系统、Agentic Loop 的基础。

## 31. 你需要掌握的最小知识

如果基础还薄，先掌握这些：

1. `interface`：定义对象形状
2. `type A = B | C`：联合类型
3. `?`：可选字段
4. `process.env`：读取环境变量
5. `.env`：本地配置文件
6. `Number(...)`：把字符串转数字
7. `async function*`：异步生成器
8. `yield`：产出中间事件
9. `return`：返回最终结果
10. `for await`：读取异步流
11. `switch(event.type)`：根据事件类型分别处理
12. `AbortSignal`：给下一节 Ctrl+C 中断用

第一节最核心的一句话是：

```txt
把模型原始流事件，转换成项目自己的 StreamEvent。
```

这样上层代码不用关心 SDK 细节。

