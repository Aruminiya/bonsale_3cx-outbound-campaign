import { WebSocket } from "ws";
import dotenv from 'dotenv';
import { logWithTimestamp, warnWithTimestamp, errorWithTimestamp } from '../util/timestamp';

dotenv.config();

// Define the WebSocket host for 3CX
const WS_HOST_3CX = process.env.WS_HOST_3CX;

// 檢查必要的環境變數
if (!WS_HOST_3CX) {
  console.warn('警告: WS_HOST_3CX 環境變數未設定');
}

export default class Project {
  grant_type: string;
  client_id: string;
  client_secret: string;
  callFlowId: string;
  projectId: string;
  action: 'init' | 'active';
  error: string | null;
  access_token: string | null;
  ws_3cx: WebSocket | null;

  constructor(
    client_id: string,
    client_secret: string,
    callFlowId: string,
    projectId: string,
    action: 'init' | 'active',
    error: string | null = null,
    access_token: string | null = null,
    ws_3cx: WebSocket | null = null
  ) {
    this.grant_type = 'client_credentials';
    this.client_id = client_id;
    this.client_secret = client_secret;
    this.callFlowId = callFlowId;
    this.projectId = projectId;
    this.action = action;
    this.error = error;
    this.access_token = access_token;
    this.ws_3cx = ws_3cx;
  }

  updateAccessToken(newAccessToken: string): void {
    this.access_token = newAccessToken;
  }

  updateAction(newAction: 'init' | 'active'): void {
    this.action = newAction;
  }

  create3cxWebSocketConnection(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!this.access_token) {
        reject(new Error('Access token is required to create 3CX WebSocket connection.'));
        return;
      }
      if (!WS_HOST_3CX) {
        reject(new Error('WebSocket host is required to create 3CX WebSocket connection.'));
        return;
      }

      // 如果已經有連接，先關閉舊連接
      if (this.ws_3cx && this.ws_3cx.readyState !== WebSocket.CLOSED) {
        this.disconnect3cxWebSocket().then(() => {
          this.createNewConnection(resolve, reject);
        }).catch(reject);
      } else {
        this.createNewConnection(resolve, reject);
      }
    });
  }

  private createNewConnection(resolve: () => void, reject: (error: Error) => void): void {
    try {
      this.ws_3cx = new WebSocket(WS_HOST_3CX!, {
        headers: {
          Authorization: `Bearer ${this.access_token}`
        }
      });

      // 連接成功
      this.ws_3cx.once('open', () => {
        logWithTimestamp('3CX WebSocket 連接成功');
        resolve();
      });

      // 連接錯誤
      this.ws_3cx.once('error', (error) => {
        errorWithTimestamp('3CX WebSocket 連接錯誤:', error);
        this.ws_3cx = null;
        reject(new Error(`WebSocket connection failed: ${error.message}`));
      });

      // 連接關閉
      this.ws_3cx.once('close', (code, reason) => {
        logWithTimestamp(`3CX WebSocket 連接關閉: ${code} - ${reason}`);
        this.ws_3cx = null;
      });

    } catch (error) {
      reject(new Error(`Failed to create WebSocket: ${error instanceof Error ? error.message : String(error)}`));
    }
  }

  disconnect3cxWebSocket(): Promise<void> {
    return new Promise((resolve) => {
      if (!this.ws_3cx) {
        // 如果 ws_3cx 已經是 null，直接返回
        resolve();
        return;
      }

      // 如果 WebSocket 已經是關閉狀態，直接清理並返回
      if (this.ws_3cx.readyState === WebSocket.CLOSED) {
        this.ws_3cx = null;
        resolve();
        return;
      }

      // 監聽 close 事件，確保連接完全關閉後再清理
      this.ws_3cx.once('close', () => {
        this.ws_3cx = null;
        resolve();
      });

      // 設置超時，避免永久等待
      const timeout = setTimeout(() => {
        if (this.ws_3cx) {
          warnWithTimestamp('WebSocket 關閉超時，強制清理連接');
          this.ws_3cx = null;
          resolve();
        }
      }, 5000); // 5秒超時

      // 關閉成功後清除超時
      this.ws_3cx.once('close', () => {
        clearTimeout(timeout);
      });

      // 關閉 WebSocket 連接
      try {
        this.ws_3cx.close();
      } catch (error) {
        errorWithTimestamp('關閉 WebSocket 時發生錯誤:', error);
        clearTimeout(timeout);
        this.ws_3cx = null;
        resolve();
      }
    });
  }

  // 新增：檢查連接狀態的方法
  isWebSocketConnected(): boolean {
    return this.ws_3cx?.readyState === WebSocket.OPEN;
  }

  // 新增：獲取連接狀態的方法
  getWebSocketState(): string {
    if (!this.ws_3cx) return 'DISCONNECTED';
    
    switch (this.ws_3cx.readyState) {
      case WebSocket.CONNECTING: return 'CONNECTING';
      case WebSocket.OPEN: return 'OPEN';
      case WebSocket.CLOSING: return 'CLOSING';
      case WebSocket.CLOSED: return 'CLOSED';
      default: return 'UNKNOWN';
    }
  }
}