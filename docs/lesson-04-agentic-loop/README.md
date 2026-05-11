# Lesson 04: Agentic Loop，AI 自主循环的核心引擎

这一节的目标不是增加一个全新的用户功能，而是把第三节已经跑通的工具循环，从 UI 里抽出来，变成核心层的可复用引擎。

第三节结束时，程序已经能做到：

```txt
用户提问
  -> 模型返回 tool_use
    -> 程序执行 Read
      -> 程序把 tool_result 发回模型
        -> 模型继续回答
```

但问题是：这套循环逻辑还写在 `src/ui/App.tsx` 里。

第四节要做的是把它移动到：

```txt
src/core/agenticLoop.ts
```

让 UI 只负责展示，让 core 负责真正的 Agentic Loop。

## 当前已实现的文件

本节新增或修改了这些文件：

- `src/core/agenticLoop.ts`
- `src/core/index.ts`
- `src/index.ts`
- `src/ui/App.tsx`

验证过：

```bash
npm run build
```

并单独测试过 `runTools()` 可以把 `tool_use` 转成 `tool_result` 消息。

## 1. 什么是 Agentic Loop

普通聊天程序通常是：

```txt
用户输入
  -> 调用模型
    -> 模型回复
      -> 结束
```

Agent 程序多了一个工具分支：

```txt
用户输入
  -> 调用模型，携带 tools
    -> 模型返回 tool_use
      -> 程序执行工具
        -> tool_result 追加进消息数组
          -> 再调用模型
            -> 直到模型不再调用工具
```

这个循环就是 Agentic Loop。

一句话理解：

```txt
模型决定下一步，程序执行动作，结果回到上下文，模型继续推理。
```

## 2. 为什么第四节还要重构

第三节已经能调用工具，为什么还要做第四节？

因为第三节的循环长在 UI 里。

这会让 `App.tsx` 同时负责：

- 键盘输入
- React 状态
- 终端渲染
- 调模型
- 执行工具
- 追加消息
- 判断是否继续循环
- 处理中断
- 统计 token

文件会越来越重。

以后加：

- BashTool
- EditTool
- 权限确认
- 会话持久化
- 上下文压缩
- 成本统计

都会把 UI 搅得更复杂。

所以第四节做架构分层：

```txt
通信层：streamMessage()，只负责一次模型请求
核心层：query()，负责多轮 Agentic Loop
UI 层：App.tsx，只消费事件并渲染
```

## 3. 新核心文件 agenticLoop.ts

对应文件：

```txt
src/core/agenticLoop.ts
```

这个文件现在导出两个核心函数：

```ts
export async function runTools(...)
export async function* query(...)
```

它还导出一组类型：

- `LoopState`
- `LoopTerminationReason`
- `QueryParams`
- `QueryEvent`
- `QueryResult`
- `RunToolsResult`
- `ToolExecutionInfo`

这些类型把循环的边界固定下来。

## 4. LoopState

代码：

```ts
export interface LoopState {
  messages: Message[];
  turnCount: number;
  aborted: boolean;
}
```

Agentic Loop 一定要有自己的状态。

当前有三个字段。

### 4.1 messages

```ts
messages: Message[];
```

这是完整上下文。

每一轮模型请求都基于它。

模型回复后追加 assistant 消息。

如果模型调用工具，再追加 tool_result 消息。

所以消息数组会不断增长。

### 4.2 turnCount

```ts
turnCount: number;
```

表示已经进行了多少次模型请求。

这里的“一轮”不是用户输入一轮，而是一次模型调用。

如果模型为了回答一个问题连续调用两次工具，可能就会跑三轮模型请求：

```txt
第 1 轮：模型请求 Read package.json
第 2 轮：模型请求 Read tsconfig.json
第 3 轮：模型总结回答
```

### 4.3 aborted

```ts
aborted: boolean;
```

表示循环是否被用户中断。

第二节我们已经有 Ctrl+C 的 `AbortController`。

第四节把这个概念沉淀到核心层状态里。

## 5. LoopTerminationReason

代码：

```ts
export type LoopTerminationReason =
  | "completed"
  | "aborted"
  | "model_error"
  | "max_turns";
```

核心循环必须明确自己为什么结束。

### 5.1 completed

模型没有继续请求工具。

通常对应：

```txt
stopReason !== "tool_use"
```

这表示模型已经阶段性完成回答。

### 5.2 aborted

用户按 Ctrl+C。

`AbortController` 触发后，循环尽快停止。

### 5.3 model_error

模型请求失败。

例如：

- API key 错误
- baseURL 错误
- 网络失败
- 流式过程异常

这些都归为 `model_error`。

UI 不需要知道底层细节，只要显示错误即可。

### 5.4 max_turns

安全阀。

如果模型一直调用工具，循环不能无限跑。

