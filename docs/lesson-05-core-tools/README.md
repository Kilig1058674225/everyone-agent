# Lesson 05: 实现核心工具集，文件、Shell、搜索

这一节的目标是把 Agent 的“手脚”补齐。

前面四节已经完成：

- 第一节：流式模型通信
- 第二节：React / Ink 终端 UI
- 第三节：Tool 接口和 Read 工具
- 第四节：独立 Agentic Loop 引擎

到第四节为止，AI 已经能读文件，但还不能：

- 创建文件
- 修改文件
- 搜索项目
- 找文件
- 跑命令

第五节补齐这组核心工具：

- `Read`
- `Write`
- `Edit`
- `Grep`
- `Glob`
- `Bash`

这些工具组合起来，已经能覆盖一个本地工程 Agent 的基础工作流：

```txt
找文件 -> 读文件 -> 修改文件 -> 跑命令 -> 根据结果继续修
```

## 当前已实现的文件

本节新增或修改了这些文件：

- `src/tools/utils.ts`
- `src/tools/fileReadTool.ts`
- `src/tools/fileWriteTool.ts`
- `src/tools/fileEditTool.ts`
- `src/tools/grepTool.ts`
- `src/tools/globTool.ts`
- `src/tools/bashTool.ts`
- `src/tools/index.ts`
- `src/tools/Tool.ts`

验证过：

```bash
npm run build
```

并用工具自身做过一次临时文件端到端测试。

## 1. 为什么工具集是分水岭

模型本身只会生成文本。

如果没有工具，它只能说：

```txt
你可以打开 package.json 看看 dependencies。
```

有了工具后，它可以说：

```txt
我要调用 Read 读取 package.json。
```

然后程序真的去读取文件，把结果发回模型。

当工具扩展到 Write、Edit、Grep、Glob、Bash 后，模型就能完成更完整的工程动作：

```txt
搜索函数位置 -> 阅读代码 -> 修改代码 -> 运行测试 -> 根据错误继续修正
```

这就是聊天机器人和本地 Agent 的区别。

## 2. 工具仍然遵循统一 Tool 接口

对应文件：`src/tools/Tool.ts`

当前接口：

```ts
export interface Tool {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: JSONSchema;

  call(input: Record<string, unknown>, context: ToolContext): Promise<ToolResult>;
  isReadOnly(input?: Record<string, unknown>): boolean;
  isEnabled(): boolean;
}
```

这一节只对 `isReadOnly` 做了一个小扩展：

```ts
isReadOnly(input?: Record<string, unknown>): boolean;
```

为什么要允许传 input？

因为 Bash 比较特殊。

同样是 Bash：

```bash
ls src
```

是只读。

但：

```bash
rm file.txt
```

会修改环境。

所以 Bash 的只读判断需要看具体命令。

## 3. 先抽公共工具 utils.ts

对应文件：`src/tools/utils.ts`

这一节最先做的不是 Write，也不是 Bash，而是公共工具模块。

原因是很多工具都需要相同能力：

- 路径解析
- 工作区边界检查
- 行号格式
- 输出截断
- 执行子进程
- 递归列文件

如果每个工具都自己写一份，后面很容易不一致。

## 4. 路径安全 resolveWorkspacePath

核心代码：

```ts
export function resolveWorkspacePath(filePath: string, cwd: string): string {
  const resolved = path.resolve(cwd, expandHome(filePath));
  ensureInsideCwd(resolved, cwd);
  return resolved;
}
```

它做两件事：

1. 把相对路径转成绝对路径
2. 确认最终路径仍然在当前 workspace 内

为什么重要？

因为工具参数是模型生成的。

如果模型传：

```txt
../../some/private/file
```

我们不希望工具读写到工作区外面。

所以这一节所有文件工具都走：

```ts
resolveWorkspacePath(...)
```

## 5. ensureInsideCwd

```ts
export function ensureInsideCwd(resolvedPath: string, cwd: string): void {
  const resolvedCwd = path.resolve(cwd);
  const relative = path.relative(resolvedCwd, resolvedPath);

  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Path is outside the workspace: ${resolvedPath}`);
  }
}
```

这里用 `path.relative` 判断目标路径是不是逃出了 workspace。

如果逃出，就直接抛错。

这一步是本地 Agent 的底线能力之一。

## 6. 输出截断 truncateOutput

```ts
export function truncateOutput(text: string, limit = DEFAULT_OUTPUT_LIMIT): string {
  if (text.length <= limit) {
    return text;
  }

  return `${text.slice(0, limit)}\n\n[Output truncated to ${limit} characters]`;
}
```

工具输出可能非常长。

比如：

- 构建日志
- 测试日志
- 搜索结果
- Shell 输出

如果全部塞回模型，会浪费大量 token。

所以默认限制：

```ts
export const DEFAULT_OUTPUT_LIMIT = 30_000;
```

超过后明确告诉模型输出被截断。

## 7. Read 工具

对应文件：`src/tools/fileReadTool.ts`

Read 已经在第三节实现过，这一节做了两点整理：

1. 改用公共 `resolveWorkspacePath`
2. 目录场景下返回目录列表反馈

如果模型读的是目录，不再只返回：

```txt
Path is a directory
```

而是返回类似：

```txt
Path is a directory: E:\AIwork\easy-agent\src
file	index.ts
dir	tools
dir	ui
```

这样模型可以根据列表继续决定读哪个文件。

## 8. Write 工具

对应文件：`src/tools/fileWriteTool.ts`

Write 的职责是创建或覆盖文件。

工具名：

```ts
name: "Write"
```

参数：

```ts
file_path
content
```

核心代码：

```ts
const resolved = resolveWorkspacePath(input.file_path, context.cwd);
const existed = await pathExists(resolved);

