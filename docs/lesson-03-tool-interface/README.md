# Lesson 03: 设计 Tool 接口，让 AI 拥有双手

这一节的目标是让模型从“只能聊天”，变成“能主动读取项目文件”。

前两节我们已经完成：

- 第一节：打通 LLM 流式通信
- 第二节：用 React / Ink 做终端 UI

但到第二节为止，模型还只能回答问题。

如果你问：

```txt
这个项目用了哪些依赖？
```

模型其实并不知道你的 `package.json` 里有什么。

除非你手动把文件内容复制给它。

第三节要解决这个问题：让模型可以说“我要读取 package.json”，然后我们的程序真的去读取文件，再把结果发回模型。

这就是工具调用。

## 当前已实现的文件

本节新增或修改了这些文件：

- `src/tools/Tool.ts`
- `src/tools/fileReadTool.ts`
- `src/tools/index.ts`
- `src/types/tool.ts`
- `src/types/index.ts`
- `src/types/stream.ts`
- `src/services/api/streaming.ts`
- `src/ui/App.tsx`
- `src/index.ts`

本节文档会按代码实现顺序讲。

## 1. 工具调用到底是什么

工具调用不是模型真的操作你的电脑。

模型不能自己读文件，也不能自己执行命令。

它只是返回一段结构化数据，告诉程序：

```txt
我想调用 Read 工具，参数是 package.json
```

真正执行读取动作的是我们的 TypeScript 代码。

完整流程是：

```txt
1. 程序告诉模型：你有一个 Read 工具
2. 模型返回：我要调用 Read，参数是 package.json
3. 程序执行 Read 工具
4. 程序把读取结果作为 tool_result 发回模型
5. 模型基于文件内容继续回答
```

一句话总结：

```txt
模型负责决策，代码负责执行。
```

## 2. Tool 接口

对应文件：`src/tools/Tool.ts`

核心代码：

```ts
export interface Tool {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: JSONSchema;

  call(input: Record<string, unknown>, context: ToolContext): Promise<ToolResult>;
  isReadOnly(): boolean;
  isEnabled(): boolean;
}
```

这是所有工具必须遵守的约定。

后面无论是：

- Read
- Write
- Bash
- Grep

都要长成这个样子。

## 3. name

```ts
readonly name: string;
```

工具名会发给模型。

我们第一个工具叫：

```ts
name: "Read"
```

模型后面返回 tool_use 时，也会写：

```json
{
  "type": "tool_use",
  "name": "Read"
}
```

程序就是靠这个名字找到具体工具的。

所以工具名要稳定，不要随便改。

## 4. description

```ts
readonly description: string;
```

描述是写给模型看的。

在 `fileReadTool.ts` 里：

```ts
description:
  "Read a UTF-8 text file from the current workspace. Use offset and limit for large files.",
```

模型会根据描述判断什么时候该用这个工具。

描述越清楚，模型越容易用对工具。

比如我们明确说：

```txt
Read a UTF-8 text file
```

模型就知道它适合读文本文件，不适合读图片或二进制文件。

## 5. inputSchema

```ts
readonly inputSchema: JSONSchema;
```

它是工具参数的说明书。

我们的 Read 工具参数是：

```ts
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
}
```

这会被转换成 Anthropic API 的 `tools` 参数。

模型看到后就知道：

- 必须传 `file_path`
- 可以传 `offset`
- 可以传 `limit`

例如模型可能生成：

```json
{
  "file_path": "package.json",
  "offset": 1,
  "limit": 80
}
```

## 6. ToolResult

还是在 `src/tools/Tool.ts`。

```ts
export interface ToolResult {
  content: string;
  isError?: boolean;
}
```

工具执行结果最终会放进 `tool_result` 消息，发回模型。

为什么 `content` 是字符串？

因为模型需要读的是文本。

比如 Read 工具返回：

```txt
E:\AIwork\easy-agent\package.json (28 lines)
1	{
2	  "name": "easy-agent",
3	  "version": "0.1.0",
```

这段文本会原样给模型。

如果工具失败，就返回：

```ts
{
  content: "Error: File not found: missing.txt",
  isError: true
}
```

错误也要变成模型能读懂的文本。

## 7. ToolContext

```ts
export interface ToolContext {
  cwd: string;
  abortSignal?: AbortSignal;
}
```

工具执行时需要上下文。

目前有两个字段。

### 7.1 cwd

```ts
cwd: string;
```

表示当前工作目录。

如果模型要读：

```txt
package.json
```

程序要知道它是相对于哪个目录。

在 `App.tsx` 里我们传的是：

```ts
const toolContext: ToolContext = {
  cwd: process.cwd(),
  abortSignal: signal,
};
```

也就是用户启动 CLI 时所在的目录。

### 7.2 abortSignal

```ts
abortSignal?: AbortSignal;
```