我们定义了：

```ts
export const DEFAULT_MAX_TOOL_TURNS = 50;
```

超过 50 轮就停止。

## 6. QueryParams

代码：

```ts
export interface QueryParams {
  messages: Message[];
  model?: string;
  system?: string;
  tools?: AnthropicTool[];
  toolContext: ToolContext;
  maxTurns?: number;
  signal?: AbortSignal;
}
```

这是调用 `query()` 时需要传入的参数。

字段说明：

- `messages`：初始消息数组
- `model`：模型名
- `system`：系统提示词
- `tools`：API 工具菜单
- `toolContext`：工具运行上下文，比如 cwd
- `maxTurns`：最大循环轮数
- `signal`：中断信号

注意，`query()` 不直接关心 UI。

它只关心：

```txt
给我消息、模型、工具和上下文，我来跑循环。
```

## 7. QueryEvent

代码：

```ts
export type QueryEvent =
  | Extract<StreamEvent, { type: "text" | "tool_use_start" }>
  | QueryAssistantMessageEvent
  | QueryToolUseDoneEvent
  | QueryToolResultMessageEvent
  | QueryTurnStartEvent
  | QueryErrorEvent;
```

`query()` 是异步生成器。

它会在运行过程中不断 `yield` 事件。

这些事件给 UI 使用。

当前事件包括：

- `turn_start`
- `text`
- `tool_use_start`
- `tool_use_done`
- `assistant_message`
- `tool_result_message`
- `error`

## 8. 为什么 query() 也用 AsyncGenerator

函数签名：

```ts
export async function* query(
  params: QueryParams,
): AsyncGenerator<QueryEvent, QueryResult> {
  // ...
}
```

`query()` 有两个需求：

第一，中间过程要实时通知 UI：

- 模型输出了一段文字
- 工具开始调用
- 工具执行完成
- assistant 消息完成
- tool_result 消息生成

第二，结束时还要返回最终结果：

- 最新消息数组
- 总 token 用量
- 结束原因
- 实际 turnCount

普通 `Promise` 只能返回最终结果。

回调可以传中间事件，但控制流容易乱。

异步生成器正好适合：

```txt
yield 中间事件
return 最终结果
```

## 9. runTools 的职责

对应函数：

```ts
export async function runTools(
  contentBlocks: ContentBlock[],
  toolContext: ToolContext,
): Promise<RunToolsResult>
```

它负责把 assistant 消息里的 `tool_use` 转换成一条 user 消息里的 `tool_result`。

输入：

```ts
[
  { type: "text", text: "我先读 package.json。" },
  {
    type: "tool_use",
    id: "toolu_test",
    name: "Read",
    input: { file_path: "package.json" }
  }
]
```

输出：

```ts
{
  message: {
    role: "user",
    content: [
      {
        type: "tool_result",
        tool_use_id: "toolu_test",
        content: "E:\\AIwork\\easy-agent\\package.json..."
      }
    ]
  },
  executions: [
    {
      id: "toolu_test",
      name: "Read",
      resultLength: 98
    }
  ]
}
```

## 10. 为什么 runTools 返回 executions

`message` 是给模型的。

`executions` 是给 UI 的。

模型需要：

```ts
tool_result
```

UI 需要：

```txt
Read (98 chars)
```

所以我们同时返回两份信息。

这比让 UI 自己解析 tool_result 更清楚。

## 11. runTools 如何找工具

核心代码：

```ts
const tool = findToolByName(block.name);
```

模型只会返回工具名：

```txt
Read
```

程序通过工具注册表找到真正实现。

如果找不到：

```ts
const content = `Error: Unknown tool "${block.name}".`;
```

然后包装成错误 tool_result。

这样错误不会让程序崩溃，而是反馈给模型。

## 12. runTools 为什么串行执行

代码里是：

```ts
for (const block of getToolUseBlocks(contentBlocks)) {
  const result = await tool.call(block.input, toolContext);
}
```

也就是一个一个执行。

原因：

- 当前工具数量少
- 串行更容易调试
- 结果顺序稳定
- 后续接权限确认更自然

等工具系统成熟后，再考虑并行执行。

## 13. query 初始化状态

代码：

```ts
let state: LoopState = {
  messages: [...params.messages],
  turnCount: 0,
  aborted: false,
};
const totalUsage: Usage = { input_tokens: 0, output_tokens: 0 };
let stopReason = "";
```

注意：

```ts
messages: [...params.messages]
```

这里复制了一份数组。

不要直接引用调用方传进来的数组。

这样核心层内部更新不会意外修改外部状态。

## 14. while 循环

核心结构：

```ts
while (state.turnCount < maxTurns) {
  // 检查中断
  // 调 streamMessage()
  // 处理流式事件
  // 追加 assistant message
  // 如果不是 tool_use，结束
  // 如果是 tool_use，runTools()
  // 追加 tool_result message
}
```

