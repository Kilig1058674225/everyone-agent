export interface JSONSchema {
  type: "object";
  properties?: Record<string, unknown>;
  required?: string[];
  [key: string]: unknown;
}

export interface ToolResult {
  content: string;
  isError?: boolean;
}

export interface ToolContext {
  cwd: string;
  abortSignal?: AbortSignal;
}

export interface Tool {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: JSONSchema;

  call(input: Record<string, unknown>, context: ToolContext): Promise<ToolResult>;
  isReadOnly(input?: Record<string, unknown>): boolean;
  isEnabled(): boolean;
}