这是第二节 Ctrl+C 中断机制的延续。

用户按 Ctrl+C 时，不只是模型请求要停，正在执行的工具也应该停。

## 8. Read 工具

对应文件：`src/tools/fileReadTool.ts`

它是第一个真正可用的工具。

导出的是：

```ts
export const fileReadTool: Tool = {
  name: "Read",
  description: "...",
  inputSchema: { ... },
  async call(...) {
    // ...
  },
  isReadOnly() {
    return true;
  },
  isEnabled() {
    return true;
  },
};
```

这就是一个完整工具。

## 9. Read 的输入解析

代码：

```ts
function parseInput(input: Record<string, unknown>): FileReadInput {
  const filePath = input.file_path;
  const offset = input.offset;
  const limit = input.limit;

  if (typeof filePath !== "string" || !filePath.trim()) {
    throw new Error('Missing required string parameter "file_path".');
  }

  // ...

  return {
    file_path: filePath,
    offset: offset ?? 1,
    limit,
  };
}
```

为什么要解析？

因为模型传来的参数类型是：

```ts
Record<string, unknown>
```

`unknown` 的意思是：我们还不知道它到底是什么类型。

模型理论上应该按 schema 传参数，但代码不能完全相信外部输入。

所以我们要检查：

- `file_path` 必须是非空字符串
- `offset` 如果有，必须是正整数
- `limit` 如果有，必须是正整数

这一步叫参数校验。

## 10. 路径解析和安全边界

代码：

```ts
function resolveInsideCwd(cwd: string, filePath: string): string {
  const resolved = path.resolve(cwd, filePath);
  const relative = path.relative(cwd, resolved);

  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`File is outside the workspace: ${filePath}`);
  }

  return resolved;
}
```

教程里只写了：

```ts
path.resolve(context.cwd, file_path)
```

我们这里多加了一层保护。

原因是工具是模型调用的。

如果模型传：

```txt
../../some/private/file
```

我们不希望它读到工作区外面的文件。

所以我们限制：

```txt
Read 只能读取当前 workspace 里面的文件。
```

这不是必须的，但很值得做。

## 11. 读取文件

核心代码：

```ts
const raw = await readFile(resolved, {
  encoding: "utf-8",
  signal: context.abortSignal,
});
```

这里用了 Node.js 的 `fs/promises`：

```ts
import { readFile } from "node:fs/promises";
```

`await readFile(...)` 会异步读取文件。

`encoding: "utf-8"` 表示按文本读取。

`signal` 表示这个读取操作可以被中断。

## 12. offset 和 limit

代码：

```ts
const allLines = raw.split(/\r?\n/);
const startIndex = input.offset - 1;
const endIndex =
  input.limit === undefined ? allLines.length : startIndex + input.limit;
const selected = allLines.slice(startIndex, endIndex);
```

这里要注意：

用户传的是行号，从 1 开始。

数组下标从 0 开始。

所以：

```ts
const startIndex = input.offset - 1;
```

例如：

```txt
offset = 1 -> startIndex = 0
offset = 10 -> startIndex = 9
```

`limit` 表示最多读几行。

如果模型只需要前 20 行，就可以传：

```json
{
  "file_path": "src/ui/App.tsx",
  "offset": 1,
  "limit": 20
}
```

这样可以节省 token。

## 13. 加行号

代码：

```ts
function addLineNumbers(content: string, startLine: number): string {
  const lines = content.split("\n");
  const padWidth = String(startLine + lines.length - 1).length;

  return lines
    .map((line, index) => {
      const lineNumber = String(startLine + index).padStart(padWidth, " ");
      return `${lineNumber}\t${line}`;
    })
    .join("\n");
}
```

输出示例：

```txt
1	{
2	  "name": "easy-agent",
3	  "version": "0.1.0",
4	  "description": "A terminal-native agentic coding system",
```

为什么要加行号？

因为后续模型要编辑文件时，需要知道具体行号。

行号就是坐标系。

没有行号，模型只能说：

```txt
把 name 那一段附近改一下
```

有行号后，它可以说：

```txt
修改第 2 行
```

## 14. 错误处理

Read 工具不会把错误直接抛到最外层。

它会返回一个 ToolResult：

```ts
return {
  content: `Error: File not found: ${String(rawInput.file_path)}`,
  isError: true,
};
```

这样错误会作为 `tool_result` 发回模型。

模型看到错误后，可以继续修正。

比如：

```txt
File not found: pkg.json
```

模型可能下一轮改成读：

```txt
package.json
```

这就是 Agentic Loop 的反馈机制。

## 15. 工具注册表

对应文件：`src/tools/index.ts`

代码：

```ts
const ALL_TOOLS: Tool[] = [fileReadTool];
```

目前只有一个工具。

以后加工具时，就往这里加：