这就是 Agentic Loop 的主体。

## 15. turn_start 事件

```ts
state = { ...state, turnCount: state.turnCount + 1 };
yield { type: "turn_start", turnCount: state.turnCount };
```

每次进入新一轮模型请求，就产出 `turn_start`。

UI 收到它后会：

```ts
accumulatedText = "";
setStreamingText("");
setSpinnerLabel("Thinking");
```

也就是清空当前流式文本，准备显示新一轮回复。

## 16. 调用 streamMessage

```ts
const stream = streamMessage({
  messages: state.messages,
  model: params.model,
  system: params.system,
  tools: params.tools,
  signal: params.signal,
});
```

这里体现了分层：

- `streamMessage()` 只负责一次请求
- `query()` 负责决定是否继续下一轮

`streamMessage()` 不知道 Agentic Loop。

它只知道如何和模型通信。

## 17. 转发流式事件

```ts
if (value.type === "text" || value.type === "tool_use_start") {
  yield value;
}
```

模型流式输出文本时，query 直接转发给 UI。

模型开始请求工具时，也直接转发给 UI。

所以 UI 仍然能实时显示：

```txt
正在打字...
Using tool: Read
```

## 18. assistant_message 事件

当一轮模型请求结束后：

```ts
const assistantMessage: Message = streamResult.assistantMessage;
state = {
  ...state,
  messages: [...state.messages, assistantMessage],
};
yield {
  type: "assistant_message",
  message: assistantMessage,
  stopReason,
  usage: streamResult.usage,
};
```

这里做了两件事：

1. 把完整 assistant 消息追加进核心状态
2. 通知 UI 也追加这条消息

这一步很重要。

流式 `text` 事件只是“正在显示的临时文本”。

`assistant_message` 才是“完整消息已经确定，可以进入历史”。

## 19. 判断是否继续

```ts
if (stopReason !== "tool_use" || !Array.isArray(contentBlocks)) {
  return {
    state,
    usage: totalUsage,
    terminationReason: "completed",
    stopReason,
  };
}
```

如果 stopReason 不是 `tool_use`，说明模型不需要工具了。

循环结束，返回 `completed`。

如果是 `tool_use`，就继续执行工具。

## 20. 执行工具并产出 tool_use_done

```ts
const toolsResult = await runTools(contentBlocks, {
  ...params.toolContext,
  abortSignal: params.signal,
});

for (const execution of toolsResult.executions) {
  yield { type: "tool_use_done", ...execution };
}
```

工具执行完后，query 不直接更新 UI。

它只产出事件：

```ts
tool_use_done
```

UI 收到后，把：

```txt
Using tool: Read
```

更新成：

```txt
Read (98 chars)
```

## 21. tool_result_message 事件

```ts
state = {
  ...state,
  messages: [...state.messages, toolsResult.message],
};
yield { type: "tool_result_message", message: toolsResult.message };
```

工具结果也要追加到消息数组里。

注意这条消息的 role 是：

```ts
"user"
```

这是 Anthropic 的协议要求。

从模型角度看，工具执行结果是用户侧提供的新信息。

## 22. max_turns

如果 while 循环跑满：

```ts
return {
  state,
  usage: totalUsage,
  terminationReason: "max_turns",
  stopReason,
};
```

这说明模型一直在请求工具，没有自然结束。

UI 会显示：

```txt
Stopped after reaching the tool turn limit.
```

## 23. App.tsx 变成事件消费者

第四节后，`App.tsx` 不再自己执行工具。

它现在调用：

```ts
const loop = query({
  messages: nextMessages,
  model,
  system,
  tools: toolsApiParams,
  toolContext: {
    cwd: process.cwd(),
    abortSignal: abort.signal,
  },
  signal: abort.signal,
});
```

然后消费事件：

```ts
while (true) {
  const { value, done } = await loop.next();

  if (done) {
    // 使用最终结果
    break;
  }

  switch (value.type) {
    // 更新 UI
  }
}
```

这就是本节最大的变化。

UI 不再是编排者，而是事件消费者。

## 24. UI 如何处理 text

```ts
case "text":
  accumulatedText += value.text;
  setStreamingText(accumulatedText);
  break;
```

这和第二节一样。

模型每流出一段文字，UI 就更新 `streamingText`。

## 25. UI 如何处理 tool_use_start

```ts
case "tool_use_start":
  setToolCalls((prev) => [
    ...prev,
    { id: value.id, name: value.name },
  ]);
  setSpinnerLabel(`Running ${value.name}`);
  break;
```

这表示模型请求了工具。

UI 先显示：

```txt
Using tool: Read
```

## 26. UI 如何处理 tool_use_done

