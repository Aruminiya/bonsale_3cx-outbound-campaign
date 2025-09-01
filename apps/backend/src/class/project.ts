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
          // 步驟一: 從 專案​ ​中​ 判斷 ​專案​的​狀態​
          if (this.action === 'init' || this.action === 'active') {
            logWithTimestamp('當前專案狀態為:', this.action);
            
            if (!this.access_token) {
              logWithTimestamp('當前專案缺少 access_token');
              resolve(); // 即使沒有 token 也要 resolve，讓 WebSocket 連接完成
              return;
            }

            if (this.action === 'init' || this.action === 'active') {
              const caller = await getCaller(this.access_token);
              if (!caller.success) {
                logWithTimestamp('獲取呼叫者資訊失敗:', caller.error);
                resolve(); // 即使獲取呼叫者資訊失敗，WebSocket 連接仍然有效
                return;
              }
              const callerInfo = caller.data;
              logWithTimestamp('呼叫者資訊:', callerInfo);

              // 更新當前專案實例的 caller 資訊
              this.caller = callerInfo;
              this.agentQuantity = callerInfo.length;

              // 同步更新到 Redis 暫存中
              try {
                await ProjectManager.updateProjectCaller(this.projectId, callerInfo);
                logWithTimestamp(`專案 ${this.projectId} 的 caller 資訊已更新到 Redis`);
              } catch (updateError) {
                errorWithTimestamp('更新 Redis 中的 caller 資訊失敗:', updateError);
              }
            }

            // 將全部專案廣播給所有連線中的 client
            if (broadcastWs) {             
              // 廣播所有專案的資訊 - 使用模組化函數
              try {
                await broadcastAllProjects(broadcastWs);
              } catch (broadcastError) {
                errorWithTimestamp('廣播所有專案資訊失敗:', broadcastError);
              }
            }

            // 步驟二: 遍歷專案​分機​資訊 查詢​有​無 participants ​資料
            if (!this.caller || this.caller.length === 0) {
              errorWithTimestamp('當前專案沒有分機');
              return;
            }
            this.caller.forEach(async (caller: Caller) => {
              // 步驟三: 抓到分機資訊進行 makeCall
              const { dn, device_id } = caller.devices[0]; // 取得第一個設備的資訊
              if (!this.access_token) {
                errorWithTimestamp('makeCall 時 access_token 為 null');
                return
              };
              logWithTimestamp(caller);
              // TODO 目前先單純測試撥打電話 之後要建構抓取名單撥打邏輯
              const { participants } = caller;
              console.log('當前分機的 participants:', participants);
              if (!participants || participants.length === 0) {
                logWithTimestamp('當前專案沒有參與者可以再撥打下一隻電話');
                await makeCall(this.access_token, dn, device_id, "outbound", "0902213273");
                return;
              } else {
                warnWithTimestamp('當前分機已有通話中，無法撥打下一通電話');
                return;
              }
            });
          }
          resolve(); // 成功完成初始化
        } catch (error) {
          errorWithTimestamp('初始化專案時發生錯誤:', error);
          // 可以選擇是否要 reject 或只是記錄錯誤但繼續
          resolve(); // 即使獲取呼叫者資訊失敗，WebSocket 連接仍然有效
          // 或者如果你認為這是致命錯誤：
          // reject(new Error(`Failed to initialize project: ${error instanceof Error ? error.message : String(error)}`));
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
              case 0:
                logWithTimestamp('狀態 1:', messageObject.event);
                break; 
              case 1:
                logWithTimestamp('狀態 2:', messageObject.event);
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