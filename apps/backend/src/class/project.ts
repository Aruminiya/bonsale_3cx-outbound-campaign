import { WebSocketServer } from "ws";
import dotenv from 'dotenv';
import { throttle, type DebouncedFunc } from 'lodash';
import { logWithTimestamp, warnWithTimestamp, errorWithTimestamp } from '../util/timestamp';
import { getCaller, makeCall, get3cxToken } from '../services/api/callControl'
import { ProjectManager } from '../services/projectManager';
import { broadcastAllProjects } from '../components/broadcast';
import { WebSocketManager } from './webSocketManager';
import { TokenManager } from './tokenManager';
import { CallListManager } from './callListManager';
import { getOutbound } from '../services/api/bonsale';
import { Outbound } from '../types/bonsale/getOutbound';

dotenv.config();

// Define the WebSocket host for 3CX
const WS_HOST_3CX = process.env.WS_HOST_3CX;

// 檢查必要的環境變數
if (!WS_HOST_3CX) {
  console.warn('警告: WS_HOST_3CX 環境變數未設定');
}

// 定義撥打記錄的類型
type ToCallRecord = {
  customerId: string;
  memberName: string;
  phone: string;
  status: "Dialing" | "Connected";
  projectId: string;
  dn?: string; // 撥打的分機號碼
  dialTime?: string; // 撥打時間
} | null;

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
  state: 'active' | 'stop';
  error: string | null;
  access_token: string | null;
  caller: Array<Caller> | null;
  currentToCall: Array<ToCallRecord> = []; // 保存當前撥打記錄
  agentQuantity: number | 0;
  private previousToCall: Array<ToCallRecord> | null = null; // 保存前一筆撥打記錄
  private wsManager: WebSocketManager | null = null;
  private tokenManager: TokenManager;
  private throttledMessageHandler: DebouncedFunc<(broadcastWs: WebSocketServer, data: Buffer) => Promise<void>> | null = null;

  /**
   * Project 類別構造函數
   * @param client_id 3CX 客戶端 ID
   * @param client_secret 3CX 客戶端密鑰
   * @param callFlowId 呼叫流程 ID
   * @param projectId 專案 ID
   * @param state 專案狀態 ('active' | 'stop')
   * @param error 錯誤訊息
   * @param access_token 存取權杖
   * @param caller 呼叫者資訊陣列
   * @param agentQuantity 分機數量
   */
  constructor(
    client_id: string,
    client_secret: string,
    callFlowId: string,
    projectId: string,
    state:  'active' | 'stop',
    error: string | null = null,
    access_token: string | null = null,
    caller: Array<Caller> | null = null,
    currentToCall: Array<ToCallRecord> = [],
    agentQuantity: number | 0
  ) {
    this.grant_type = 'client_credentials';
    this.client_id = client_id;
    this.client_secret = client_secret;
    this.callFlowId = callFlowId;
    this.projectId = projectId;
    this.state = state;
    this.error = error;
    this.access_token = access_token;
    this.caller = caller;
    this.currentToCall = currentToCall;
    this.agentQuantity = agentQuantity;
    
    // 初始化 TokenManager
    this.tokenManager = new TokenManager(client_id, client_secret, projectId, access_token);
    
    // 初始化 throttled WebSocket 訊息處理器 (1000ms 內最多執行一次)
    this.throttledMessageHandler = throttle(this.processWebSocketMessage.bind(this), 1000, {
      leading: false,  // 第一次不立即執行
      trailing: true // 在等待期結束後執行
    });
  }

  /**
   * 初始化外撥專案（靜態方法）
   * @param projectData 專案資料
   * @returns Project 實例
   */
  static async initOutboundProject(projectData: {
    projectId: string;
    callFlowId: string;
    client_id: string;
    client_secret: string;
  }): Promise<Project> {
    const { projectId, callFlowId, client_id, client_secret } = projectData;

    try {
      // 檢查專案是否已存在
      const existingProject = await ProjectManager.getProject(projectId);
      if (existingProject) {
        logWithTimestamp(`專案 ${projectId} 已存在，更新 token 並返回實例`);
        
        // 使用 TokenManager 來刷新 token
        const refreshed = await existingProject.forceRefreshToken();
        if (!refreshed) {
          throw new Error(`Failed to refresh token for existing project ${projectId}`);
        }
        
        logWithTimestamp(`專案 ${projectId} token 已更新`);
        return existingProject;
      }

      // 創建新專案
      logWithTimestamp(`開始初始化新專案 ${projectId}`);
      
      // 獲取 access token
      const token = await get3cxToken(client_id, client_secret);
      if (!token.success) {
        throw new Error(`Failed to obtain access token: ${token.error?.error || 'Unknown error'}`);
      }
      
      const { access_token } = token.data;
      if (!access_token) {
        throw new Error('Failed to obtain access token: token is empty');
      }

      // 獲取呼叫者資訊
      const caller = await getCaller(access_token);
      if (!caller.success) {
        throw new Error('Failed to obtain caller information');
      }
      const callerData = caller.data;
      const agentQuantity = caller.data.length;

      // 創建專案實例
      const project = new Project(
        client_id,
        client_secret,
        callFlowId,
        projectId,
        'active',
        null,
        access_token,
        callerData,
        [],
        agentQuantity
      );

      // 儲存專案到 Redis
      await ProjectManager.saveProject(project);
      
      logWithTimestamp(`專案 ${projectId} 初始化完成並儲存到 Redis`);
      return project;
      
    } catch (error) {
      errorWithTimestamp(`初始化專案 ${projectId} 失敗:`, error);
      throw error;
    }
  }

  /**
   * 更新存取權杖
   * @param newAccessToken 新的存取權杖
   */
  updateAccessToken(newAccessToken: string): void {
    this.access_token = newAccessToken;
    this.tokenManager.updateAccessToken(newAccessToken);
  }

  /**
   * 更新專案狀態
   * @param newAction 新的專案狀態 ('active' | 'stop')
   */
  updateState(newState: 'active' | 'stop'): void {
    this.state = newState;
  }

  /**
   * 建立 3CX WebSocket 連接
   * @param broadcastWs 廣播 WebSocket 伺服器實例
   * @returns Promise<void>
   */
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
              // 生成測試撥號名單（agentQuantity 的 3 倍）
              await this.getBonsaleOutboundCallList();
              try {
                await this.outboundCall(broadcastWs);
              } catch (error) {
                errorWithTimestamp('初始化專案時發生錯誤:', error);
              }
            },
            onMessage: (data) => {
              if (broadcastWs) {
                this.handleWebSocketMessage(broadcastWs, data);
              }
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

  /**
   * 處理 WebSocket 訊息 (throttled 版本)
   * @param data 收到的訊息資料 (Buffer 格式)
   * @private
   */
  private async handleWebSocketMessage(broadcastWs: WebSocketServer, data: Buffer): Promise<void> {
    if (this.throttledMessageHandler) {
      const result = this.throttledMessageHandler(broadcastWs, data);
      if (result) {
        await result;
      }
    }
  }

  /**
   * 實際處理 WebSocket 訊息的邏輯
   * @param broadcastWs WebSocket 伺服器實例
   * @param data 收到的訊息資料 (Buffer 格式)
   * @private
   */
  private async processWebSocketMessage(broadcastWs: WebSocketServer, data: Buffer): Promise<void> {
    try {
      // 將 Buffer 轉換為字符串
      const messageString = data.toString('utf8');
      
      // 嘗試解析 JSON
      const messageObject = JSON.parse(messageString);

      logWithTimestamp(`WebSocket 訊息處理 (throttled) - 事件類型: ${messageObject.event?.event_type}`);

      // 根據不同的事件類型處理邏輯
      switch (messageObject.event.event_type) {
        case 0:
        case 1:
          logWithTimestamp(`狀態 ${messageObject.event.event_type}:`, messageObject.event);

          // 如果專案狀態是 stop，檢查是否還有活躍通話
          if (this.state === 'stop') {
            await this.handleStopStateLogic(broadcastWs);
          } else {
            // 最後執行外撥邏輯
            await this.outboundCall(broadcastWs);
          }
          break; 
        default:
          logWithTimestamp('未知事件類型:', messageObject.event.event_type);
      }
      
    } catch (error) {
      // 如果不是 JSON 格式，直接記錄原始數據
      logWithTimestamp('3CX WebSocket 收到非JSON訊息:', data.toString('utf8'));
      errorWithTimestamp('解析 WebSocket 訊息時發生錯誤:', error);
    }
  }

  /**
   * 執行外撥邏輯
   * @param broadcastWs 廣播 WebSocket 伺服器實例
   * @param updateCaller 是否更新 caller 資訊，預設為 true
   * @private
   */
  private async outboundCall(broadcastWs?: WebSocketServer): Promise<void> {
    try {
      // 步驟一: 檢查專案狀態
      if (this.state !== 'active') {
        logWithTimestamp('專案狀態不符合外撥條件:', this.state);
        return;
      }
      
      // 步驟二: 檢查並刷新 access_token
      if (!this.access_token) {
        errorWithTimestamp('當前專案缺少 access_token');
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
        await this.handleTokenUpdateWebSocketReconnect(broadcastWs);
      }

      // 步驟三: 獲取並更新 caller 資訊
      await this.updateCallerInfo();

      // 步驟四: 更新當前撥打記錄的狀態
      await this.updateCurrentToCallStatus();

      // 步驟五: 廣播專案資訊
      if (broadcastWs) {
        await this.broadcastProjectInfo(broadcastWs);
      }

      // 步驟六: 執行外撥邏輯
      await this.executeOutboundCalls();

    } catch (error) {
      errorWithTimestamp('外撥流程發生錯誤:', error);
      throw error;
    }
  }

  /**
   * 更新呼叫者資訊
   * @private
   */
  private async updateCallerInfo(): Promise<void> {
    try {
      // 獲取新的 caller 資訊
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

  /**
   * 更新當前撥打記錄的狀態
   * @private
   */
  private async updateCurrentToCallStatus(): Promise<void> {
    try {
      if (!this.currentToCall || !this.caller) {
        return;
      }

      let hasUpdate = false;

      // 遍歷所有當前撥打記錄
      for (let i = 0; i < this.currentToCall.length; i++) {
        const currentCall = this.currentToCall[i];
        if (!currentCall || !currentCall.dn) continue;

        // 找到對應的分機資訊
        const callerInfo = this.caller.find(caller => caller.dn === currentCall.dn);
        
        if (callerInfo && callerInfo.participants && callerInfo.participants.length > 0) {
          const participant = callerInfo.participants[0];
          const newStatus = participant.status;
          
          // 如果狀態有變化，更新
          if (currentCall.status !== newStatus) {
            const oldStatus = currentCall.status;
            this.currentToCall[i] = { ...currentCall, status: newStatus };
            hasUpdate = true;
            
            logWithTimestamp(`撥打狀態更新 - 分機: ${currentCall.dn}, 客戶: ${currentCall.memberName}, 狀態: ${oldStatus} -> ${newStatus}`);
          }
        }
      }

      // 如果有任何更新，同步到 Redis
      if (hasUpdate) {
        await ProjectManager.updateProjectCurrentToCall(this.projectId, this.currentToCall);
      }
    } catch (error) {
      errorWithTimestamp('更新當前撥打記錄狀態失敗:', error);
      // 不拋出錯誤，避免影響主要流程
    }
  }

  /**
   * 廣播專案資訊
   * @param broadcastWs 廣播 WebSocket 伺服器實例
   * @private
   */
  private async broadcastProjectInfo(broadcastWs: WebSocketServer): Promise<void> {
    try {
      await broadcastAllProjects(broadcastWs);
    } catch (error) {
      errorWithTimestamp('廣播所有專案資訊失敗:', error);
      // 廣播失敗不應該阻止外撥流程，所以這裡不拋出錯誤
    }
  }

  /**
   * 執行外撥通話
   * @private
   */
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

  /**
   * 處理單一呼叫者的外撥邏輯
   * @param caller 呼叫者資訊
   * @private
   */
  private async processCallerOutbound(caller: Caller): Promise<void> {
    try {
      // 檢查分機是否有設備
      if (!caller.devices || caller.devices.length === 0) {
        warnWithTimestamp(`分機 ${caller.dn} 沒有可用設備`);
        return;
      }

      const { dn, device_id } = caller.devices[0];
      const { participants } = caller;

      // 檢查分機是否空閒
      if (!participants || participants.length === 0) {
        logWithTimestamp(`分機 ${dn} 空閒，可以撥打電話`);
        
        // 從 Redis 獲取下一個要撥打的電話號碼
        const nextCallItem = await CallListManager.getNextCallItem(this.projectId);
        
        if (nextCallItem) {
          // 初始化陣列（如果需要）
          if (!this.currentToCall) {
            this.currentToCall = [];
          }
          if (!this.previousToCall) {
            this.previousToCall = [];
          }

          // 檢查該分機是否已有撥打記錄
          const existingCallIndex = this.currentToCall.findIndex(call => call?.dn === dn);
          
          if (existingCallIndex >= 0) {
            // 如果該分機已有撥打記錄，移動到 previousToCall
            const existingCall = this.currentToCall[existingCallIndex];
            if (existingCall) {
              // 更新 previousToCall 中該分機的記錄
              const prevCallIndex = this.previousToCall.findIndex(call => call?.dn === dn);
              if (prevCallIndex >= 0) {
                this.previousToCall[prevCallIndex] = { ...existingCall };
              } else {
                this.previousToCall.push({ ...existingCall });
              }
              logWithTimestamp(`保存分機 ${dn} 的前一筆撥打記錄 - 客戶: ${existingCall.memberName} (${existingCall.customerId})`);
            }
          }

          // 創建新的撥打記錄
          const newCallRecord: ToCallRecord = {
            customerId: nextCallItem.customerId,
            memberName: nextCallItem.memberName,
            phone: nextCallItem.phone,
            status: "Dialing", // 初始狀態為撥號中
            projectId: nextCallItem.projectId,
            dn: dn,
            dialTime: new Date().toISOString()
          };

          // 更新或添加當前撥打記錄
          if (existingCallIndex >= 0) {
            this.currentToCall[existingCallIndex] = newCallRecord;
          } else {
            this.currentToCall.push(newCallRecord);
          }
          
          // 同步更新到 Redis
          await ProjectManager.updateProjectCurrentToCall(this.projectId, this.currentToCall);
          
          // 有撥號名單，進行撥打
          logWithTimestamp(`準備撥打 - 客戶: ${nextCallItem.memberName} (${nextCallItem.customerId}), 電話: ${nextCallItem.phone}, 分機: ${dn}`);
          await this.makeOutboundCall(dn, device_id, nextCallItem.phone, 2000);
        } else {
          // 沒有撥號名單，記錄信息
          logWithTimestamp(`專案 ${this.projectId} 的撥號名單已空，分機 ${dn} 暫無可撥打號碼`);
        }
      } else {
        warnWithTimestamp(`分機 ${dn} 已有通話中，無法撥打下一通電話`);
      }
    } catch (error) {
      errorWithTimestamp(`處理分機 ${caller.dn} 外撥時發生錯誤:`, error);
    }
  }

  /**
   * 發起外撥通話
   * @param dn 分機號碼
   * @param deviceId 設備 ID
   * @param targetNumber 目標電話號碼
   * @param delayMs 延遲時間（毫秒），預設 1000ms
   * @private
   */
  private async makeOutboundCall(dn: string, deviceId: string, targetNumber: string, delayMs: number = 1000): Promise<void> {
    try {
      if (!this.access_token) {
        throw new Error('access_token 為空');
      }

      // 添加延遲
      logWithTimestamp(`等待 ${delayMs}ms 後撥打電話: ${dn} -> ${targetNumber}`);
      await this.delay(delayMs);

      // TODO 這邊之後要根據抓到的撥號狀態 去寫 Bonsale 紀錄 好讓名單可以正確執行
      if (this.previousToCall && this.previousToCall.length > 0) {
        // 找到該分機的前一筆撥打記錄
        const previousCallForThisExtension = this.previousToCall.find(call => call?.dn === dn);
        if (previousCallForThisExtension) {
          // 有該分機的前一筆撥打記錄，執行寫紀錄到 Bonsale 裡面
          await this.recordBonsaleCallResult(previousCallForThisExtension);
        }
      }

      await makeCall(this.access_token, dn, deviceId, "outbound", targetNumber);
      logWithTimestamp(`成功發起外撥: ${dn} -> ${targetNumber}`);
    } catch (error) {
      errorWithTimestamp(`外撥失敗 ${dn} -> ${targetNumber}:`, error);
      throw error;
    }
  }

  /**
   * 記錄 Bonsale 通話結果
   * @param previousToCallRecord 前一筆撥打記錄
   * @private
   */
  private async recordBonsaleCallResult(previousToCallRecord: {
    customerId: string;
    memberName: string;
    phone: string;
    projectId: string;
    dn?: string;
    dialTime?: string;
  }): Promise<void> {
    try {
      // TODO: 實作寫入 Bonsale 紀錄的邏輯
      // 這裡可以根據當前的 caller 狀態來判斷前一通電話的通話結果
      logWithTimestamp(`準備記錄 Bonsale 通話結果 - 客戶: ${previousToCallRecord.memberName} (${previousToCallRecord.customerId}), 分機: ${previousToCallRecord.dn}`);
      
      // 獲取該分機的當前狀態來判斷前一通電話的結果
      if (this.caller && previousToCallRecord.dn) {
        const callerInfo = this.caller.find(caller => caller.dn === previousToCallRecord.dn);
        
        if (callerInfo && callerInfo.participants && callerInfo.participants.length > 0) {
          const participant = callerInfo.participants[0];
          
          // 根據狀態判斷通話結果
          // "Dialing" - 正在撥號
          // "Connected" - 已接通
          // 可以根據需要添加更多邏輯
          switch (participant.status) {
            case "Dialing":
              logWithTimestamp(`分機 ${previousToCallRecord.dn} 狀態為撥號中，前一通電話記錄為未接通`);
              break;
            case "Connected":
              logWithTimestamp(`分機 ${previousToCallRecord.dn} 狀態為已接通，前一通電話記錄為已接通`);
              break;
            default:
              warnWithTimestamp(`分機 ${previousToCallRecord.dn} 狀態為未知，無法記錄前一通電話結果`);
          }
        } else {
          logWithTimestamp(`分機 ${previousToCallRecord.dn} 目前空閒，前一通電話已結束`);
        }
      }
      
    } catch (error) {
      errorWithTimestamp('記錄 Bonsale 通話結果失敗:', error);
      // 不拋出錯誤，避免影響主要的外撥流程
    }
  }

  /**
   * 從 Bonsale API 獲取外撥名單
   * @private
   */
  private async getBonsaleOutboundCallList(): Promise<void> {
    try {
      logWithTimestamp(`開始從 Bonsale API 獲取專案 ${this.projectId} 的撥號名單`);

      const limit = this.agentQuantity * 3;
      let outboundList: Array<Outbound> = [];

      // 第一輪: 取得 callStatus = 0 的名單（待撥打）
      logWithTimestamp(`第一輪：獲取 callStatus = 0 的名單，限制 ${limit} 筆`);
      const firstOutboundResult = await getOutbound(
        this.callFlowId,
        this.projectId,
        "0",
        limit
      );

      if (!firstOutboundResult.success) {
        errorWithTimestamp('第一輪獲取撥號名單失敗:', firstOutboundResult.error);
        return;
      }

      const firstOutboundData = firstOutboundResult.data;
      const firstList = firstOutboundData?.list || [];

      if (!firstList || firstList.length === 0) {
        // 第二輪: callStatus = 0 沒有待撥打名單，嘗試獲取 callStatus = 2 的名單
        logWithTimestamp(`第一輪無結果，第二輪：獲取 callStatus = 2 的名單`);
        
        const secondOutboundResult = await getOutbound(
          this.callFlowId,
          this.projectId,
          "2",
          limit
        );

        if (!secondOutboundResult.success) {
          errorWithTimestamp('第二輪獲取撥號名單失敗:', secondOutboundResult.error);
          return;
        }

        const secondOutboundData = secondOutboundResult.data;
        const secondList = secondOutboundData?.list || [];
        
        if (!secondList || secondList.length === 0) {
          warnWithTimestamp('兩輪搜尋都無結果，所有名單已撥打完畢');
          return;
        }
        
        outboundList = secondList;
        logWithTimestamp(`第二輪獲取到 ${secondList.length} 筆名單`);
      } else {
        outboundList = firstList;
        logWithTimestamp(`第一輪獲取到 ${firstList.length} 筆名單`);
      }

      // 驗證名單資料
      const validItems = outboundList.filter(item => 
        item.customerId && 
        item.customer?.phone && 
        item.customer.phone.trim() !== ''
      );

      if (validItems.length === 0) {
        warnWithTimestamp('所有獲取的名單都缺少必要資訊（customerId 或 phone）');
        return;
      }

      if (validItems.length < outboundList.length) {
        warnWithTimestamp(`過濾後剩餘 ${validItems.length}/${outboundList.length} 筆有效名單`);
      }

      // 批次處理撥號名單
      const addPromises = validItems.map(item => {
        const callListItem = new CallListManager(
          item.projectId,
          item.customerId,
          item.customer?.memberName || '未知客戶',
          item.customer?.phone || ''
        );
        return CallListManager.addCallListItem(callListItem);
      });

      const results = await Promise.allSettled(addPromises);
      
      // 統計結果
      const successCount = results.filter(result => 
        result.status === 'fulfilled' && result.value === true
      ).length;
      const failCount = results.length - successCount;

      logWithTimestamp(`✅ Bonsale 撥號名單處理完成 - 成功: ${successCount}, 失敗: ${failCount}`);
      
      if (failCount > 0) {
        warnWithTimestamp(`有 ${failCount} 筆資料添加失敗`);
        
        // 記錄失敗的詳細資訊（開發環境）
        const failedResults = results
          .map((result, index) => ({ result, index }))
          .filter(({ result }) => result.status === 'rejected')
          .slice(0, 3); // 只記錄前 3 個錯誤

        failedResults.forEach(({ result, index }) => {
          if (result.status === 'rejected') {
            errorWithTimestamp(`失敗項目 ${index + 1}:`, result.reason);
          }
        });
      }

    } catch (error) {
      errorWithTimestamp('處理 Bonsale 撥號名單失敗:', error);
    }
  }

  // /**
  //  * 生成測試撥號名單（備用方案）
  //  * 根據 agentQuantity 生成 3 倍數量的測試客戶資料
  //  * @private
  //  */
  // private async generateTestCallList(): Promise<void> {
  //   try {
  //     const testCustomerCount = this.agentQuantity * 3;
  //     logWithTimestamp(`開始為專案 ${this.projectId} 生成 ${testCustomerCount} 筆測試撥號名單`);

  //     // 台灣常見姓氏
  //     const surnames = ['陳', '林', '黃', '張', '李', '王', '吳', '劉', '蔡', '楊', '許', '鄭', '謝', '郭', '洪'];
  //     const names = ['志明', '春嬌', '小美', '大雄', '靜香', '胖虎', '小夫', '哆啦', '美玲', '雅婷', '怡君', '佳穎', '宗翰', '俊宏', '淑芬'];

  //     const addPromises = [];

  //     for (let i = 1; i <= testCustomerCount; i++) {
  //       // 隨機生成客戶資料
  //       const randomSurname = surnames[Math.floor(Math.random() * surnames.length)];
  //       const randomName = names[Math.floor(Math.random() * names.length)];
  //       const memberName = `${randomSurname}${randomName}`;
        
  //       // 生成台灣手機號碼格式 (09xxxxxxxx)
  //       const phoneNumber = `09${Math.floor(Math.random() * 100000000).toString().padStart(8, '0')}`;
        
  //       const customerId = `test_customer_${this.projectId}_${i.toString().padStart(3, '0')}`;

  //       // 創建撥號名單項目
  //       const callListItem = new CallListManager(
  //         this.projectId,
  //         customerId,
  //         memberName,
  //         phoneNumber
  //       );

  //       // 添加到批次處理陣列
  //       addPromises.push(CallListManager.addCallListItem(callListItem));
  //     }

  //     // 批次處理所有添加操作
  //     const results = await Promise.allSettled(addPromises);
      
  //     // 統計結果
  //     const successCount = results.filter(result => result.status === 'fulfilled' && result.value === true).length;
  //     const failCount = results.length - successCount;

  //     logWithTimestamp(`✅ 測試撥號名單生成完成 - 成功: ${successCount}, 失敗: ${failCount}`);
      
  //     if (failCount > 0) {
  //       warnWithTimestamp(`有 ${failCount} 筆測試資料添加失敗`);
  //     }

  //   } catch (error) {
  //     errorWithTimestamp('生成測試撥號名單失敗:', error);
  //     // 不拋出錯誤，避免影響主要的 WebSocket 連接流程
  //   }
  // }

  /**
   * 延遲執行
   * @param ms 延遲時間（毫秒）
   * @returns Promise<void>
   * @private
   */
  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * 檢查專案是否還有活躍的通話
   * @returns boolean - true 如果還有通話，false 如果沒有
   */
  hasActiveCalls(): boolean {
    if (!this.caller || this.caller.length === 0) {
      return false;
    }

    return this.caller.some(caller => 
      caller.participants && caller.participants.length > 0
    );
  }

  /**
   * 處理停止狀態下的邏輯
   * @param broadcastWs 廣播 WebSocket 伺服器實例
   * @private
   */
  private async handleStopStateLogic(broadcastWs: WebSocketServer): Promise<void> {
    try {
      // 更新 caller 資訊以獲取最新狀態
      await this.updateCallerInfo();
      
      // 廣播專案資訊（讓前端知道當前通話狀態）
      await this.broadcastProjectInfo(broadcastWs);
      
      // 檢查是否還有活躍通話
      if (!this.hasActiveCalls()) {
        logWithTimestamp(`專案 ${this.projectId} 已無活躍通話，執行完全停止`);

        // 故意延遲一秒 讓前端不要唐突消失撥打狀態
        setTimeout(async () => {
          await this.executeCompleteStop(broadcastWs);
        }, 1000);

      } else {
        logWithTimestamp(`專案 ${this.projectId} 仍有活躍通話，等待通話結束`);
      }
    } catch (error) {
      errorWithTimestamp(`處理停止狀態邏輯時發生錯誤:`, error);
    }
  }

  /**
   * 執行完全停止邏輯
   * @param broadcastWs 廣播 WebSocket 伺服器實例
   */
  async executeCompleteStop(broadcastWs: WebSocketServer): Promise<void> {
    try {
      // 斷開 WebSocket 連接
      await this.disconnect3cxWebSocket();
      
      // 從 Redis 移除專案
      await ProjectManager.removeProject(this.projectId);
      
      // 最後廣播一次更新
      await this.broadcastProjectInfo(broadcastWs);
      
      logWithTimestamp(`專案 ${this.projectId} 已完全停止並移除`);
    } catch (error) {
      errorWithTimestamp(`執行完全停止時發生錯誤:`, error);
    }
  }

  /**
   * 處理 token 更新後的 WebSocket 重連
   * @param broadcastWs 廣播 WebSocket 伺服器實例 (可選)
   * @private
   */
  private async handleTokenUpdateWebSocketReconnect(broadcastWs?: WebSocketServer): Promise<void> {
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
              if (broadcastWs) {
                this.handleWebSocketMessage(broadcastWs, data);
              }
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

  /**
   * 中斷 3CX WebSocket 連接
   * @returns Promise<void>
   */
  disconnect3cxWebSocket(): Promise<void> {
    if (this.wsManager) {
      return this.wsManager.disconnect();
    }
    return Promise.resolve();
  }

  // Token 相關的便捷方法
  /**
   * 獲取 token 的剩餘有效時間（分鐘）
   * @returns number - 剩餘時間（分鐘）
   */
  getTokenRemainingTime(): number {
    if (!this.access_token) return 0;
    return this.tokenManager.getTokenRemainingTime(this.access_token);
  }

  /**
   * 強制刷新 token
   * @returns Promise<boolean> - true 如果刷新成功，false 如果失敗
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
   * @param bufferMinutes 緩衝時間（分鐘），預設 5 分鐘
   * @returns boolean - true 如果即將過期，false 如果仍有效
   */
  isTokenExpiringSoon(bufferMinutes: number = 5): boolean {
    if (!this.access_token) return true;
    return this.tokenManager.isTokenExpired(this.access_token, bufferMinutes);
  }

  /**
   * 停止外撥專案（靜態方法）
   * @param projectData 專案資料
   * @param activeProjects 活躍專案實例映射
   * @param ws WebSocket服務器實例（用於廣播）
   * @returns Promise<boolean> - true 如果成功停止，false 如果失敗
   */
  static async stopOutboundProject(
    projectData: { projectId: string },
    activeProjects: Map<string, Project>,
    ws: WebSocketServer
  ): Promise<boolean> {
    try {
      const { projectId } = projectData;
      
      // 找到正在運行的專案實例
      const runningProject = activeProjects.get(projectId);
      if (runningProject) {
        logWithTimestamp(`開始停止專案 ${projectId}`);
        
        // 更新專案狀態為 stop
        runningProject.updateState('stop');
        
        // 同步更新 Redis 中的狀態
        await ProjectManager.updateProjectAction(projectId, 'stop');
        
        // 檢查是否還有活躍通話
        if (!runningProject.hasActiveCalls()) {
          // 沒有活躍通話，立即執行完全停止
          logWithTimestamp(`專案 ${projectId} 無活躍通話，立即完全停止`);
          await runningProject.executeCompleteStop(ws);
          activeProjects.delete(projectId);
        } else {
          // 有活躍通話，等待通話結束
          logWithTimestamp(`專案 ${projectId} 有活躍通話，等待通話結束後自動停止`);
          // 廣播狀態更新
          await broadcastAllProjects(ws, projectId);
        }
      } else {
        // 如果沒有活躍實例，直接從 Redis 移除
        warnWithTimestamp(`未找到活躍的專案實例: ${projectId}，直接從 Redis 移除`);
        await ProjectManager.removeProject(projectId);
        await broadcastAllProjects(ws);
      }
      
      return true;
    } catch (error) {
      errorWithTimestamp('停止外撥專案失敗:', error);
      return false;
    }
  }
}