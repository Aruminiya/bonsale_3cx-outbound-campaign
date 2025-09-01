import { WebSocket, WebSocketServer } from "ws";
import dotenv from 'dotenv';
import { logWithTimestamp, warnWithTimestamp, errorWithTimestamp } from '../util/timestamp';
import { getCaller, makeCall } from '../services/api/callControl'
import { ProjectManager } from '../services/projectManager';
import { broadcastAllProjects } from '../components/broadcast';

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
  ws_3cx: WebSocket | null;

  constructor(
    client_id: string,
    client_secret: string,
    callFlowId: string,
    projectId: string,
    action: 'init' | 'active',
    error: string | null = null,
    access_token: string | null = null,
    caller: Array<Caller> | null = null,
    agentQuantity: number | 0,
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
    this.caller = caller;
    this.agentQuantity = agentQuantity;
    this.ws_3cx = ws_3cx;
  }

  updateAccessToken(newAccessToken: string): void {
    this.access_token = newAccessToken;
  }

  updateAction(newAction: 'init' | 'active'): void {
    this.action = newAction;
  }

  create3cxWebSocketConnection(broadcastWs?: WebSocketServer): Promise<void> {
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
          this.createNewConnection(resolve, reject, broadcastWs);
        }).catch(reject);
      } else {
        this.createNewConnection(resolve, reject, broadcastWs);
      }
    });
  }

  private async outboundCall(broadcastWs?: WebSocketServer): Promise<void> {
    try {
      // 步驟一: 檢查專案狀態
      if (this.action !== 'init' && this.action !== 'active') {
        logWithTimestamp('專案狀態不符合外撥條件:', this.action);
        return;
      }

      logWithTimestamp('當前專案狀態為:', this.action);
      
      // 步驟二: 檢查 access_token
      if (!this.access_token) {
        logWithTimestamp('當前專案缺少 access_token');
        return;
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
        await this.makeOutboundCall(dn, device_id, "0902213273");
      } else {
        warnWithTimestamp(`分機 ${dn} 已有通話中，無法撥打下一通電話`);
      }
    } catch (error) {
      errorWithTimestamp(`處理分機 ${caller.dn} 外撥時發生錯誤:`, error);
    }
  }

  private async makeOutboundCall(dn: string, deviceId: string, targetNumber: string): Promise<void> {
    try {
      if (!this.access_token) {
        throw new Error('access_token 為空');
      }

      await makeCall(this.access_token, dn, deviceId, "outbound", targetNumber);
      logWithTimestamp(`成功發起外撥: ${dn} -> ${targetNumber}`);
    } catch (error) {
      errorWithTimestamp(`外撥失敗 ${dn} -> ${targetNumber}:`, error);
      throw error;
    }
  }

  private createNewConnection(resolve: () => void, reject: (error: Error) => void, broadcastWs?: WebSocketServer): void {
    try {
      this.ws_3cx = new WebSocket(`${WS_HOST_3CX}/callcontrol/ws`, {
        headers: {
          Authorization: `Bearer ${this.access_token}`
        }
      });

      // 連接成功
      this.ws_3cx.once('open', async () => {
        logWithTimestamp('3CX WebSocket 連接成功');

        try {
          // 執行外撥邏輯
          await this.outboundCall(broadcastWs);
          resolve(); // 成功完成初始化
        } catch (error) {
          errorWithTimestamp('初始化專案時發生錯誤:', error);
          resolve(); // 即使外撥失敗，WebSocket 連接仍然有效
        }
      });

      // ws_3cx 回傳訊息
      this.ws_3cx.on('message', (data) => {
        try {
          // 將 Buffer 轉換為字符串
          const messageString = data.toString('utf8');
          
          // 嘗試解析 JSON
          const messageObject = JSON.parse(messageString);
          
          // logWithTimestamp('3CX WebSocket 收到訊息 (解析後):', messageObject);
          
          // 您可以根據事件類型進行不同的處理
          if (messageObject.event && messageObject.event.event_type) {
            // logWithTimestamp('事件類型:', messageObject.event.event_type);
            
            // 根據不同的事件類型處理邏輯
            switch (messageObject.event.event_type) {
              case 0 | 1:
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