```ts
case "tool_use_done":
  setToolCalls((prev) =>
    prev.map((toolCall) =>
      toolCall.id === value.id
        ? {
            ...toolCall,
            resultLength: value.resultLength,
            isError: value.isError,
          }
        : toolCall,
    ),
  );
  break;
```

工具执行完后，UI 更新对应工具项。

这里用 `id` 匹配。

因为一次 assistant 消息里可能有多个 tool_use。

## 27. UI 如何处理 assistant_message 和 tool_result_message

```ts
case "assistant_message":
case "tool_result_message":
  nextMessages = [...nextMessages, value.message];
  setMessages(nextMessages);
  messagesRef.current = nextMessages;
  setStreamingText("");
  break;
```

核心层告诉 UI：

```txt
这条完整消息可以进入历史了
```

UI 就追加到本地 messages。

注意，这里 UI 还是保留了自己的 React state。

核心层负责逻辑状态，UI state 负责显示。

两者通过事件同步。

## 28. UI 如何处理最终结果

当 `done === true` 时：

```ts
nextMessages = value.state.messages;
setMessages(nextMessages);
messagesRef.current = nextMessages;
setStreamingText("");
setLastUsage({
  input: value.usage.input_tokens,
  output: value.usage.output_tokens,
});
```

最终结果来自 `query()` 的 return。

它包含完整状态。

这一步相当于用核心层的最终状态校准 UI。

## 29. 中断如何流动

第二节里，Ctrl+C 会执行：

```ts
abortRef.current.abort();
```

第四节后，这个信号会传给：

```txt
App.tsx
  -> query()
    -> streamMessage()
    -> runTools()
      -> fileReadTool.call()
```

也就是说，模型请求和工具执行都共享同一个中断信号。

核心层如果发现：

```ts
params.signal?.aborted
```

就返回：

```ts
terminationReason: "aborted"
```

UI 收到后显示：

```txt
Interrupted.
```

## 30. 本节前后对比

第三节时：

```txt
App.tsx
  -> 调模型
  -> 判断 stopReason
  -> 查找工具
  -> 执行工具
  -> 包装 tool_result
  -> 继续 while
```

第四节后：

```txt
App.tsx
  -> query()
  -> switch QueryEvent 更新 UI
```

核心循环移动到：

```txt
src/core/agenticLoop.ts
```

这就是架构上的关键推进。

## 31. 如何验证

### 31.1 构建验证

```bash
npm run build
```

应该通过。

### 31.2 runTools 单独验证

我们已经用这个命令验证过：

```bash
npx tsx -e "import { runTools } from './src/core/index.ts'; void (async () => { const result = await runTools([{ type: 'tool_use', id: 'toolu_test', name: 'Read', input: { file_path: 'package.json', offset: 1, limit: 3 } }], { cwd: process.cwd() }); console.log(JSON.stringify(result, null, 2)); })();"
```

输出里能看到：

```json
{
  "message": {
    "role": "user",
    "content": [
      {
        "type": "tool_result",
        "tool_use_id": "toolu_test",
        "content": "E:\\AIwork\\easy-agent\\package.json..."
      }
    ]
  }
}
```

说明工具结果消息格式正确。

### 31.3 交互验证

启动：

```bash
npm run dev
```

输入：

```txt
请读取 package.json 的内容，并告诉我项目的 name
```

检查：

- UI 显示工具调用
- Read 工具完成
- 模型基于读取内容回答

### 31.4 中断验证

在模型回复或工具循环过程中按 Ctrl+C。

检查：

- 当前请求停止
- UI 显示 Interrupted.
- 程序仍能继续下一次输入

## 32. 当前限制

本节只是把 Agentic Loop 抽成核心层，还没有引入更复杂的能力。

当前还没有：

- 权限确认系统
- 会话持久化
- 工具并发调度
- 上下文压缩
- 成本上限
- QueryEngine

但这些能力后面都可以围绕 `query()` 接入。

这就是为什么第四节重要：它给后续章节准备了稳定核心。

## 33. 你需要掌握的最小知识

如果基础比较薄，先掌握这些：

1. `streamMessage()` 负责一次模型请求
2. `query()` 负责多轮 Agentic Loop
3. `runTools()` 负责把 tool_use 转成 tool_result
4. `yield` 用来向 UI 发中间事件
5. `return` 用来返回最终状态
6. `LoopState` 保存核心循环状态
7. `LoopTerminationReason` 说明循环为什么结束
8. UI 不再执行工具，只消费 `QueryEvent`
9. `tool_result` 仍然是 `role: "user"` 的消息
10. `MAX_TOOL_TURNS` 是防无限循环的安全阀

本节最核心的一句话是：

```txt
把 UI 里能跑的工具循环，抽成 core 层可复用的 query() 引擎。
```