```ts
const ALL_TOOLS: Tool[] = [
  fileReadTool,
  bashTool,
  grepTool,
];
```

## 16. getAllTools

```ts
export function getAllTools(): Tool[] {
  return ALL_TOOLS.filter((tool) => tool.isEnabled());
}
```

这个函数返回当前可用工具。

为什么要有 `isEnabled()`？

因为有些工具可能需要条件。

例如以后 Git 工具可能只有在 Git 仓库里才启用。

## 17. findToolByName

```ts
export function findToolByName(name: string): Tool | undefined {
  return getAllTools().find((tool) => tool.name === name);
}
```

模型返回：

```json
{ "name": "Read" }
```

程序就通过这个函数找到真正的 `fileReadTool`。

如果找不到，就返回错误 tool_result。

## 18. toolToApiParam

```ts
export function toolToApiParam(tool: Tool): AnthropicTool {
  return {
    name: tool.name,
    description: tool.description,
    input_schema: tool.inputSchema,
  };
}
```

这是把我们的 Tool 接口转换成 Anthropic API 需要的格式。

我们的内部字段叫：

```ts
inputSchema
```

Anthropic API 字段叫：

```ts
input_schema
```

所以需要转换。

## 19. 把 tools 发给 API

对应文件：

- `src/types/stream.ts`
- `src/services/api/streaming.ts`

我们给 `StreamRequestParams` 加了：

```ts
tools?: AnthropicTool[];
```

然后在请求里传给 SDK：

```ts
...(params.tools ? { tools: params.tools as AnthropicTool[] } : {}),
```

如果不传 tools，模型就不知道有工具。

如果传了，模型就会看到工具菜单。

这一节里，菜单里只有：

```txt
Read
```

## 20. App 里的 toolsApiParams

对应文件：`src/ui/App.tsx`

代码：

```ts
const toolsApiParams = useMemo(() => getToolsApiParams(), []);
```

`getToolsApiParams()` 会把所有启用的工具转成 API 参数。

为什么用 `useMemo`？

因为工具列表不需要每次 UI 重绘都重新计算。

`useMemo(..., [])` 的意思是：

```txt
组件第一次渲染时计算一次，后面复用结果。
```

## 21. runStreamingTurn 传入 tools

```ts
const generator = streamMessage({
  messages: [...currentMessages],
  model,
  system,
  tools: toolsApiParams,
  signal,
});
```

这一步非常关键。

上一节只传：

```ts
messages, model, system, signal
```

这一节多了：

```ts
tools
```

从这一刻开始，模型才有机会返回 `tool_use`。

## 22. executeTools

对应文件：`src/ui/App.tsx`

核心逻辑：

```ts
const toolUseBlocks = contentBlocks.filter(
  (block): block is Extract<ContentBlock, { type: "tool_use" }> => {
    return block.type === "tool_use";
  },
);
```

一条 assistant 消息可能包含：

- text
- tool_use

我们只需要取出 `tool_use`。

所以先过滤。

## 23. 执行单个工具

```ts
const tool = findToolByName(block.name);
```

如果找不到：

```ts
toolResults.push({
  type: "tool_result",
  tool_use_id: block.id,
  content,
  is_error: true,
});
```

如果找到了：

```ts
const result = await tool.call(block.input, toolContext);
```

这就是模型决策和代码执行的交界点。

模型只说：

```txt
我要调用 Read
```

代码真的执行：

```ts
fileReadTool.call(...)
```

## 24. tool_result 消息

执行完工具后，要返回一条 user 消息：

```ts
return { role: "user", content: toolResults };
```

注意，工具结果的 role 是：

```ts
"user"
```

不是 `"tool"`，也不是 `"assistant"`。

这是 Anthropic Messages API 的规则。

从 API 视角看，工具结果是“用户侧提供给模型的新信息”。

每个结果要带：

```ts
tool_use_id: block.id
```

这样 API 才知道这个结果对应哪个 tool_use。

## 25. Agentic Loop

对应文件：`src/ui/App.tsx` 的 `handleSubmit`。

现在主流程不再是：

```txt
请求一次 -> 结束
```

而是：

```txt
请求模型
  -> 如果模型要用工具
    -> 执行工具
    -> 把结果放回消息数组
    -> 再请求模型
  -> 直到模型正常结束
```

代码结构：

```ts
let turnCount = 0;

while (turnCount < MAX_TOOL_TURNS) {
  turnCount += 1;

  const result = await runStreamingTurn(nextMessages, abort.signal);

  // 追加 assistant 消息

  if (result.stopReason === "tool_use") {
    const toolResultMessage = await executeTools(contentBlocks, abort.signal);
    nextMessages = [...nextMessages, toolResultMessage];
    continue;
  }

  break;
}
```

这就是 Agentic Loop。

本质就是一个 while 循环。

## 26. MAX_TOOL_TURNS

