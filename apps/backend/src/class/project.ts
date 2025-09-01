import { WebSocketServer } from "ws";
import dotenv from 'dotenv';
import { logWithTimestamp, warnWithTimestamp, errorWithTimestamp } from '../util/timestamp';
import { getCaller, makeCall } from '../services/api/callControl'
import { ProjectManager } from '../services/projectManager';
import { broadcastAllProjects } from '../components/broadcast';
import { WebSocketManager } from './webSocketManager';
import { TokenManager } from './tokenManager';

dotenv.config();

// Define the WebSocket host for 3CX
const WS_HOST_3CX = process.env.WS_HOST_3CX;

// 檢查必要的環境變數
if (!WS_HOST_3CX) {
  console.warn('警告: WS_HOST_3CX 環境變數未設定');
}

type Participants = {
    id: number,
    status: "Dialing" | "Connected",
    party_caller_name: string,
    party_dn: string,
    party_caller_id: string,
    device_id: string,
    party_dn_type: string,
    direct_control: boolean,
    callid: number,
    legid: number,
    dn: string
}

type Caller = {
  dn: string;
  type: string;
  devices: Array<{
    dn: string;
    device_id: string;
    user_agent: string;
  }>;
  participants: Array<Participants>;
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
  caller: Array<Caller> | null;
  agentQuantity: number | 0;
  private wsManager: WebSocketManager | null = null;
  private tokenManager: TokenManager;

  constructor(
    client_id: string,
    client_secret: string,
    callFlowId: string,
    projectId: string,
    action: 'init' | 'active',
    error: string | null = null,
    access_token: string | null = null,
    caller: Array<Caller> | null = null,
    agentQuantity: number | 0
  ) {
    this.grant_type = 'client_credentials';
    this.client_id = client_id;
    this.client_secret = client_secret;
    this.callFlowId = callFlowId;
    this.projectId = projectId;
    this.action = action;
    this.error = error;
    this.access_token = access_token;
    this.caller = caller;
    this.agentQuantity = agentQuantity;
    
    // 初始化 TokenManager
    this.tokenManager = new TokenManager(client_id, client_secret, projectId, access_token);
  }

  updateAccessToken(newAccessToken: string): void {
    this.access_token = newAccessToken;
    this.tokenManager.updateAccessToken(newAccessToken);
  }

  updateAction(newAction: 'init' | 'active'): void {
    this.action = newAction;
  }

  create3cxWebSocketConnection(broadcastWs?: WebSocketServer): Promise<void> {
    return new Promise(async (resolve, reject) => {
      if (!this.access_token) {
        reject(new Error('Access token is required to create 3CX WebSocket connection.'));
        return;
      }
      if (!WS_HOST_3CX) {
        reject(new Error('WebSocket host is required to create 3CX WebSocket connection.'));
        return;
      }

      try {
        // 如果已經有連接，先關閉舊連接
        if (this.wsManager) {
          await this.wsManager.disconnect();
        }

        // 創建新的 WebSocket 管理器
        this.wsManager = new WebSocketManager(
          {
            url: `${WS_HOST_3CX}/callcontrol/ws`,
            headers: {
              Authorization: `Bearer ${this.access_token}`
            },
            heartbeatInterval: 30000, // 30秒心跳
            reconnectDelay: 3000, // 3秒重連延遲
            maxReconnectAttempts: 5
          },
          {
            onOpen: async () => {
              logWithTimestamp('3CX WebSocket 連接成功');
              try {
                await this.outboundCall(broadcastWs);
              } catch (error) {
                errorWithTimestamp('初始化專案時發生錯誤:', error);
              }
            },
            onMessage: (data) => {
              this.handleWebSocketMessage(data);
            },
            onError: (error) => {
              errorWithTimestamp('3CX WebSocket 錯誤:', error);
            },
            onClose: (code, reason) => {
              logWithTimestamp(`3CX WebSocket 關閉: ${code} - ${reason}`);
            },
            onReconnect: async () => {
              logWithTimestamp('3CX WebSocket 重新連接成功，重新執行初始化');
              try {
                await this.outboundCall(broadcastWs);
              } catch (error) {
                errorWithTimestamp('重連後初始化專案時發生錯誤:', error);
              }
            }
          }
        );

        // 建立連接
        await this.wsManager.connect();
        resolve();
        
      } catch (error) {
        reject(error);
      }
    });
  }

  private handleWebSocketMessage(data: Buffer): void {
    try {
      // 將 Buffer 轉換為字符串
      const messageString = data.toString('utf8');
      
      // 嘗試解析 JSON
      const messageObject = JSON.parse(messageString);
      
      // 您可以根據事件類型進行不同的處理
      if (messageObject.event && messageObject.event.event_type) {
        // 根據不同的事件類型處理邏輯
        switch (messageObject.event.event_type) {
          case 0:
          case 1:
            logWithTimestamp(`狀態 ${messageObject.event.event_type}:`, messageObject.event);
            this.outboundCall();
            break; 
          default:
            logWithTimestamp('未知事件類型:', messageObject.event.event_type);
        }
      }
      
    } catch (error) {
      // 如果不是 JSON 格式，直接記錄原始數據
      logWithTimestamp('3CX WebSocket 收到非JSON訊息:', data.toString('utf8'));
      errorWithTimestamp('解析 WebSocket 訊息時發生錯誤:', error);
    }
  }

  private async outboundCall(broadcastWs?: WebSocketServer): Promise<void> {
    try {
      // 步驟一: 檢查專案狀態
      if (this.action !== 'init' && this.action !== 'active') {
        logWithTimestamp('專案狀態不符合外撥條件:', this.action);
        return;
      }
      
      // 步驟二: 檢查並刷新 access_token
      if (!this.access_token) {
        logWithTimestamp('當前專案缺少 access_token');
        return;
      }

      // 檢測 token 是否到期並自動刷新
      const tokenValid = await this.tokenManager.checkAndRefreshToken();
      if (!tokenValid) {
        errorWithTimestamp('無法獲得有效的 access_token，停止外撥流程');
        return;
      }

      // 同步更新當前實例的 token（如果 TokenManager 中的 token 被更新了）
      const currentToken = this.tokenManager.getAccessToken();
      if (currentToken && currentToken !== this.access_token) {
        this.access_token = currentToken;
        // Token 已更新，需要重新建立 WebSocket 連接
        await this.handleTokenUpdateWebSocketReconnect();
      }

      // 步驟三: 獲取並更新 caller 資訊
      await this.updateCallerInfo();

      // 步驟四: 廣播專案資訊
      if (broadcastWs) {
        await this.broadcastProjectInfo(broadcastWs);
      }

      // 步驟五: 執行外撥邏輯
      await this.executeOutboundCalls();

    } catch (error) {
      errorWithTimestamp('外撥流程發生錯誤:', error);
      throw error;
    }
  }

  private async updateCallerInfo(): Promise<void> {
    try {
      const caller = await getCaller(this.access_token!);
      if (!caller.success) {
        throw new Error(`獲取呼叫者資訊失敗: ${caller.error}`);
      }

      const callerInfo = caller.data;
      logWithTimestamp('呼叫者資訊:', callerInfo);

      // 更新當前專案實例的 caller 資訊
      this.caller = callerInfo;
      this.agentQuantity = callerInfo.length;

      // 同步更新到 Redis 暫存中
      await ProjectManager.updateProjectCaller(this.projectId, callerInfo);
      logWithTimestamp(`專案 ${this.projectId} 的 caller 資訊已更新到 Redis`);
      
    } catch (error) {
      errorWithTimestamp('更新 caller 資訊失敗:', error);
      throw error;
    }
  }

  private async broadcastProjectInfo(broadcastWs: WebSocketServer): Promise<void> {
    try {
      await broadcastAllProjects(broadcastWs);
    } catch (error) {
      errorWithTimestamp('廣播所有專案資訊失敗:', error);
      // 廣播失敗不應該阻止外撥流程，所以這裡不拋出錯誤
    }
  }

  private async executeOutboundCalls(): Promise<void> {
    // 檢查是否有分機
    if (!this.caller || this.caller.length === 0) {
      errorWithTimestamp('當前專案沒有分機');
      return;
    }

    // 遍歷所有分機進行外撥
    const callPromises = this.caller.map(caller => this.processCallerOutbound(caller));
    await Promise.allSettled(callPromises);
  }

  private async processCallerOutbound(caller: Caller): Promise<void> {
    try {
      // 檢查分機是否有設備
      if (!caller.devices || caller.devices.length === 0) {
        warnWithTimestamp(`分機 ${caller.dn} 沒有可用設備`);
        return;
      }

      const { dn, device_id } = caller.devices[0];
      const { participants } = caller;

      logWithTimestamp(`處理分機 ${dn} 的外撥邏輯`);
      console.log('當前分機的 participants:', participants);

      // 檢查分機是否空閒
      if (!participants || participants.length === 0) {
        logWithTimestamp(`分機 ${dn} 空閒，可以撥打電話`);
        // TODO: 這裡應該從名單中獲取下一個要撥打的號碼
        // 可以根據需要調整延遲時間，例如 2000ms (2秒)
        await this.makeOutboundCall(dn, device_id, "45", 2000);
      } else {
        warnWithTimestamp(`分機 ${dn} 已有通話中，無法撥打下一通電話`);
      }
    } catch (error) {
      errorWithTimestamp(`處理分機 ${caller.dn} 外撥時發生錯誤:`, error);
    }
  }

  private async makeOutboundCall(dn: string, deviceId: string, targetNumber: string, delayMs: number = 1000): Promise<void> {
    try {
      if (!this.access_token) {
        throw new Error('access_token 為空');
      }

      // 添加延遲
      logWithTimestamp(`等待 ${delayMs}ms 後撥打電話: ${dn} -> ${targetNumber}`);
      await this.delay(delayMs);

      await makeCall(this.access_token, dn, deviceId, "outbound", targetNumber);
      logWithTimestamp(`成功發起外撥: ${dn} -> ${targetNumber}`);
    } catch (error) {
      errorWithTimestamp(`外撥失敗 ${dn} -> ${targetNumber}:`, error);
      throw error;
    }
  }

  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * 處理 token 更新後的 WebSocket 重連
   */
  private async handleTokenUpdateWebSocketReconnect(): Promise<void> {
    if (this.wsManager && this.wsManager.isConnected() && this.access_token) {
      try {
        logWithTimestamp('Token 已更新，重新建立 WebSocket 連接');
        await this.wsManager.disconnect();
        
        // 重新創建 WebSocket 管理器，使用新的 token
        this.wsManager = new WebSocketManager(
          {
            url: `${WS_HOST_3CX}/callcontrol/ws`,
            headers: {
              Authorization: `Bearer ${this.access_token}`
            },
            heartbeatInterval: 30000,
            reconnectDelay: 3000,
            maxReconnectAttempts: 5
          },
          {
            onOpen: async () => {
              logWithTimestamp('3CX WebSocket 重新連接成功（token 更新後）');
            },
            onMessage: (data) => {
              this.handleWebSocketMessage(data);
            },
            onError: (error) => {
              errorWithTimestamp('3CX WebSocket 錯誤:', error);
            },
            onClose: (code, reason) => {
              logWithTimestamp(`3CX WebSocket 關閉: ${code} - ${reason}`);
            }
          }
        );
        
        await this.wsManager.connect();
      } catch (error) {
        errorWithTimestamp('Token 更新後重連 WebSocket 失敗:', error);
      }
    }
  }

  disconnect3cxWebSocket(): Promise<void> {
    if (this.wsManager) {
      return this.wsManager.disconnect();
    }
    return Promise.resolve();
  }

  // 檢查連接狀態的方法
  isWebSocketConnected(): boolean {
    return this.wsManager?.isConnected() ?? false;
  }

  // 獲取連接狀態的方法
  getWebSocketState(): string {
    return this.wsManager?.getState() ?? 'DISCONNECTED';
  }

  // Token 相關的便捷方法
  /**
   * 獲取 token 的剩餘有效時間（分鐘）
   */
  getTokenRemainingTime(): number {
    if (!this.access_token) return 0;
    return this.tokenManager.getTokenRemainingTime(this.access_token);
  }

  /**
   * 強制刷新 token
   */
  async forceRefreshToken(): Promise<boolean> {
    const result = await this.tokenManager.forceRefreshToken();
    if (result) {
      const newToken = this.tokenManager.getAccessToken();
      if (newToken) {
        this.access_token = newToken;
        await this.handleTokenUpdateWebSocketReconnect();
      }
    }
    return result;
  }

  /**
   * 檢查 token 是否即將過期
   */
  isTokenExpiringSoon(bufferMinutes: number = 5): boolean {
    if (!this.access_token) return true;
    return this.tokenManager.isTokenExpired(this.access_token, bufferMinutes);
  }
}