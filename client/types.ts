export type RpcId = string | number;

export type RpcError = {
  code: number;
  message: string;
  data?: unknown;
};

export type RpcRequest = {
  id: RpcId;
  method: string;
  params?: Record<string, unknown>;
};

export type RpcReply = {
  id: RpcId;
  result?: unknown;
  error?: RpcError;
};

export type RpcNotification = {
  method: string;
  params?: Record<string, unknown>;
};

export type RpcServerRequest = RpcRequest;

export type RpcMessage = RpcReply | RpcNotification | RpcServerRequest;

export type DaemonStatus = {
  authenticated: boolean;
  daemon: {
    available: boolean;
    endpoint?: string;
    error?: string;
  };
};

export type UserInput =
  | { type: "text"; text: string; text_elements: Array<unknown> }
  | {
      type: "image";
      url: string;
      detail?: "auto" | "low" | "high" | "original";
    };

export type ThreadItem = {
  type: string;
  id: string;
  [key: string]: unknown;
};

export type ThreadItemEntry = {
  turnId: string;
  item: ThreadItem;
  startedAtMs: number | null;
  completedAtMs: number | null;
};

export type ThreadStatus =
  | { type: "notLoaded" }
  | { type: "idle" }
  | { type: "systemError" }
  | { type: "active"; activeFlags: string[] };

export type ThreadSummary = {
  id: string;
  name: string | null;
  preview: string;
  cwd: string;
  updatedAt: number;
  createdAt: number;
  recencyAt: number | null;
  model: string | null;
  reasoningEffort: string | null;
  status: ThreadStatus;
  canAcceptDirectInput: boolean | null;
  archived?: boolean;
};

export type ModelOption = {
  id: string;
  model: string;
  displayName: string;
  description: string;
  hidden: boolean;
  isDefault: boolean;
  defaultReasoningEffort: string;
  supportedReasoningEfforts: Array<{
    reasoningEffort: string;
    description: string;
  }>;
};

export type ThreadDetails = {
  cwd: string;
  model: string | null;
  approvalPolicy: unknown;
  sandbox: unknown;
  activePermissionProfile: { id: string; extends: string | null } | null;
  reasoningEffort: string | null;
  thread: {
    status: ThreadStatus;
  };
};

export type ApprovalPrompt = {
  id: RpcId;
  method: string;
  params: Record<string, unknown>;
};
