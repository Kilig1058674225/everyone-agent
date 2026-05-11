# Lesson 02: 用 React / Ink 构建终端 UI

这一节的目标是把上一节的 `stream-demo.ts`，升级成一个真正可以持续对话的终端程序。

上一节我们已经做到：

- 能向模型发送一条消息
- 能流式接收模型回复
- 能在终端里逐段打印文本

但它还不是一个好用的 CLI，因为它没有这些能力：

- 没有持续输入
- 没有对话历史
- 没有 loading 动画
- 没有清晰的错误展示
- 没有中断当前请求
- 没有真正的终端 UI 结构

这一节用 React 和 Ink 来解决这些问题。

## 当前已实现的文件

本节对应这些文件：

- `tsconfig.json`
- `src/ui/components/Spinner.tsx`
- `src/ui/App.tsx`
- `src/ui/index.ts`
- `src/entrypoint/cli.ts`
- `src/types/stream.ts`
- `src/services/api/streaming.ts`

你可以按下面的顺序阅读。

## 1. 为什么要用 Ink

如果不用 Ink，我们通常会这样写终端输出：

```ts
process.stdout.write("Thinking...");
process.stdout.write("hello");
process.stdout.write(" world");
```

这种写法适合上一节的 demo，但不适合复杂 UI。

因为复杂 CLI 里会同时存在很多状态：

- 当前输入框内容
- 是否正在请求模型
- 当前流式回复到哪了
- 对话历史
- token 用量
- 错误信息
- 是否被用户中断

如果全部靠 `process.stdout.write()`，你就要自己处理：

- 清屏
- 移动光标
- 覆盖旧内容
- 保持布局不乱
- 避免 loading 动画和新文本打架

Ink 的作用是让你像写 React 网页一样写终端 UI。

你只描述：

```tsx
{isLoading && <Spinner />}
{errorText && <Text color="red">{errorText}</Text>}
```

Ink 负责把它画到终端上。

核心思想是：

```txt
状态改变 -> React 重新生成 UI -> Ink 更新终端
```

你不再直接操作终端，而是操作状态。

## 2. TypeScript 配置 JSX

对应文件：`tsconfig.json`

我们加了：

```json
"jsx": "react-jsx"
```

以及：

```json
"include": ["src/**/*.ts", "src/**/*.tsx"]
```

这里有两个知识点。

第一，React 组件文件一般写成 `.tsx`。

`.ts` 文件只能写普通 TypeScript：

```ts
const name = "Easy Agent";
```

`.tsx` 文件可以写 JSX：

```tsx
<Text>Hello</Text>
```

第二，TypeScript 默认不会编译 JSX，必须告诉它：

```json
"jsx": "react-jsx"
```

`react-jsx` 是 React 17 之后的新写法。启用后，组件文件里不需要每个文件都写：

```ts
import React from "react";
```

## 3. Spinner 组件

对应文件：`src/ui/components/Spinner.tsx`

代码核心：

```tsx
const FRAMES = ["-", "\\", "|", "/"];

export function Spinner({ label = "Thinking" }: SpinnerProps): ReactNode {
  const [frameIndex, setFrameIndex] = useState(0);

  useEffect(() => {
    const timer = setInterval(() => {
      setFrameIndex((prev) => (prev + 1) % FRAMES.length);
    }, 80);

    return () => clearInterval(timer);
  }, []);

  return (
    <Text dimColor>
      {FRAMES[frameIndex]} {label}...
    </Text>
  );
}
```

### 3.1 useState 是什么

`useState` 用来保存会影响 UI 的数据。

这里：

```ts
const [frameIndex, setFrameIndex] = useState(0);
```

意思是：

- `frameIndex` 是当前第几帧
- `setFrameIndex` 用来修改它
- 初始值是 `0`

当你调用：

```ts
setFrameIndex(1);
```

React 会重新执行组件函数，Ink 会重新画终端。

所以 spinner 不需要手动刷新终端。

### 3.2 useEffect 是什么

`useEffect` 用来处理副作用。

副作用就是“不是单纯计算 UI”的事情，比如：

- 开定时器
- 发网络请求
- 监听键盘
- 注册事件

这里我们用它开一个定时器：

```ts
const timer = setInterval(() => {
  setFrameIndex((prev) => (prev + 1) % FRAMES.length);
}, 80);
```

每 80ms 切换一次帧。

最后返回清理函数：

```ts
return () => clearInterval(timer);
```

这很重要。

当组件不显示了，定时器要被清掉。否则定时器还在后台跑，容易造成内存泄漏或重复刷新。

### 3.3 为什么文字必须放在 Text 里

Ink 有一条硬规则：

所有文字都要包在 `<Text>` 里面。

正确：

```tsx
<Text>Hello</Text>
```

错误：

```tsx
<Box>Hello</Box>
```