await mkdir(path.dirname(resolved), { recursive: true });
await writeFile(resolved, input.content, {
  encoding: "utf-8",
  signal: context.abortSignal,
});
```

## 9. Write 为什么自动创建父目录

用户可能让模型：

```txt
创建 src/demo/hello.ts
```

如果 `src/demo` 不存在，直接 `writeFile` 会失败。

所以先做：

```ts
await mkdir(path.dirname(resolved), { recursive: true });
```

这会自动创建父目录。

## 10. Write 返回 Created 还是 Updated

写入前先判断：

```ts
const existed = await pathExists(resolved);
```

返回时：

```ts
`${existed ? "Updated" : "Created"} file: ${resolved}`
```

这能让模型和用户都知道发生的是新建还是覆盖。

## 11. Edit 工具

对应文件：`src/tools/fileEditTool.ts`

Edit 的职责是精确修改文件中的一段文本。

参数：

```ts
file_path
old_string
new_string
```

核心流程：

```txt
读取文件
  -> 查找 old_string
    -> 要求唯一匹配
      -> 替换为 new_string
        -> 写回文件
          -> 返回预览
```

## 12. 为什么需要 Edit，不能只用 Write

Write 是整文件写入。

如果模型只想改一行，却必须重写整个文件，会有几个问题：

- 容易误伤无关内容
- 容易丢格式
- token 浪费
- 小修改变成大输出

Edit 用 `old_string -> new_string` 的方式，只替换一处精确内容。

这更适合代码修改。

## 13. 为什么要求 old_string 唯一匹配

代码：

```ts
const matches = countOccurrences(original, input.old_string);

if (matches === 0) {
  return { content: "Error: old_string was not found...", isError: true };
}

if (matches > 1) {
  return { content: "Error: old_string appears ... times...", isError: true };
}
```

如果同一段文本出现多次，工具不猜。

这看起来保守，但很重要。

Agent 系统里，可预测比“看起来聪明”更重要。

让模型提供更大的上下文，比默认改第一处安全得多。

## 14. 引号标准化

代码：

```ts
export function normalizeQuotes(value: string): string {
  return value
    .replaceAll("\u201c", '"')
    .replaceAll("\u201d", '"')
    .replaceAll("\u2018", "'")
    .replaceAll("\u2019", "'");
}
```

模型有时会输出弯引号。

代码里通常是直引号。

我们只标准化模型传入的 `old_string` 和 `new_string`，避免因为引号样式不同导致匹配失败。

## 15. Edit 返回预览

修改成功后返回：

```txt
Updated file: ...
Preview:
1	...
2	...
```

预览来自：

```ts
getPreview(updated, changedIndex)
```

它会返回修改点附近几行。

模型看到预览后，下一轮更容易判断修改是否正确。

## 16. Grep 工具

对应文件：`src/tools/grepTool.ts`

Grep 按内容搜索。

适合问题：

```txt
找 streamMessage 在哪里被调用
搜索 tool_result 的使用位置
查 query 函数定义
```

参数：

```ts
pattern
path?
include?
```

优先使用：

```bash
rg --line-number --column --no-heading --color never
```

如果没有 `rg`，会回退到 Node.js 递归搜索。

## 17. Grep 为什么独立于 Bash

你可能会想：

```txt
Bash 也可以跑 rg，为什么还要 Grep？
```

原因是工具语义。

当模型想搜内容时，应该用 Grep。

当模型想执行真实系统命令时，才用 Bash。

这样后续权限系统也更容易判断：

- Grep：只读
- Bash：需要按命令判断

## 18. Glob 工具

对应文件：`src/tools/globTool.ts`

Glob 按文件名查找。

适合问题：

```txt
找所有 *.ts 文件
找 src/tools 下的工具实现
找所有 README
```

参数：

```ts
pattern
path?
limit?
```

优先使用：

```bash
rg --files -g <pattern>
```

也会包含隐藏文件，但排除：

```txt
.git
node_modules
dist
```

这是测试中发现并修正的细节：`rg --files` 默认不返回点开头目录，所以我们加了 `--hidden`，再显式排除不该扫的大目录。

## 19. Bash 工具

对应文件：`src/tools/bashTool.ts`

Bash 是最强的工具。

参数：

```ts
command
timeout_ms?
```

Windows 下会运行：

```txt
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -Command <command>
```

非 Windows 下会运行：

```txt
sh -lc <command>
```

## 20. Bash 为什么用子进程

Bash 需要调用系统命令。

实现上用了：

```ts
spawn(...)
```

封装在公共函数：

```ts
runCommand(...)
```

相比一次性 exec 字符串，spawn 更适合：

- 处理中断
- 捕获 stdout / stderr
- 控制超时
- 控制输出大小

## 21. Bash 捕获 stdout 和 stderr

返回内容类似：

```txt
Command: npm run build

