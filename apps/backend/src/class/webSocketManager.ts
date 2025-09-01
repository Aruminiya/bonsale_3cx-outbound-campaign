import { WebSocket } from "ws";
import { logWithTimestamp, warnWithTimestamp, errorWithTimestamp } from '../util/timestamp';

export interface WebSocketManagerOptions {
  url: string;
  headers?: Record<string, string>;
  heartbeatInterval?: number; // 心跳間隔，預設30秒
  reconnectDelay?: number; // 重連延遲，預設3秒
  maxReconnectAttempts?: number; // 最大重連次數，預設5次
}

export interface WebSocketManagerCallbacks {
  onOpen?: () => void | Promise<void>;
  onMessage?: (data: Buffer) => void;
  onError?: (error: Error) => void;
  onClose?: (code: number, reason: Buffer) => void;
  onReconnect?: () => void | Promise<void>;
}

export class WebSocketManager {
  private ws: WebSocket | null = null;
  private heartbeatInterval: NodeJS.Timeout | null = null;
  private lastMessageTime: number = Date.now();
  private isReconnecting: boolean = false;
  private reconnectAttempts: number = 0;
  
  private readonly options: WebSocketManagerOptions & {
    heartbeatInterval: number;
    reconnectDelay: number;
    maxReconnectAttempts: number;
  };
  private readonly callbacks: WebSocketManagerCallbacks;

  constructor(options: WebSocketManagerOptions, callbacks: WebSocketManagerCallbacks = {}) {
    this.options = {
      heartbeatInterval: 30000, // 30秒
      reconnectDelay: 3000, // 3秒
      maxReconnectAttempts: 5,
      headers: {},
      ...options
    };
    this.callbacks = callbacks;
  }

