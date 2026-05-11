# everyone-agent

一个基于 TypeScript、React Ink 和 Anthropic 兼容接口构建的终端 AI Agent。

项目目标是从零实现一个可在命令行中运行的 Agent：它可以和模型进行流式对话，维护会话上下文，并通过工具接口读取当前工作区文件，为后续扩展更多工具调用能力打基础。

## 功能特性

- 终端原生交互界面，基于 React Ink 构建。
- 支持流式输出，模型回复会边生成边显示。
- 支持连续对话，会在当前会话中保留上下文。
- 支持中断当前请求，避免长时间等待。
- 支持基础命令：清空历史、查看消息数量、退出程序。
- 支持工具调用，目前内置 `Read` 工具，可读取当前工作区内的 UTF-8 文本文件。
- 支持通过环境变量配置模型、Base URL、Token 和最大输出长度。

## 技术栈

- TypeScript
- React
- Ink
- Anthropic TypeScript SDK
- dotenv
- tsx

## 项目结构

```txt
.
├── docs/                  # 分阶段实现教程与说明
├── src/
│   ├── entrypoint/        # CLI 入口和流式 demo
│   ├── services/api/      # 模型客户端与流式请求封装
│   ├── tools/             # Agent 工具接口与内置工具
│   ├── types/             # 消息、流事件、工具等类型定义
│   └── ui/                # Ink 终端界面
├── .env.example           # 环境变量示例
├── package.json
└── tsconfig.json
```

## 快速开始

安装依赖：

```bash
npm install
```

创建本地环境变量文件：

```bash
copy .env.example .env
```

如果你使用 Git Bash、WSL 或 macOS/Linux，可以使用：

```bash
cp .env.example .env
```

然后编辑 `.env`，填入你的模型服务配置。

## 环境变量

| 变量名 | 说明 | 示例 |
| --- | --- | --- |
| `ANTHROPIC_AUTH_TOKEN` | API Token | `sk-...` |
| `ANTHROPIC_BASE_URL` | Anthropic 兼容接口地址 | `https://api.anthropic.com` |
| `ANTHROPIC_MODEL` | 默认模型名称 | `gpt-5.4-mini` |
| `MODEL_MAX_TOKENS` | 单次请求最大 token 数 | `128000` |
| `ANTHROPIC_USER_AGENT` | 请求头中的 User-Agent | 可使用默认值 |

程序会自动读取 `.env`。请不要提交真实的 `.env` 文件，仓库中只保留 `.env.example`。

## 开发运行

直接以 TypeScript 源码运行：

```bash
npm run dev
```

也可以指定模型：

```bash
npm run dev -- --model gpt-5.4-mini
```

查看帮助：

```bash
npm run dev -- --help
```

查看版本：

```bash
npm run dev -- --version
```

## 构建与启动

构建项目：

```bash
npm run build
```

运行构建后的 CLI：

```bash
npm start
```

构建后也可以直接执行：

```bash
node dist/entrypoint/cli.js
```

## CLI 使用

启动后，在终端中直接输入问题并按回车即可开始对话。

内置命令：

| 命令 | 说明 |
| --- | --- |
| `/clear` | 清空当前会话历史 |
| `/history` | 查看当前会话消息数量 |
| `/exit` | 退出程序 |
| `/quit` | 退出程序 |

快捷键：

| 快捷键 | 说明 |
| --- | --- |
| `Ctrl+C` | 中断当前请求 |
| `Ctrl+D` | 退出程序 |

## 内置工具

### Read

`Read` 工具用于读取当前工作区内的文本文件。模型在需要查看项目文件时，可以请求调用该工具，程序会读取文件内容并把结果发送回模型。

当前工具约束：

- 只能读取当前工作区内的文件。
- 不允许读取工作区外部路径。
- 只处理 UTF-8 文本文件。
- 支持 `offset` 和 `limit`，可按行读取大文件的一部分。

## 学习文档

项目的 `docs/` 目录包含分阶段教程：

- `docs/lesson-01-streaming-api/README.md`：打通 LLM 流式通信。
- `docs/lesson-02-ink-ui/README.md`：用 React / Ink 构建终端 UI。
- `docs/lesson-03-tool-interface/README.md`：设计工具接口，让 Agent 可以读取文件。

建议按 lesson 顺序阅读，这样可以理解项目从流式 API、终端 UI 到工具调用的演进过程。

## 常用命令

```bash
npm install      # 安装依赖
npm run dev      # 开发模式运行
npm run build    # 编译 TypeScript
npm start        # 运行 dist 中的构建产物
```

## 后续扩展方向

- 增加文件写入、搜索、Shell 命令等更多工具。
- 增加工具权限控制和用户确认流程。
- 增加会话持久化能力。
- 增加配置文件，支持不同模型提供商和 profile。
- 增加测试覆盖，保证工具调用和流式事件处理稳定。

## License

当前仓库尚未添加开源许可证。如果计划公开复用，请先补充合适的 `LICENSE` 文件。