这是 Ink 和浏览器 React 很不一样的地方。

## 4. App 主组件的状态设计

对应文件：`src/ui/App.tsx`

App 是整个终端 UI 的核心。

我们现在有这些状态：

```tsx
const [messages, setMessages] = useState<Message[]>([]);
const [inputValue, setInputValue] = useState("");
const [isLoading, setIsLoading] = useState(false);
const [spinnerLabel, setSpinnerLabel] = useState("Thinking");
const [streamingText, setStreamingText] = useState("");
const [toolCalls, setToolCalls] = useState<ToolCallInfo[]>([]);
const [lastUsage, setLastUsage] = useState<{ input: number; output: number } | null>(null);
const [infoMessage, setInfoMessage] = useState<string | null>(null);
const [errorText, setErrorText] = useState<string | null>(null);
```

你可以先不用急着背这些名字，只要理解它们分三类。

### 4.1 对话数据

```ts
messages
```

保存完整对话历史。

例如：

```ts
[
  { role: "user", content: "你好" },
  { role: "assistant", content: [{ type: "text", text: "你好！" }] }
]
```

这就是后续请求时的上下文。

### 4.2 输入框和 UI 状态

```ts
inputValue
isLoading
streamingText
errorText
infoMessage
lastUsage
```

这些决定界面显示什么。

例如：

```tsx
{isLoading && !streamingText && <Spinner label={spinnerLabel} />}
```

意思是：

```txt
如果正在加载，而且还没有收到文字，就显示 Spinner
```

### 4.3 不触发重渲染的引用

```ts
const abortRef = useRef<AbortController | null>(null);
const messagesRef = useRef<Message[]>([]);
```

`useRef` 和 `useState` 很像，也能保存值。

区别是：

- `useState` 改了会触发 UI 更新
- `useRef` 改了不会触发 UI 更新

所以：

- `messages` 用来渲染历史消息
- `messagesRef.current` 用来在异步函数里拿最新消息
- `abortRef.current` 用来保存当前请求的中断控制器

## 5. 为什么同时需要 messages 和 messagesRef

这是本节最容易懵的点。

你可能会问：

```txt
既然已经有 messages，为什么还要 messagesRef？
```

因为 React 的状态更新不是立刻同步生效。

例如：

```ts
setMessages(nextMessages);
console.log(messages);
```

这里打印出来的 `messages` 不一定是新值。

在普通 UI 里这还好，但我们的 `handleSubmit` 是异步流程：

```txt
用户提交 -> 发请求 -> 流式接收 -> 追加 assistant 消息
```

如果异步函数里读到旧的 `messages`，上下文就会乱。

所以我们这样做：

```ts
let nextMessages = [...messagesRef.current, userMessage];
setMessages(nextMessages);
messagesRef.current = nextMessages;
```

这有两个效果：

- `setMessages(nextMessages)` 让 UI 更新
- `messagesRef.current = nextMessages` 让异步逻辑立刻拿到最新值

一句话总结：

```txt
messages 负责显示，messagesRef 负责异步逻辑中的最新数据。
```

## 6. 键盘输入 useInput

对应代码：

```tsx
useInput((input, key) => {
  // ...
});
```

Ink 的 `useInput` 会监听用户在终端里按下的键。

它给我们两个参数：

- `input`：用户输入的普通字符，比如 `"a"`、`"你"`
- `key`：特殊按键信息，比如 `return`、`ctrl`、`backspace`

### 6.1 Ctrl+C 中断

```ts
if (key.ctrl && input === "c") {
  if (abortRef.current) {
    abortRef.current.abort();
    abortRef.current = null;
    setIsLoading(false);
    setStreamingText("");
    setInfoMessage("Interrupted.");
  }

  return;
}
```

这里不是退出程序，而是中断当前请求。

为什么能中断？

因为我们在请求时创建了：

```ts
const abort = new AbortController();
abortRef.current = abort;
```

然后把它的 signal 传进了 `streamMessage()`：

```ts
runStreamingTurn(nextMessages, abort.signal)
```

最后 `streamMessage()` 把 signal 传给 SDK：

```ts
client.messages.stream(body, { signal: params.signal })
```

所以按 Ctrl+C 时：

```ts
abortRef.current.abort();
```

就能真的取消网络请求。

### 6.2 Ctrl+D 退出

```ts
if (key.ctrl && input === "d") {
  exit();
  return;
}
```

`exit()` 来自 Ink 的 `useApp()`。

它会结束 Ink 应用。

### 6.3 回车提交

```ts
if (key.return) {
  const text = inputValue;
  setInputValue("");
  void handleSubmit(text);
  return;
}
```

按回车时：

1. 取出当前输入
2. 清空输入框
3. 调用 `handleSubmit`

这里写：

```ts
void handleSubmit(text);
```

