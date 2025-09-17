// WebSocket 訊息格式統一定義

// =============================================================================
// 客戶端發送給伺服器的訊息格式
// =============================================================================

export interface ClientToServerMessage {
  event: string;
  payload: Record<string, unknown>;
}

// 具體的事件類型
export interface StartOutboundMessage extends ClientToServerMessage {
  event: 'startOutbound';
  payload: {
    project: {
      callFlowId: string;
      projectId: string;
      client_id: string;
      client_secret: string;
      state: 'active' | 'stop';
      error: string | null;
    };
  };
}

export interface StopOutboundMessage extends ClientToServerMessage {
  event: 'stopOutbound';
  payload: {
    project: {
      projectId: string;
    };
  };
}

// =============================================================================
// 伺服器發送給客戶端的訊息格式
// =============================================================================

export interface ServerToClientMessage {
  event: string;
  payload: {
    timestamp: string;
    [key: string]: unknown;
  };
}

// 專案資料結構
export interface ProjectData {
  projectId: string;
  callFlowId: string;
  state: 'active' | 'stop';
  client_id: string;
  agentQuantity: number;
  caller: unknown;
  access_token: string | null;
  recurrence: string | null;
  createdAt: string;
  updatedAt: string;
}

// 專案統計資料
export interface ProjectStats {
  totalProjects: number;
  activeProjects: number;
  connectedProjects: number;
  [key: string]: unknown;
}

// 所有專案更新訊息
export interface ProjectsUpdateMessage extends ServerToClientMessage {
  event: 'projectsUpdate';
  payload: {
    type: 'allProjects';
    data: ProjectData[];
    stats: ProjectStats;
    timestamp: string;
    triggeredBy: string;
  };
}

// 專案狀態變更訊息
export interface ProjectStatusChangeMessage extends ServerToClientMessage {
  event: 'projectStatusChange';
  payload: {
    data: {
      projectId: string;
      oldAction: string;
      newAction: string;
      changedAt: string;
    };
    timestamp: string;
  };
}

// 錯誤資料結構
export interface ErrorData {
  name?: string;
  message: string;
  stack?: string;
  cause?: unknown;
}

// 錯誤訊息
export interface ErrorMessage extends ServerToClientMessage {
  event: 'error';
  payload: {
    error: ErrorData;
    timestamp: string;
  };
}

// =============================================================================
// 聯合類型
// =============================================================================

export type ClientMessage = StartOutboundMessage | StopOutboundMessage;
export type ServerMessage = ProjectsUpdateMessage | ProjectStatusChangeMessage | ErrorMessage;