  async connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      try {
        logWithTimestamp(`嘗試連接到 WebSocket: ${this.options.url}`);
        
        this.ws = new WebSocket(this.options.url, {
          headers: this.options.headers
        });

        this.ws.once('open', async () => {
          logWithTimestamp('WebSocket 連接成功');
          this.lastMessageTime = Date.now();
          this.reconnectAttempts = 0;
          
          // 啟動心跳機制
          this.setupHeartbeat();

          try {
            if (this.callbacks.onOpen) {
              await this.callbacks.onOpen();
            }
            resolve();
          } catch (error) {
            errorWithTimestamp('執行 onOpen 回調時發生錯誤:', error);
            resolve(); // 即使回調失敗，連接仍然有效
          }
        });

        // 處理pong回應
        this.ws.on('pong', () => {
          logWithTimestamp('收到心跳pong回應');
          this.lastMessageTime = Date.now();
        });

        // 處理訊息
        this.ws.on('message', (data: Buffer) => {
          this.lastMessageTime = Date.now();
          
          if (this.callbacks.onMessage) {
            this.callbacks.onMessage(data);
          }
        });

        // 處理錯誤
        this.ws.once('error', (error) => {
          errorWithTimestamp('WebSocket 連接錯誤:', error);
          this.clearHeartbeat();
          this.ws = null;
          
          if (this.callbacks.onError) {
            this.callbacks.onError(error);
          }
          
          // 如果不是在重連過程中，就嘗試重連
          if (!this.isReconnecting) {
            this.handleConnectionLost();
          } else {
            reject(new Error(`WebSocket connection failed: ${error.message}`));
          }
        });

        // 處理關閉
        this.ws.once('close', (code, reason) => {
          logWithTimestamp(`WebSocket 連接關閉: ${code} - ${reason}`);
          this.clearHeartbeat();
          this.ws = null;
          
          if (this.callbacks.onClose) {
            this.callbacks.onClose(code, reason);
          }
          
          // 如果是異常關閉（1006）且不是正在重連，則嘗試重連
          if (code === 1006 && !this.isReconnecting) {
            warnWithTimestamp('檢測到異常關閉（1006），將嘗試重新連接');
            this.handleConnectionLost();
          }
        });

      } catch (error) {
        this.clearHeartbeat();
        reject(new Error(`Failed to create WebSocket: ${error instanceof Error ? error.message : String(error)}`));
      }
    });
  }

  async disconnect(): Promise<void> {
    return new Promise((resolve) => {
      // 清除心跳機制
      this.clearHeartbeat();
      this.isReconnecting = false;
      this.reconnectAttempts = 0;

      if (!this.ws) {
        resolve();
        return;
      }

      if (this.ws.readyState === WebSocket.CLOSED) {
        this.ws = null;
        resolve();
        return;
      }

      this.ws.once('close', () => {
        this.ws = null;
        resolve();
      });

      const timeout = setTimeout(() => {
        if (this.ws) {
          warnWithTimestamp('WebSocket 關閉超時，強制清理連接');
          this.ws = null;
          resolve();
        }
      }, 5000);

      this.ws.once('close', () => {
        clearTimeout(timeout);
      });

      try {
        this.ws.close(1000, 'Normal closure');
      } catch (error) {
        errorWithTimestamp('關閉 WebSocket 時發生錯誤:', error);
        clearTimeout(timeout);
        this.ws = null;
        resolve();
      }
    });
  }

  isConnected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  getState(): string {
    if (!this.ws) return 'DISCONNECTED';
    
    switch (this.ws.readyState) {
      case WebSocket.CONNECTING: return 'CONNECTING';
      case WebSocket.OPEN: return 'OPEN';
      case WebSocket.CLOSING: return 'CLOSING';
      case WebSocket.CLOSED: return 'CLOSED';
      default: return 'UNKNOWN';
    }
  }

  send(data: string | Buffer): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(data);
    } else {
      throw new Error('WebSocket 連接不可用');
    }
  }

  private setupHeartbeat(): void {
    this.clearHeartbeat();

    this.heartbeatInterval = setInterval(() => {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        try {
          this.ws.ping();
          logWithTimestamp('發送心跳ping保持連接');
        } catch (error) {
          errorWithTimestamp('發送ping失敗:', error);
          this.handleConnectionLost();
        }
      } else {
        logWithTimestamp('WebSocket連接不可用，停止心跳');
        this.clearHeartbeat();
      }
    }, this.options.heartbeatInterval);
  }

  private clearHeartbeat(): void {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
  }

  private handleConnectionLost(): void {
    if (this.isReconnecting) return;
    
    if (this.reconnectAttempts >= this.options.maxReconnectAttempts) {
      errorWithTimestamp('達到最大重連次數，停止重連');
      return;
    }

    this.isReconnecting = true;
    this.reconnectAttempts++;
    
    warnWithTimestamp(`檢測到連接中斷，第 ${this.reconnectAttempts} 次重連嘗試`);
    this.clearHeartbeat();
    
    // 指數退避重連延遲
    const backoffDelay = Math.min(
      this.options.reconnectDelay * Math.pow(2, this.reconnectAttempts - 1),
      30000 // 最大30秒
    );
    
    setTimeout(() => {
      this.reconnectWebSocket();
    }, backoffDelay);
  }

  private async reconnectWebSocket(): Promise<void> {
    try {
      logWithTimestamp('嘗試重新連接 WebSocket...');
      
      // 先確保舊連接完全關閉
      if (this.ws) {
        await this.disconnect();
      }
      
      // 重新建立連接
      await this.connect();
      
      logWithTimestamp('WebSocket 重新連接成功');
      this.isReconnecting = false;
      
      // 執行重連回調
      if (this.callbacks.onReconnect) {
        try {
          await this.callbacks.onReconnect();
        } catch (error) {
          errorWithTimestamp('執行重連回調時發生錯誤:', error);
        }
      }
      
    } catch (error) {
      errorWithTimestamp('重新連接失敗:', error);
      this.isReconnecting = false;
      this.handleConnectionLost(); // 再次嘗試
    }
  }
}