是因为 `handleSubmit` 是异步函数，返回 Promise。

我们不想在键盘回调里 `await` 它，所以用 `void` 表示“我知道它是 Promise，我故意不等待”。

### 6.4 退格删除

```ts
if (key.backspace || key.delete) {
  setInputValue((prev) => prev.slice(0, -1));
  return;
}
```

`slice(0, -1)` 的意思是去掉最后一个字符。

### 6.5 普通字符追加

```ts
if (input && !key.ctrl && !key.meta) {
  setInputValue((prev) => prev + input);
}
```

只要不是控制键，就把输入追加到输入框。

## 7. 提交流程 handleSubmit

`handleSubmit` 是用户按回车后的主流程。

可以分成五步。

### 7.1 处理空输入

```ts
const trimmed = text.trim();

if (!trimmed) {
  return;
}
```

`trim()` 会去掉前后空格。

如果用户只输入空格，不发送请求。

### 7.2 本地命令

```ts
if (trimmed === "/exit" || trimmed === "/quit") {
  exit();
  return;
}
```

这些命令不需要发给模型。

目前支持：

- `/exit`
- `/quit`
- `/clear`
- `/history`

例如 `/clear`：

```ts
setMessages([]);
messagesRef.current = [];
setInputValue("");
setInfoMessage("Conversation cleared.");
```

它会清空对话历史。

### 7.3 重置 UI 状态

```ts
setStreamingText("");
setToolCalls([]);
setErrorText(null);
setInfoMessage(null);
setLastUsage(null);
setIsLoading(true);
setSpinnerLabel("Thinking");
```

这是新一轮请求开始前的准备。

通俗说，就是把上一轮残留的错误、提示、流式文本清掉。

### 7.4 追加用户消息

```ts
const userMessage: Message = { role: "user", content: trimmed };
let nextMessages = [...messagesRef.current, userMessage];
setMessages(nextMessages);
messagesRef.current = nextMessages;
```

注意这里没有用：

```ts
messages.push(userMessage);
```

而是：

```ts
[...messagesRef.current, userMessage]
```

为什么？

React 判断状态变化主要看引用有没有变。

`push` 会修改原数组，但数组引用不变。

`[...old, newItem]` 会创建一个新数组，React 一定能检测到变化。

这叫不可变更新。

### 7.5 发起流式请求

```ts
const result = await runStreamingTurn(nextMessages, abort.signal);
```

这里会调用上一节写好的 `streamMessage()`。

请求完成后，如果拿到了完整结果，就追加 assistant 消息：

```ts
const assistantMessage: Message = result.assistantMessage;
nextMessages = [...nextMessages, assistantMessage];
setMessages(nextMessages);
messagesRef.current = nextMessages;
```

这也是为什么中断时不会产生脏数据。

只有完整返回后，assistant 消息才会加入历史。

如果中途 Ctrl+C：

- 流式文本会被清掉
- 请求会被 abort
- assistant 消息不会被加入历史

## 8. 流式渲染 runStreamingTurn

核心代码：

```ts
const generator = streamMessage({
  messages: [...currentMessages],
  model,
  system,
  signal,
});
```

`streamMessage()` 是上一节实现的 AsyncGenerator。

它会不断产出事件。

所以我们用：

```ts
while (true) {
  const { value, done } = await generator.next();
  if (done) return value ?? null;
}
```

每次读一个事件。

### 8.1 text 事件

```ts
case "text":
  accumulatedText += event.text;
  setStreamingText(accumulatedText);
  break;
```

模型每吐出一段文本，我们就追加到 `accumulatedText`。

然后：

```ts
setStreamingText(accumulatedText);
```

触发 UI 更新。

终端里看到的“打字机效果”就是这样来的。

不是我们手动做动画，而是 API 真的一段段返回。

### 8.2 tool_use_start 事件

```ts
case "tool_use_start":
  setToolCalls((prev) => [
    ...prev,
    { id: event.id, name: event.name },
  ]);
  setSpinnerLabel("Using tool");
  break;
```

现在我们还没有真正执行工具。

但类型和 UI 位置已经预留好了。

下一节工具系统接入后，这里会显示模型正在调用什么工具。

### 8.3 error 事件

```ts
case "error":
  if (!signal?.aborted) {
    setErrorText(event.message);
  }
  return null;
```

如果是用户主动中断，不显示成红色错误。

如果是真错误，比如 401、403、网络失败，就显示错误文本。

## 9. JSX 渲染结构

App 最后返回一棵 JSX 树。

最外层：

```tsx
<Box flexDirection="column" paddingX={1}>
```

`Box` 是布局容器。

`flexDirection="column"` 表示里面的内容一行一行往下排。

### 9.1 头部

```tsx
<Box marginBottom={1}>
  <Text bold color="cyan">Easy Agent</Text>
  <Text dimColor> ({model})</Text>
</Box>
```

