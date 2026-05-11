流事件的类型定义
export type StreamEvent =
  | StreamTextEvent         // 文字增量
  | StreamToolUseStartEvent // 工具调用开始
  | StreamToolUseInputEvent // 工具参数 JSON 碎片
  | StreamMessageStartEvent // 消息开始
  | StreamMessageDoneEvent  // 消息结束（含 usage）
  | StreamErrorEvent;       // 错误