Exit code: 0

stdout:
...

stderr:
...
```

模型需要这些输出判断下一步。

只告诉它 exit code 不够。

## 22. Bash 超时

默认超时：

```ts
120_000
```

也就是 2 分钟。

如果命令卡住，例如服务一直运行或等待输入，工具会杀掉子进程，并返回超时提示。

## 23. Bash 支持 AbortSignal

`runCommand()` 接收：

```ts
signal?: AbortSignal
```

用户 Ctrl+C 后，核心循环的 signal 会一路传到 Bash。

如果命令还在跑，会执行：

```ts
child.kill();
```

避免 UI 停了，后台命令还在跑。

## 24. Bash 输出截断

Bash 输出也走：

```ts
truncateOutput(...)
```

超过 30000 字符会截断。

这能防止构建日志或测试日志把上下文撑爆。

## 25. Bash 只读判定

代码：

```ts
export function isReadOnlyShellCommand(command: string): boolean {
  return splitCommandSegments(command).every(isReadOnlySegment);
}
```

当前白名单包括：

- `ls`
- `cat`
- `rg`
- `grep`
- `find`
- `pwd`
- `git status`
- `git log`
- `git diff`
- `git show`

如果命令包含：

```txt
>
<
```

直接认为不是只读。

这个机制现在还没有接权限弹窗，但语义已经准备好了。

## 26. 工具注册表

对应文件：`src/tools/index.ts`

当前工具数组：

```ts
const ALL_TOOLS: Tool[] = [
  fileReadTool,
  fileWriteTool,
  fileEditTool,
  grepTool,
  globTool,
  bashTool,
];
```

核心循环不需要知道有哪些工具。

它只通过：

```ts
findToolByName(name)
```

查找工具。

API 请求只通过：

```ts
getToolsApiParams()
```

把工具菜单发给模型。

## 27. 为什么 query() 不需要改

第四节我们已经把核心循环抽出来了。

这一节虽然加了五个新工具，但 `query()` 不需要修改。

原因是它只依赖统一接口：

```ts
tool.call(...)
```

工具多了，只需要注册。

这就是抽象层的价值。

## 28. 端到端工具测试

本节实现后，用临时文件测试过：

```txt
Write 创建 .tmp-tool-test/hello.txt
Edit 把 world 改成 agent
Grep 搜索 agent
Glob 查找 .tmp-tool-test/*.txt
Bash 读取文件内容
```

其中 Glob 一开始没找到点开头目录，后来修正为：

```txt
rg --files --hidden -g !.git -g !node_modules -g !dist
```

最后构建通过：

```bash
npm run build
```

## 29. 如何在 UI 中测试

启动：

```bash
npm run dev
```

可以试一个综合任务：

```txt
请创建 hello.ts，内容是 console.log("Hello World")，然后运行它
```

理想流程：

```txt
模型调用 Write
程序创建文件
模型调用 Bash
程序运行命令
模型根据输出总结
```

也可以试搜索任务：

```txt
请找出 streamMessage 在项目中哪里被调用
```

模型应该优先使用 Grep，而不是 Bash。

## 30. 当前限制

当前工具集还是基础版：

- Write 会覆盖文件，还没有权限确认
- Edit 只支持唯一字符串替换
- Bash 只读判定还比较朴素
- Grep / Glob 的 fallback 版本不如 rg 强
- 没有二进制文件检测
- 没有输出分页
- 没有工具执行并发

这些限制会在后续权限系统和上下文工程里继续完善。

## 31. 你需要掌握的最小知识

如果基础比较薄，先掌握这些：

1. 工具层决定 Agent 能做什么
2. 所有工具都遵循统一 `Tool` 接口
3. 文件工具必须先做路径安全
4. Read 负责看文件
5. Write 负责整文件写入
6. Edit 负责精确替换
7. Grep 负责内容搜索
8. Glob 负责文件查找
9. Bash 负责系统命令
10. Bash 必须有超时、中断和输出截断
11. 工具只需要注册，核心循环不用跟着膨胀

本节最核心的一句话是：

```txt
工具层越清晰，Agent 的行动能力越强，核心循环越稳定。
```