显示项目名和当前模型。

### 9.2 历史消息

```tsx
{messages.map((message, index) => {
  // ...
})}
```

`messages` 数组里每条消息都会被渲染出来。

用户消息：

```tsx
<Text color="green" bold>{"> "}</Text>
<Text>{message.content}</Text>
```

助手消息：

```tsx
<Text color="magenta">{"| "}</Text>
<Text>{text}</Text>
```

### 9.3 loading 和流式文本

```tsx
{isLoading && !streamingText && <Spinner label={spinnerLabel} />}
```

还没收到文本时显示 spinner。

```tsx
{isLoading && streamingText && (
  <Box>
    <Text color="magenta">{"| "}</Text>
    <Text>{streamingText}</Text>
  </Box>
)}
```

收到文本后显示流式回复。

### 9.4 输入行

```tsx
{!isLoading && (
  <Box marginTop={1}>
    <Text color="green" bold>{"> "}</Text>
    <Text>{inputValue}</Text>
    <Text dimColor>_</Text>
  </Box>
)}
```

只有不在请求时才显示输入行。

正在请求时普通输入会被忽略。

## 10. CLI 入口

对应文件：`src/entrypoint/cli.ts`

入口做三件事：

1. 处理 `--version`
2. 处理 `--help`
3. 启动 Ink 应用

### 10.1 快路径

```ts
if (process.argv.includes("--version") || process.argv.includes("-v")) {
  console.log(`easy-agent v${VERSION}`);
  process.exit(0);
}
```

这个逻辑放在最前面。

原因是用户只是看版本号时，不需要加载 React、Ink、API client。

### 10.2 动态 import

```ts
const [{ createElement }, { render }, { App }, { DEFAULT_MODEL }] =
  await Promise.all([
    import("react"),
    import("ink"),
    import("../ui/index.js"),
    import("../services/api/index.js"),
  ]);
```

这叫动态加载。

对比普通静态 import：

```ts
import { render } from "ink";
```

静态 import 会在文件一启动时就加载。

动态 import 只有执行到这里才加载。

所以：

- `agent --version` 很快
- `agent --help` 很快
- 真正聊天时才加载 Ink

### 10.3 render 启动应用

```ts
const { waitUntilExit } = render(createElement(App, { model, system }));
await waitUntilExit();
```

`render()` 把 React 组件渲染到终端。

`waitUntilExit()` 会等待应用退出。

当 App 里调用：

```ts
exit();
```

这个 Promise 就会结束，CLI 进程退出。

## 11. 运行和验证

先构建：

```bash
npm run build
```

运行交互式 UI：

```bash
npm run dev
```

指定模型：

```bash
npm run dev -- --model gpt-5.4-mini
```

查看帮助：

```bash
node dist/entrypoint/cli.js --help
```

查看版本：

```bash
node dist/entrypoint/cli.js --version
```

进入 UI 后可以试：

```txt
你好，用一句话解释 agentic loop
```

再试：

```txt
/history
```

再试：

```txt
/clear
```

## 12. 本节和教程原文的差异

教程里后半段已经提前展示了工具调用和 Agentic Loop：

```txt
AI 调用工具 -> 执行工具 -> tool_result -> AI 继续
```

我们这一节只实现 UI 管道，没有真正执行工具。

原因是工具系统是下一节内容。

但我们已经预留了：

- `toolCalls`
- `tool_use_start`
- `ToolUseBlock`
- 流式事件里的 `tool_use_input`

也就是说，下一节接工具时不用推翻这一节，只需要在当前结构上继续加。

## 13. 当前架构小结

现在项目的调用链是：

```txt
cli.ts
  -> render(<App />)
    -> useInput 监听键盘
      -> handleSubmit
        -> runStreamingTurn
          -> streamMessage
            -> Anthropic SDK stream
```

模型回复回来时：

```txt
SDK event
  -> StreamEvent
    -> setStreamingText
      -> React 重渲染
        -> Ink 更新终端
```

这就是本节最重要的闭环。

## 14. 你需要掌握的最小知识

如果你的基础还比较薄，先掌握这些就够了：

1. `useState`：保存会影响 UI 的值
2. `useEffect`：处理定时器、请求、监听这类副作用
3. `useRef`：保存不会触发 UI 更新的可变值
4. `useCallback`：保存函数，避免每次渲染都创建新函数
5. `useInput`：监听终端键盘输入
6. `<Box>`：布局
7. `<Text>`：显示文字
8. `AsyncGenerator`：上一节的流式事件来源
9. `AbortController`：取消正在进行的请求
10. 不可变更新：用 `[...old, item]`，不要直接 `push`

本节不要求你一下子完全掌握 React。

你只需要记住一句话：

```txt
终端 UI = 状态 + JSX
```

状态变，界面就变。