```ts
const MAX_TOOL_TURNS = 50;
```

这是安全阀。

理论上模型可能一直调用工具：

```txt
读 A -> 读 B -> 读 C -> 读 A -> ...
```

所以必须设置最大轮数。

到了上限就停止继续循环。

## 27. 消息数组如何变化

假设用户问：

```txt
这个项目用了哪些依赖？
```

消息数组一开始是：

```ts
[
  { role: "user", content: "这个项目用了哪些依赖？" }
]
```

模型决定读文件后，追加 assistant：

```ts
[
  { role: "user", content: "这个项目用了哪些依赖？" },
  {
    role: "assistant",
    content: [
      { type: "text", text: "我先看看 package.json。" },
      {
        type: "tool_use",
        id: "toolu_...",
        name: "Read",
        input: { file_path: "package.json" }
      }
    ]
  }
]
```

程序执行 Read 后，追加 tool_result：

```ts
[
  // 前两条...
  {
    role: "user",
    content: [
      {
        type: "tool_result",
        tool_use_id: "toolu_...",
        content: "E:\\AIwork\\easy-agent\\package.json (28 lines)\n1\t{..."
      }
    ]
  }
]
```

然后程序再次请求模型。

模型这次已经看到了 `package.json` 内容，于是可以回答。

## 28. UI 如何显示工具进度

`ToolCallInfo` 现在是：

```ts
interface ToolCallInfo {
  id: string;
  name: string;
  resultLength?: number;
  isError?: boolean;
}
```

工具刚开始时：

```ts
{ id, name }
```

界面显示：

```txt
Using tool: Read
```

工具结束后：

```ts
{ id, name, resultLength: 1234 }
```

界面显示：

```txt
Read (1234 chars)
```

如果失败，就用红色显示。

## 29. 只读工具

Read 工具里：

```ts
isReadOnly(): boolean {
  return true;
}
```

现在这个字段还没有用于权限确认。

但后续很重要。

因为工具分两类：

- 只读工具：Read、Grep、List
- 会修改环境的工具：Write、Edit、Bash

只读工具通常可以直接执行。

危险工具后面要加权限确认。

## 30. 如何测试 Read 工具

我们已经用命令测试过：

```bash
npx tsx -e "import { fileReadTool } from './src/tools/index.ts'; void (async () => { const result = await fileReadTool.call({ file_path: 'package.json', offset: 1, limit: 5 }, { cwd: process.cwd() }); console.log(result.content); })();"
```

输出类似：

```txt
E:\AIwork\easy-agent\package.json (28 lines)
1	{
2	  "name": "easy-agent",
3	  "version": "0.1.0",
4	  "description": "A terminal-native agentic coding system",
5	  "type": "module",
```

这说明工具本身可以正常读取文件并加行号。

## 31. 如何测试 Agentic Loop

先启动：

```bash
npm run dev
```

然后问：

```txt
请读取 package.json，并总结这个项目用了哪些依赖
```

如果模型正确使用工具，你会看到类似：

```txt
Using tool: Read
Read (xxx chars)
```

然后模型会基于文件内容回答。

## 32. 本节完成后的架构

现在调用链变成：

```txt
App.handleSubmit
  -> runStreamingTurn
    -> streamMessage(tools)
      -> 模型返回 tool_use
  -> executeTools
    -> findToolByName
      -> fileReadTool.call
  -> tool_result 追加到 messages
  -> runStreamingTurn 再跑一轮
```

也就是：

```txt
模型决策 -> 程序执行 -> 结果反馈 -> 模型继续决策
```

这就是 Agentic Loop。

## 33. 当前限制

当前实现还比较简单：

- 只有 Read 一个工具
- 只能读取 workspace 内的 UTF-8 文本文件
- 没有权限确认 UI
- 没有并发执行多个工具
- 没有文件大小上限
- 没有二进制文件检测
- 没有 Bash、Grep、Write、Edit

这些会在后续章节逐步补。

第三节的重点不是把所有工具做完，而是把工具系统的骨架搭起来。

## 34. 你需要掌握的最小知识

如果基础比较薄，先掌握这些：

1. 接口 `Tool` 是所有工具的统一协议
2. `inputSchema` 是给模型看的参数说明
3. `call()` 是程序真正执行动作的地方
4. `ToolResult.content` 是返回给模型看的文本
5. `tool_use` 是模型提出的工具请求
6. `tool_result` 是程序返回的工具结果
7. `findToolByName()` 用工具名找到具体实现
8. `while` 循环让模型可以多轮使用工具
9. `MAX_TOOL_TURNS` 防止无限循环
10. 工具结果在 Anthropic API 里要作为 `role: "user"` 发回

本节最核心的一句话是：

```txt
AI 不直接操作电脑，它输出 tool_use；我们的代码执行工具，再把 tool_result 发回去。
```

