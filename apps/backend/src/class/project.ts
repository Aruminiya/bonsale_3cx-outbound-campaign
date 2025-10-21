import { WebSocketServer } from "ws";
import dotenv from 'dotenv';
import { throttle, type DebouncedFunc } from 'lodash';
import { Mutex } from 'async-mutex';
import { logWithTimestamp, warnWithTimestamp, errorWithTimestamp } from '../util/timestamp';
import { getCaller, makeCall, get3cxToken, getParticipant } from '../services/api/callControl'
import { ProjectManager } from '../class/projectManager';
import { broadcastAllProjects } from '../components/broadcast';
import { WebSocketManager } from './webSocketManager';
import { TokenManager } from './tokenManager';
import { CallListManager } from './callListManager';
import { getOutbound, updateCallStatus, updateDialUpdate, updateVisitRecord, updateBonsaleProjectAutoDialExecute } from '../services/api/bonsale';
import { getUsers } from '../services/api/xApi';
import { Outbound } from '../types/bonsale/getOutbound';
import { post9000Dummy, post9000 } from '../services/api/insertOverdueMessageForAi';
import { isTodayInSchedule } from '../util/iCalendar';

dotenv.config();

// Define the WebSocket host for 3CX
const WS_HOST_3CX = process.env.WS_HOST_3CX;

// 檢查必要的環境變數
if (!WS_HOST_3CX) {
  console.warn('警告: WS_HOST_3CX 環境變數未設定');
}

// 定義撥打記錄的類型
type CallRecord = {
  customerId: string;
  memberName: string;
  phone: string;
  description: string | null;
  description2: string | null;
  status: "Dialing" | "Connected";
  projectId: string;
  dn: string; // 撥打的分機號碼
  dialTime: string; // 撥打時間
} | null;

type CallRestriction = {
  id: string;
  projectAutoDialId: string;
  startTime: string;
  stopTime: string;
  createdAt: string;
  createdUserId: string;
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

type WsMessageObject = {
  sequence: number;
  event: {
    event_type: 0 | 1; // 0: 有通話事件, 1: 通話事件發生變化 （ 接聽 掛斷等等 ）
    entity: string; // 這會是一個 3CX API 端點 /callcontrol/45/participants/17
    attached_data: unknown | null;
  }
}

export default class Project {
  grant_type: string;
  client_id: string;
  client_secret: string;
  callFlowId: string;
  projectId: string;
  state: 'active' | 'stop';
  info: string | null = null;
  warning: string | null = null;
  error: string | null = null;
  access_token: string | null;
  caller: Array<Caller> | null;
  latestCallRecord: Array<CallRecord> = []; // 保存當前撥打記錄
  agentQuantity: number | 0;
  recurrence: string | null = null; // 🆕 新增 recurrence 屬性
  callRestriction: CallRestriction[] = []; // 🆕 新增 callRestriction 屬性
  private previousCallRecord: Array<CallRecord> | null = null; // 保存前一筆撥打記錄
  private wsManager: WebSocketManager | null = null;
  private tokenManager: TokenManager;
  private throttledMessageHandler: DebouncedFunc<(broadcastWs: WebSocketServer, data: Buffer) => Promise<void>> | null = null;
  // 🆕 為 outboundCall 方法添加 debounce
  private throttledOutboundCall: DebouncedFunc<(broadcastWs: WebSocketServer | undefined, eventEntity: string | null, isExecuteOutboundCalls?: boolean, isInitCall?: boolean) => Promise<void>> | null = null;
  private idleCheckTimer: NodeJS.Timeout | null = null; // 空閒檢查定時器
  private idleCheckInterval: number = 30000; // 當前檢查間隔（毫秒）
  private readonly minIdleCheckInterval: number = 30000; // 最小檢查間隔 30 秒
  private readonly maxIdleCheckInterval: number = 300000; // 最大檢查間隔 5 分鐘
  private readonly idleCheckBackoffFactor: number = 1.5; // 指數退避倍數
  private broadcastWsRef: WebSocketServer | undefined = undefined; // 保存 WebSocket 引用

  // 🆕 全域 Mutex - 保護 latestCallRecord 和 previousCallRecord 的原子性
  private readonly processCallerMutex: Mutex = new Mutex(); // 全域互斥鎖，確保只有一個分機能同時執行 processCallerOutbound

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
    info: string | null = null,
    warning: string | null = null,
    error: string | null = null,
    access_token: string | null = null,
    caller: Array<Caller> | null = null,
    latestCallRecord: Array<CallRecord> = [],
    agentQuantity: number | 0,
    recurrence: string | null = null,
    callRestriction: CallRestriction[] = []
  ) {
    this.grant_type = 'client_credentials';
    this.client_id = client_id;
    this.client_secret = client_secret;
    this.callFlowId = callFlowId;
    this.projectId = projectId;
    this.state = state;
    this.info = info;
    this.warning = warning;
    this.error = error;
    this.access_token = access_token;
    this.caller = caller;
    this.latestCallRecord = latestCallRecord;
    this.agentQuantity = agentQuantity;
    this.recurrence = recurrence;
    this.callRestriction = callRestriction;

    // 初始化 TokenManager
    this.tokenManager = new TokenManager(client_id, client_secret, projectId, access_token);

    // 初始化 throttled WebSocket 訊息處理器 (100ms 內最多執行一次)
    this.throttledMessageHandler = throttle(this.processWebSocketMessage.bind(this), 0, {
      leading: false,  // 第一次不立即執行
      trailing: true // 在等待期結束後執行
    });

    // 🆕 初始化 throttle outboundCall 方法 (300ms 內最多執行一次)
    this.throttledOutboundCall = throttle(this.outboundCall.bind(this), 300, {
      leading: false,   // 第一次不立即執行
      trailing: true  // 在等待期結束後執行
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
    recurrence: string | null;
    callRestriction: CallRestriction[];
  }): Promise<Project> {
    const { projectId, callFlowId, client_id, client_secret, recurrence, callRestriction } = projectData;

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
        null,
        null,
        access_token,
        callerData,
        [],
        agentQuantity,
        recurrence,
        callRestriction
      );

      // 儲存專案到 Redis
      await ProjectManager.saveProject(project);
      
      // 注意：分機狀態管理器現在在伺服器啟動時統一管理，不需要在每個專案中啟動
      
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
    // 注意：分機狀態管理器現在使用管理員 token 自動管理，不需要同步更新
  }

  /**
   * 設定廣播 WebSocket 引用
   * @param broadcastWs WebSocket 伺服器實例
   */
  setBroadcastWebSocket(broadcastWs: WebSocketServer): void {
    this.broadcastWsRef = broadcastWs;
  }

  /**
   * 更新專案狀態
   * @param newAction 新的專案狀態 ('active' | 'stop')
   */
  async updateState(newState: 'active' | 'stop'): Promise<void> {
    this.state = newState;
    
    try {
      // 同步更新到 Redis
      await ProjectManager.updateProjectAction(this.projectId, newState);
    } catch (error: unknown) {
      errorWithTimestamp(`更新專案狀態到 Redis 失敗:`, error);
    }
  }

  /**
   * 設定專案錯誤
   * @param errorMessage 錯誤訊息
   */
  async setError(errorMessage: string): Promise<void> {
    this.error = errorMessage;
    errorWithTimestamp(`專案 ${this.projectId} 發生錯誤: ${errorMessage}`);
    
    try {
      // 同步更新到 Redis
      await ProjectManager.updateProjectError(this.projectId, errorMessage);
      
      // 廣播錯誤給客戶端
      if (this.broadcastWsRef) {
        try {
          await broadcastAllProjects(this.broadcastWsRef, this.projectId);
          logWithTimestamp(`錯誤已廣播給客戶端 - 專案: ${this.projectId}`);
        } catch (broadcastError) {
          errorWithTimestamp(`廣播錯誤訊息失敗:`, broadcastError);
        }
      }
    } catch (error: unknown) {
      errorWithTimestamp(`更新專案錯誤到 Redis 失敗:`, error);
    }
  }

  /**
   * 清除專案錯誤
   */
  async clearError(): Promise<void> {
    if (this.error) {
      logWithTimestamp(`專案 ${this.projectId} 錯誤已解決，清除錯誤狀態`);
      this.error = null;
      
      try {
        // 同步更新到 Redis
        await ProjectManager.updateProjectError(this.projectId, null);
        
        // 廣播錯誤清除給客戶端
        if (this.broadcastWsRef) {
          try {
            await broadcastAllProjects(this.broadcastWsRef, this.projectId);
            logWithTimestamp(`錯誤清除已廣播給客戶端 - 專案: ${this.projectId}`);
          } catch (broadcastError) {
            errorWithTimestamp(`廣播錯誤清除訊息失敗:`, broadcastError);
          }
        }
      } catch (error: unknown) {
        errorWithTimestamp(`清除專案錯誤到 Redis 失敗:`, error);
      }
    }
  }

  /**
   * 設定專案資訊
   * @param infoMessage 資訊訊息
   */
  async setInfo(infoMessage: string): Promise<void> {
    this.info = infoMessage;
    logWithTimestamp(`專案 ${this.projectId} 資訊: ${infoMessage}`);
    
    try {
      // 同步更新到 Redis
      await ProjectManager.updateProjectInfo(this.projectId, infoMessage);
      
      // 廣播資訊給客戶端
      if (this.broadcastWsRef) {
        try {
          await broadcastAllProjects(this.broadcastWsRef, this.projectId);
          logWithTimestamp(`資訊已廣播給客戶端 - 專案: ${this.projectId}`);
        } catch (broadcastError) {
          errorWithTimestamp(`廣播資訊訊息失敗:`, broadcastError);
        }
      }
    } catch (error: unknown) {
      errorWithTimestamp(`更新專案資訊到 Redis 失敗:`, error);
    }
  }

  /**
   * 清除專案資訊
   */
  async clearInfo(): Promise<void> {
    if (this.info) {
      logWithTimestamp(`專案 ${this.projectId} 資訊已清除`);
      this.info = null;
      
      try {
        // 同步更新到 Redis
        await ProjectManager.updateProjectInfo(this.projectId, null);
        
        // 廣播資訊清除給客戶端
        if (this.broadcastWsRef) {
          try {
            await broadcastAllProjects(this.broadcastWsRef, this.projectId);
            logWithTimestamp(`資訊清除已廣播給客戶端 - 專案: ${this.projectId}`);
          } catch (broadcastError) {
            errorWithTimestamp(`廣播資訊清除訊息失敗:`, broadcastError);
          }
        }
      } catch (error: unknown) {
        errorWithTimestamp(`清除專案資訊到 Redis 失敗:`, error);
      }
    }
  }

  /**
   * 設定專案警告
   * @param warningMessage 警告訊息
   */
  async setWarning(warningMessage: string): Promise<void> {
    this.warning = warningMessage;
    logWithTimestamp(`專案 ${this.projectId} 警告: ${warningMessage}`);

    try {
      // 同步更新到 Redis
      await ProjectManager.updateProjectWarning(this.projectId, warningMessage);
      
      // 廣播警告給客戶端
      if (this.broadcastWsRef) {
        try {
          await broadcastAllProjects(this.broadcastWsRef, this.projectId);
          logWithTimestamp(`警告已廣播給客戶端 - 專案: ${this.projectId}`);
        } catch (broadcastError) {
          errorWithTimestamp(`廣播警告訊息失敗:`, broadcastError);
        }
      }
    } catch (error: unknown) {
      errorWithTimestamp(`更新專案警告到 Redis 失敗:`, error);
    }
  }

  /**
   * 清除專案警告
   */
  async clearWarning(): Promise<void> {
    if (this.warning) {
      logWithTimestamp(`專案 ${this.projectId} 警告已清除`);
      this.warning = null;
      
      try {
        // 同步更新到 Redis
        await ProjectManager.updateProjectWarning(this.projectId, null);
        
        // 廣播警告清除給客戶端
        if (this.broadcastWsRef) {
          try {
            await broadcastAllProjects(this.broadcastWsRef, this.projectId);
            logWithTimestamp(`警告清除已廣播給客戶端 - 專案: ${this.projectId}`);
          } catch (broadcastError) {
            errorWithTimestamp(`廣播警告清除訊息失敗:`, broadcastError);
          }
        }
      } catch (error: unknown) {
        errorWithTimestamp(`清除專案警告到 Redis 失敗:`, error);
      }
    }
  }

  /**
   * 清除專案錯誤 警告 資訊
   */
  async clearErrorWarningInfo(): Promise<void> {
    await Promise.all([
      this.clearError(),
      this.clearWarning(),
      this.clearInfo()
    ]);
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
        const wsConfig = this.createWebSocketManagerConfig(broadcastWs);
        this.wsManager = new WebSocketManager(wsConfig.connection, wsConfig.handlers);

        // 建立連接
        await this.wsManager.connect();
        
        resolve();
        
      } catch (error) {
        const errorMsg = `3CX WebSocket 連接失敗: ${error instanceof Error ? error.message : String(error)}`;
        await this.setError(errorMsg);
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
      const messageObject: WsMessageObject = JSON.parse(messageString);

      logWithTimestamp(`WebSocket 訊息處理 (throttled) - 事件類型: ${messageObject.event?.event_type}`);

      // 根據不同的事件類型處理邏輯
      const eventType = messageObject.event.event_type;
      const eventEntity = messageObject.event.entity;
      switch (eventType) {
        case 0:
          logWithTimestamp(`狀態 ${eventType}:`, messageObject.event);
          if (this.throttledOutboundCall) {
            // 使用 throttled 版本的 outboundCall
            await this.throttledOutboundCall(broadcastWs, eventEntity, false);
          }
          break;
        case 1:
          logWithTimestamp(`狀態 ${eventType}:`, messageObject.event);

          // 如果專案狀態是 stop，檢查是否還有活躍通話
          if (this.state === 'stop') {
            await this.handleStopStateLogic(broadcastWs);
          } else {
            await this.outboundCall(broadcastWs, eventEntity, true);
          }
          break; 
        default:
          logWithTimestamp('未知事件類型:', eventType);
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
  private async outboundCall(broadcastWs: WebSocketServer | undefined, eventEntity: string | null, isExecuteOutboundCalls: boolean = true, isInitCall: boolean = false): Promise<void> {
    try {
      logWithTimestamp('執行 outboundCall 方法', {
        eventEntity,
        isExecuteOutboundCalls,
        isInitCall
      });
      // 清除之前的資訊提示（如果有的話）
      await this.clearErrorWarningInfo();
      
      // 步驟一: 檢查專案狀態
      if (this.state !== 'active') {
        logWithTimestamp('專案狀態不符合外撥條件:', this.state);
        return;
      }
      
      // 步驟二: 檢查並刷新 access_token
      if (!this.access_token) {
        const errorMsg = '當前專案缺少 access_token';
        await this.setError(errorMsg);
        errorWithTimestamp(errorMsg);
        return;
      }

      // 檢測 token 是否到期並自動刷新
      const tokenValid = await this.tokenManager.checkAndRefreshToken();
      if (!tokenValid) {
        const errorMsg = '無法獲得有效的 access_token，停止外撥流程';
        await this.setError(errorMsg);
        errorWithTimestamp(errorMsg);
        return;
      }

      // 同步更新當前實例的 token（如果 TokenManager 中的 token 被更新了）
      const currentToken = this.tokenManager.getAccessToken();
      if (currentToken && currentToken !== this.access_token) {
        this.access_token = currentToken;
        // Token 已更新，需要重新建立 WebSocket 連接
        await this.handleTokenUpdateWebSocketReconnect(broadcastWs);
        // 注意：分機狀態管理器現在使用管理員 token 自動管理，不需要同步更新
      }
      
      // 步驟三: 獲取並更新 caller 資訊
      await this.updateCallerInfo();

      // 步驟四: 更新當前撥打記錄的狀態
      await this.updateLatestCallRecordStatus();

      // 步驟五: 廣播專案資訊
      if (broadcastWs) {
        await this.broadcastProjectInfo(broadcastWs);
      }
      
      // 步驟六: 執行外撥邏輯
      // 是否初始撥號
      if (isInitCall) {
        await this.executeOutboundCalls(eventEntity, true);
        return;
      }
      // 確認是否要撥號
      if (isExecuteOutboundCalls) {
        await this.executeOutboundCalls(eventEntity, false);
        return;
      }

    } catch (error) {
      const errorMsg = `外撥流程發生錯誤: ${error instanceof Error ? error.message : String(error)}`;
      await this.setError(errorMsg);
      errorWithTimestamp('外撥流程發生錯誤:', error);
      
      // 廣播更新的專案資訊（包含錯誤）
      if (broadcastWs) {
        try {
          await this.broadcastProjectInfo(broadcastWs);
        } catch (broadcastError) {
          errorWithTimestamp('廣播錯誤資訊失敗:', broadcastError);
        }
      }
      
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
  private async updateLatestCallRecordStatus(): Promise<void> {
    try {
      if (!this.latestCallRecord || !this.caller) {
        return;
      }

      let hasUpdate = false;

      // 遍歷所有當前撥打記錄
      for (let i = 0; i < this.latestCallRecord.length; i++) {
        const currentCall = this.latestCallRecord[i];
        if (!currentCall || !currentCall.dn) continue;

        // 找到對應的分機資訊
        const callerInfo = this.caller.find(caller => caller.dn === currentCall.dn);
        
        if (callerInfo && callerInfo.participants && callerInfo.participants.length > 0) {
          const participant = callerInfo.participants[0];
          const newStatus = participant.status;
          
          // 如果狀態有變化，更新
          if (currentCall.status !== newStatus) {
            const oldStatus = currentCall.status;
            this.latestCallRecord[i] = { ...currentCall, status: newStatus };
            hasUpdate = true;
            
            logWithTimestamp(`撥打狀態更新 - 分機: ${currentCall.dn}, 客戶: ${currentCall.memberName}, 狀態: ${oldStatus} -> ${newStatus}`);
          }
        }
      }

      // 如果有任何更新，同步到 Redis
      if (hasUpdate) {
        await ProjectManager.updateProjectLatestCallRecord(this.projectId, this.latestCallRecord);
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
  private async broadcastProjectInfo(broadcastWs?: WebSocketServer): Promise<void> {
      try {
        if (broadcastWs) {
          await broadcastAllProjects(broadcastWs);
        }
      } catch (error) {
        errorWithTimestamp('廣播所有專案資訊失敗:', error);
        // 廣播失敗不應該阻止外撥流程，所以這裡不拋出錯誤
      }
    }

  /**
   * 執行外撥通話
   * @private
   */
  private async executeOutboundCalls(eventEntity: string | null, isInitCall: boolean): Promise<void> {
    // 檢查是否有分機
    if (!this.caller || this.caller.length === 0) {
      errorWithTimestamp('當前專案沒有分機');
      return;
    }

    // 檢查是否有 recurrence 排程
    if (this.recurrence) {
      // TODO 跟 Victor 確認時區問題 決定前端要 UTC - 8
      // 所以我這邊就不用轉換 
      const isInSchedule = isTodayInSchedule(this.recurrence);
      if (!isInSchedule) {
        warnWithTimestamp(`今天不在 recurrence 排程內，跳過外撥`);
        this.setWarning('今天不在排程內，暫停外撥');
        return;
      }
    }

    // 檢查是否有 callRestriction 限制撥打時間
    if (this.callRestriction && this.callRestriction.length > 0) {
      // TODO 跟 Victor 確認時區問題 決定前端要 UTC - 8
      // 所以我這邊就不用轉換 
      const now = new Date();
      // // 將時間轉換為 UTC+8 (台北時間)
      now.setHours(now.getUTCHours() + 8);

      // 檢查當前時間是否在任何一個限制時間範圍內
      const isInRestrictedTime = this.callRestriction.some(restriction => {
        const startTime = new Date(now.getFullYear(), now.getMonth(), now.getDate(), Number(restriction.startTime.split(':')[0]), Number(restriction.startTime.split(':')[1]));
        const stopTime = new Date(now.getFullYear(), now.getMonth(), now.getDate(), Number(restriction.stopTime.split(':')[0]), Number(restriction.stopTime.split(':')[1]));
        return now >= startTime && now <= stopTime;
      })

      if (isInRestrictedTime) {
        warnWithTimestamp(`當前時間在限制撥打時間內，跳過外撥`);
        this.setWarning('當前時間在限制撥打時間內，暫停外撥');
        return;
      }
    }

    if (!this.access_token) {
      logWithTimestamp(`無效的 access_token，跳過分外撥`);
      this.setError('無效的 access_token，無法進行外撥');
      return;
    }

    // 檢查是否為初始撥號
    if (isInitCall) {
      logWithTimestamp(`初始撥號，開始對所有分機進行外撥檢查`);
      // 遍歷所有分機進行外撥 (使用 for 循環確保順序執行)
      // 只有最一開始的初始撥號 才能 使用 this.caller 來遍歷所有分機 
      // 之後的外撥事件 都是針對單一分機進行處理
      // 否則會導致競態競爭
      for (const caller of this.caller) {
        try {
          // 檢查代理人用戶是否忙碌
          if (!this.access_token) {
            logWithTimestamp(`無效的 access_token，跳過分機 ${caller.dn} 的外撥`);
            continue;
          }

          // 檢查是否有進行中的通話
          const participants = caller.participants;
          if (participants && participants.length > 0) {
            logWithTimestamp(`分機 ${caller.dn} 有 ${participants.length} 個通話中，跳過外撥`);
            continue;
          }
          
          const agentUser = await getUsers(this.access_token, caller.dn);
          if (!agentUser.success) {
            logWithTimestamp(`無法獲取分機 ${caller.dn} 的代理人用戶資訊，跳過外撥`);
            continue;
          }
          const CurrentProfileName = agentUser.data.value[0]?.CurrentProfileName;
          if (CurrentProfileName) {
            const isAgentUserBusy = CurrentProfileName !== "Available";
            if (isAgentUserBusy) {
              logWithTimestamp(`分機 ${caller.dn} 的代理人用戶忙碌，跳過外撥`);
              continue;
            }
          }
          
          // 代理人可用，執行外撥邏輯
          await this.processCallerOutbound(caller.dn, caller.devices[0].device_id);
          
          // 🆕 在處理下一個分機前添加延遲，給 API 和 WebSocket 一些反應時間
          const currentIndex = this.caller.indexOf(caller);
          if (currentIndex < this.caller.length - 1) {
            logWithTimestamp(`⏳ 處理完分機 ${caller.dn}，等待 1000ms 後處理下一個分機`);
            await this.delay(1000); // 1000ms 延遲
          }
          
        } catch (callerError) {
          errorWithTimestamp(`處理分機 ${caller.dn} 初始外撥時發生錯誤:`, callerError);
          // 繼續處理下一個分機
        }
      }
    } else {
      // 非初始撥號，只處理單一分機
      if (!eventEntity) {
        logWithTimestamp(`無效的事件實體，跳過外撥`);
        this.setError('無效的事件實體，無法進行外撥');
        return;
      }

      const participant = await getParticipant(this.access_token, eventEntity);
      if (!participant.success) {
        logWithTimestamp(`無法獲取事件實體 ${eventEntity} 這邊可能是對方掛斷了`);
        // 這邊可能是對方掛斷了
        // 解析 eventEntity 來獲取分機資訊
        const eventEntity_dn = eventEntity.split('/')[2]; // 格式固定為 /callcontrol/{dnnumber}/participants/{id}

        // 檢查代理人用戶是否空閒了
        // const callControls = await getCaller(this.access_token);
        // if (!callControls.success) {
        //   errorWithTimestamp(`無法獲取事件實體 ${eventEntity} 的呼叫控制資訊，跳過外撥`);
        //   this.setError(`無法獲取事件實體 ${eventEntity} 的呼叫控制資訊，跳過外撥`);
        //   return;
        // }
        const callControl = this.caller.find((caller: Caller) => caller.dn === eventEntity_dn);
        if (!callControl) {
          errorWithTimestamp(`無法在呼叫控制清單中找到分機 ${eventEntity_dn}，跳過外撥`);
          this.setError(`無法在呼叫控制清單中找到分機 ${eventEntity_dn}，跳過外撥`);
          return;
        }
        const participants = callControl.participants;
        if (participants && participants.length > 0) {
          warnWithTimestamp(`分機 ${eventEntity_dn} 仍有參與者，代理人用戶可能仍忙碌，跳過外撥`);
          this.setWarning(`分機 ${eventEntity_dn} 仍有參與者，代理人用戶可能仍忙碌，跳過外撥`);
          return;
        }
        
        // 檢查代理人用戶是否忙碌
        const agentUser = await getUsers(this.access_token, eventEntity_dn);
        if (!agentUser.success) {
          errorWithTimestamp(`無法獲取分機 ${eventEntity_dn} 的代理人用戶資訊，跳過外撥`);
          this.setError(`無法獲取分機 ${eventEntity_dn} 的代理人用戶資訊，跳過外撥`);
          return;
        }
        const CurrentProfileName = agentUser.data.value[0]?.CurrentProfileName;
        if (CurrentProfileName) {
          const isAgentUserBusy = CurrentProfileName !== "Available";
          if (isAgentUserBusy) {
            warnWithTimestamp(`分機 ${eventEntity_dn} 的代理人用戶忙碌，跳過外撥`);
            this.setWarning(`分機 ${eventEntity_dn} 的代理人用戶忙碌，跳過外撥`);
            return;
          }
        }

        // 代理人可用，執行外撥邏輯
        logWithTimestamp(`分機 ${eventEntity_dn} 的代理人用戶可用，繼續外撥流程`);
        const currentDeviceId = callControl.devices[0]?.device_id;
        await this.processCallerOutbound(eventEntity_dn, currentDeviceId);
      } else {
        logWithTimestamp(`成功獲取事件實體 ${eventEntity} 的參與者資訊:`, participant.data);
        if (!participant.data) {
          errorWithTimestamp(`參與者資料不完整, 無法進行外撥`);
          this.setError(`參與者資料不完整, 無法進行外撥`);
          return;
        }
      }
    }
  }

  /**
   * 處理單一呼叫者的外撥邏輯
   * 使用全域 Mutex 確保原子性，多個分機會排隊執行
   * @param dn 分機號碼
   * @param deviceId 設備 ID
   * @private
   */
  private async processCallerOutbound(dn: string, deviceId: string): Promise<void> {
    if (!dn || !deviceId) {
      errorWithTimestamp('分機或設備 ID 未定義，無法進行外撥處理');
      return;
    }
    // 🔒 使用全域 Mutex 保護整個臨界區段
    await this.processCallerMutex.runExclusive(async () => {
      logWithTimestamp(`🔒 分機 ${dn} 獲得 Mutex 鎖`);
      try {
        // 從 Redis 獲取下一個要撥打的電話號碼
        const nextCallItem = await CallListManager.getNextCallItem(this.projectId);

        // 檢查並補充撥號名單（如果數量不足）
        await this.checkAndReplenishCallList();

        // 有撥號名單，進行撥打
        if (nextCallItem) {
          // 初始化陣列（如果需要）
          if (!this.latestCallRecord) {
            this.latestCallRecord = [];
          }
          if (!this.previousCallRecord) {
            this.previousCallRecord = [];
          }

          // 檢查該分機是否已有撥打記錄
          const existingCallIndex = this.latestCallRecord.findIndex(call => call?.dn === dn);
          if (existingCallIndex >= 0) {
            // 如果該分機已有撥打記錄，移動到 previousCallRecord
            const existingCall = this.latestCallRecord[existingCallIndex];
            if (existingCall) {
              // 檢查 previousCallRecord 中是否已有該分機的舊記錄
              const prevCallIndex = this.previousCallRecord.findIndex(call => call?.dn === dn);

              // 如果已經有舊記錄，需要先處理它，避免被覆蓋而遺失
              if (prevCallIndex >= 0) {
                const oldRecord = this.previousCallRecord[prevCallIndex];
                if (oldRecord) {
                  logWithTimestamp(`⚠️ 偵測到分機 ${dn} 有未處理的舊記錄 - 客戶: ${oldRecord.memberName} (${oldRecord.customerId}), 立即處理以避免遺失`);

                  // try {
                  //   // 立即處理舊記錄
                  //   await this.recordBonsaleCallResult(oldRecord);
                  //   logWithTimestamp(`✅ 已處理分機 ${dn} 的舊記錄 - 客戶: ${oldRecord.memberName} (${oldRecord.customerId})`);
                  // } catch (error) {
                  //   errorWithTimestamp(`❌ 處理分機 ${dn} 的舊記錄時發生錯誤:`, error);
                  //   // 即使處理失敗，也繼續執行，避免阻塞流程
                  // }
                }

                // 然後用新記錄覆蓋
                this.previousCallRecord[prevCallIndex] = { ...existingCall };
              } else {
                // 沒有舊記錄，直接添加新記錄
                this.previousCallRecord.push({ ...existingCall });
              }

              logWithTimestamp(`保存分機 ${dn} 的前一筆撥打記錄 - 客戶: ${existingCall.memberName} (${existingCall.customerId})`);
            }
          }

          // 創建新的撥打記錄
          const newCallRecord: CallRecord = {
            customerId: nextCallItem.customerId,
            memberName: nextCallItem.memberName,
            phone: nextCallItem.phone,
            description: nextCallItem.description || null,
            description2: nextCallItem.description2 || null,
            status: "Dialing", // 初始狀態為撥號中
            projectId: nextCallItem.projectId,
            dn: dn,
            dialTime: new Date().toISOString()
          };

          // 更新或添加當前撥打記錄
          if (existingCallIndex >= 0) {
            this.latestCallRecord[existingCallIndex] = newCallRecord;
          } else {
            this.latestCallRecord.push(newCallRecord);
          }
          
          // 同步更新到 Redis
          await ProjectManager.updateProjectLatestCallRecord(this.projectId, this.latestCallRecord);
          
          // 有撥號名單，進行撥打
          logWithTimestamp(`準備撥打 - 客戶: ${nextCallItem.memberName} (${nextCallItem.customerId}), 電話: ${nextCallItem.phone}, 分機: ${dn}`);
          await this.makeOutboundCall(dn, deviceId, nextCallItem.phone, 2000);
        } else {
          // 沒有撥號名單，但要檢查該分機是否有當前撥打記錄需要處理
          logWithTimestamp(`專案 ${this.projectId} 的撥號名單已空，分機 ${dn} 暫無可撥打號碼`);
          
          // 初始化陣列（如果需要）
          if (!this.latestCallRecord) {
            this.latestCallRecord = [];
          }
          if (!this.previousCallRecord) {
            this.previousCallRecord = [];
          }

          // 檢查該分機是否有當前撥打記錄需要移動到 previousCallRecord
          const existingCallIndex = this.latestCallRecord.findIndex(call => call?.dn === dn);
          if (existingCallIndex >= 0) {
            const existingCall = this.latestCallRecord[existingCallIndex];
            if (existingCall) {
              // 檢查 previousCallRecord 中是否已有該分機的舊記錄
              const prevCallIndex = this.previousCallRecord.findIndex(call => call?.dn === dn);

              // 如果已經有舊記錄，需要先處理它，避免被覆蓋而遺失
              if (prevCallIndex >= 0) {
                const oldRecord = this.previousCallRecord[prevCallIndex];
                if (oldRecord) {
                  logWithTimestamp(`⚠️ 偵測到分機 ${dn} 有未處理的舊記錄 - 客戶: ${oldRecord.memberName} (${oldRecord.customerId}), 立即處理以避免遺失`);

                  // try {
                  //   // 立即處理舊記錄
                  //   await this.recordBonsaleCallResult(oldRecord);
                  //   logWithTimestamp(`✅ 已處理分機 ${dn} 的舊記錄 - 客戶: ${oldRecord.memberName} (${oldRecord.customerId})`);
                  // } catch (error) {
                  //   errorWithTimestamp(`❌ 處理分機 ${dn} 的舊記錄時發生錯誤:`, error);
                  //   // 即使處理失敗，也繼續執行，避免阻塞流程
                  // }
                }

                // 然後用新記錄覆蓋
                this.previousCallRecord[prevCallIndex] = { ...existingCall };
              } else {
                // 沒有舊記錄，直接添加新記錄
                this.previousCallRecord.push({ ...existingCall });
              }

              // 從 latestCallRecord 中移除
              this.latestCallRecord.splice(existingCallIndex, 1);

              // 同步更新到 Redis
              await ProjectManager.updateProjectLatestCallRecord(this.projectId, this.latestCallRecord);

              logWithTimestamp(`保存分機 ${dn} 的最後一筆撥打記錄到 previousCallRecord - 客戶: ${existingCall.memberName} (${existingCall.customerId})`);
            }
          }
          
          // 即使沒有撥號名單，也要呼叫 makeOutboundCall 來處理前一通電話的結果
          await this.makeOutboundCall(dn, deviceId, null, 2000);
        }
      } catch (error) {
        const errorMsg = `處理分機 ${dn} 外撥時發生錯誤: ${error instanceof Error ? error.message : String(error)}`;
        await this.setError(errorMsg);
        errorWithTimestamp(`處理分機 ${dn} 外撥時發生錯誤:`, error);
      } 
    });
  }

  /**
   * 發起外撥通話
   * @param dn 分機號碼
   * @param deviceId 設備 ID
   * @param targetNumber 目標電話號碼
   * @param delayMs 延遲時間（毫秒），預設 1000ms
   * @private
   */
  private async makeOutboundCall(dn: string, deviceId: string, targetNumber: string | null, delayMs: number = 1000): Promise<void> {
    try {
      if (!this.access_token) {
        throw new Error('access_token 為空');
      }

      // 添加延遲
      logWithTimestamp(`等待 ${delayMs}ms 後撥打電話: ${dn} -> ${targetNumber}`);
      await this.delay(delayMs);

      if (this.previousCallRecord && this.previousCallRecord.length > 0) {
        // 找到該分機的前一筆撥打記錄
        const previousCallIndex = this.previousCallRecord.findIndex(call => call?.dn === dn);
        if (previousCallIndex >= 0) {
          const previousCallForThisExtension = this.previousCallRecord[previousCallIndex];
          if (previousCallForThisExtension) {
            // 有該分機的前一筆撥打記錄，執行寫紀錄到 Bonsale 裡面
            logWithTimestamp(`處理分機 ${dn} 的前一筆撥打記錄 - 客戶: ${previousCallForThisExtension.memberName} (${previousCallForThisExtension.customerId})`);
            await this.recordBonsaleCallResult(previousCallForThisExtension);
            
            // 處理完成後，從 previousCallRecord 中移除該記錄，避免重複處理
            this.previousCallRecord.splice(previousCallIndex, 1);
            logWithTimestamp(`已移除分機 ${dn} 的已處理記錄，剩餘 previousCallRecord: ${this.previousCallRecord.length} 筆`);
          }
        }
      }
      if (!targetNumber) {
        logWithTimestamp(`分機 ${dn} 無撥號名單，跳過撥打`);
        return;
      }

      // 發起外撥
      await makeCall(this.access_token, dn, deviceId, "outbound", targetNumber);
      logWithTimestamp(`成功發起外撥: ${dn} -> ${targetNumber}`);
    } catch (error) {
      const errorMsg = `外撥失敗 ${dn} -> ${targetNumber}: ${error instanceof Error ? error.message : String(error)}`;
      await this.setError(errorMsg);
      errorWithTimestamp(`外撥失敗 ${dn} -> ${targetNumber}:`, error);
      throw error;
    }
  }

  /**
   * 統一的 API 錯誤處理方法
   * @param apiName API 名稱
   * @param result API 結果
   * @param shouldThrow 是否拋出錯誤，預設為 true
   * @private
   */
  private async handleApiError(apiName: string, result: { success: boolean; error?: { error?: string } }, shouldThrow: boolean = true): Promise<boolean> {
    if (!result.success) {
      const errorMsg = `${apiName} 失敗: ${result.error?.error || '未知錯誤'}`;
      await this.setError(errorMsg);
      errorWithTimestamp({ isForce: true }, `❌ ${apiName} 錯誤:`, {
        projectId: this.projectId,
        callFlowId: this.callFlowId,
        state: this.state,
        client_id: this.client_id,
        agentQuantity: this.agentQuantity,
        access_token: this.access_token ? '***已設置***' : '未設置',
        recurrence: this.recurrence,
        callRestriction: this.callRestriction,
        error: this.error,
        wsConnected: this.wsManager?.isConnected() || false,
        timestamp: new Date().toISOString(),
        errorMsg
      });
      errorWithTimestamp({ isForce: true }, errorMsg);
      
      if (shouldThrow) {
        throw new Error(errorMsg);
      }
      return false;
    }
    return true;
  }

  /**
   * 記錄 Bonsale 通話結果
   * @param previousCallRecord 前一筆撥打記錄
   * @private
   */
  private async recordBonsaleCallResult(previousCallRecord: CallRecord): Promise<void> {
    try {
      // 這裡可以根據當前的 caller 狀態來判斷前一通電話的通話結果
      if (!previousCallRecord) {
        warnWithTimestamp('沒有前一筆撥打記錄可供寫入 Bonsale');
        return;
      }
      logWithTimestamp(`準備記錄 Bonsale 通話結果 - 客戶: ${previousCallRecord.memberName} (${previousCallRecord.customerId}), 分機: ${previousCallRecord.dn}`);
      
      // 獲取該分機的當前狀態來判斷前一通電話的結果
      const { status } = previousCallRecord;
      // 根據狀態判斷通話結果
      // "Dialing" - 正在撥號
      // "Connected" - 已接通
      // 可以根據需要添加更多邏輯
      switch (status) {
        case "Dialing":
          logWithTimestamp(`分機 ${previousCallRecord.dn} 狀態為撥號中，前一通電話記錄為未接通`);
          try {
            const callStatusResult = await updateCallStatus(previousCallRecord.projectId, previousCallRecord.customerId, 2); // 2 表示未接通 更新 Bonsale 撥號狀態 失敗
            await this.handleApiError('updateCallStatus', callStatusResult);
            
            const dialUpdateResult = await updateDialUpdate(previousCallRecord.projectId, previousCallRecord.customerId); // 紀錄失敗​次​數 ​這樣​後端​的​抓取​失​敗​名​單才​能​記​次​數 給​我​指定​的​失敗​名​單
            await this.handleApiError('updateDialUpdate', dialUpdateResult);
            
            // 記錄完成後，移除使用過的撥號名單項目
            await CallListManager.removeUsedCallListItem(previousCallRecord.projectId, previousCallRecord.customerId);

            // 更新自動撥號執行狀態
            const autoDialResult1 = await updateBonsaleProjectAutoDialExecute(
              this.projectId,
              this.callFlowId,
            );
            await this.handleApiError('updateBonsaleProjectAutoDialExecute', autoDialResult1);
            
            // 針對 AI 外撥，呼叫 post9000 和 post9000Dummy API
            if ((!previousCallRecord.description || previousCallRecord.description.trim() === '')
               || (!previousCallRecord.description2 || previousCallRecord.description2.trim() === '')) {
              warnWithTimestamp(`分機 ${previousCallRecord.dn} 的前一筆撥打記錄沒有 description 或 description2 描述資訊`);
            } else {
              // 有描述資訊才呼叫 post9000 API 和 post9000Dummy API
              // 因為這是 21 世紀 需要 post9000 回去的紀錄 
              // post9000Dummy 是 PY 需要的紀錄

              logWithTimestamp(`分機 ${previousCallRecord.dn} 的前一筆撥打記錄有 description 和 description2 描述資訊`);

              // post9000 重試邏輯：最多嘗試 3 次
              let post9000Success = false;
              for (let tryPost9000Times = 1; tryPost9000Times <= 3; tryPost9000Times++) {
                try {
                  logWithTimestamp(`嘗試呼叫 post9000 (第 ${tryPost9000Times} 次)`);
                  const post9000Result = await post9000(previousCallRecord.description, previousCallRecord.description2, previousCallRecord.phone);
                  
                  if (post9000Result.success) {
                    logWithTimestamp({ isForce: true }, `✅ post9000 成功 (第 ${tryPost9000Times} 次嘗試): ${JSON.stringify(post9000Result.data)}`);
                    post9000Success = true;
                    break; // 成功後跳出重試迴圈
                  } else {
                    const errorMsg = `❌ post9000 失敗 (第 ${tryPost9000Times} 次): ${post9000Result.error?.error || '未知錯誤'}`;
                    errorWithTimestamp(errorMsg);
                    await this.handleApiError('post9000', post9000Result, false); // 不拋出錯誤，只記錄
                    
                    if (tryPost9000Times < 3) {
                      logWithTimestamp(`⏳ 等待 2 秒後重試 post9000`);
                      await this.delay(2000); // 等待 2 秒後重試
                    } else {
                      errorWithTimestamp({ isForce: true }, `❌ post9000 已達最大重試次數 (${tryPost9000Times} 次)，停止嘗試: ${post9000Result.error?.error || '未知錯誤'}`);
                    }
                  }
                } catch (error) {
                  const errorMsg = `❌ post9000 異常 (第 ${tryPost9000Times} 次): ${error instanceof Error ? error.message : String(error)}`;
                  errorWithTimestamp(errorMsg);
                  await this.setError(errorMsg);
                  
                  if (tryPost9000Times < 3) {
                    logWithTimestamp(`⏳ 等待 2 秒後重試 post9000`);
                    await this.delay(2000); // 等待 2 秒後重試
                  } else {
                    errorWithTimestamp(`❌ post9000 異常已達最大重試次數 (${tryPost9000Times} 次)，停止嘗試`);
                  }
                }
              }

              // 🎯 只有當 post9000 成功後，才執行 post9000Dummy
              if (post9000Success) {
                try {
                  logWithTimestamp(`🔄 post9000 成功，開始呼叫 post9000Dummy`);
                  const dummyResult = await post9000Dummy(previousCallRecord.description, previousCallRecord.description2, previousCallRecord.phone);
                  
                  if (dummyResult.success) {
                    logWithTimestamp({ isForce: true }, `✅ post9000Dummy 成功, ${JSON.stringify(dummyResult.data)}`);
                  } else {
                    const errorMsg = `❌ post9000Dummy 失敗: ${dummyResult.error?.error || '未知錯誤'}`;
                    errorWithTimestamp(errorMsg);
                    await this.handleApiError('post9000Dummy', dummyResult, false); // 不拋出錯誤，只記錄
                  }
                } catch (error) {
                  const errorMsg = `❌ post9000Dummy 異常: ${error instanceof Error ? error.message : String(error)}`;
                  errorWithTimestamp(errorMsg);
                  await this.setError(errorMsg);
                }
              } else {
                warnWithTimestamp(`⚠️ post9000 失敗，跳過 post9000Dummy 的呼叫`);
              }
            }
          } catch (error) {
            const errorMsg = `❌ Dialing 狀態處理異常: ${error instanceof Error ? error.message : String(error)}`;
            errorWithTimestamp(errorMsg);
            
            // 即使發生錯誤，也要移除使用過的撥號名單項目
            try {
              await CallListManager.removeUsedCallListItem(previousCallRecord.projectId, previousCallRecord.customerId);
            } catch (removeError) {
              errorWithTimestamp(`❌ 移除撥號名單項目時發生錯誤: ${removeError instanceof Error ? removeError.message : String(removeError)}`);
            }
          }
          break;
        case "Connected":
          logWithTimestamp(`分機 ${previousCallRecord.dn} 狀態為已接通，前一通電話記錄為已接通`);
          const visitedAt = previousCallRecord.dialTime || new Date().toISOString(); // 使用撥打時間或當前時間
          try {
            const callStatusResult2 = await updateCallStatus(previousCallRecord.projectId, previousCallRecord.customerId, 1); // 1 表示已接通 更新 Bonsale 撥號狀態 成功
            await this.handleApiError('updateCallStatus (Connected)', callStatusResult2);

            // 延遲 100 毫秒後再更新拜訪紀錄，確保狀態更新完成
            setTimeout(async () => {
              try {
                const visitRecordResult = await updateVisitRecord(  // 紀錄 ​寫入​訪談​紀錄 ( ​要​延遲​是​因為​ 後端​需要​時間​寫入​資料​庫 讓​抓​名​單邏輯​正常​ )
                  previousCallRecord.projectId, 
                  previousCallRecord.customerId,
                  'intro',
                  'admin',
                  visitedAt,
                  '撥打成功',
                  '撥打成功'
                );
                await this.handleApiError('updateVisitRecord', visitRecordResult, false);
              } catch (error) {
                const errorMsg = `updateVisitRecord 異常: ${error instanceof Error ? error.message : String(error)}`;
                await this.setError(errorMsg);
                logWithTimestamp({ isForce: true }, '❌ updateVisitRecord 異常:', {
                  projectId: this.projectId,
                  callFlowId: this.callFlowId,
                  state: this.state,
                  client_id: this.client_id,
                  agentQuantity: this.agentQuantity,
                  access_token: this.access_token ? '***已設置***' : '未設置',
                  recurrence: this.recurrence,
                  error: this.error,
                  wsConnected: this.wsManager?.isConnected() || false,
                  timestamp: new Date().toISOString(),
                  errorMsg
                });
                errorWithTimestamp({ isForce: true }, errorMsg);
              }
            }, 100);
            
            // 記錄完成後，移除使用過的撥號名單項目
            await CallListManager.removeUsedCallListItem(previousCallRecord.projectId, previousCallRecord.customerId);

            // 更新自動撥號執行狀態
            const autoDialResult2 = await updateBonsaleProjectAutoDialExecute(
              this.projectId,
              this.callFlowId,
            );
            await this.handleApiError('updateBonsaleProjectAutoDialExecute (Connected)', autoDialResult2);
          } catch (error) {
            const errorMsg = `❌ Connected 狀態處理異常: ${error instanceof Error ? error.message : String(error)}`;
            errorWithTimestamp(errorMsg);

            // 即使發生錯誤，也要移除使用過的撥號名單項目
            try {
              await CallListManager.removeUsedCallListItem(previousCallRecord.projectId, previousCallRecord.customerId);
            } catch (removeError) {
              errorWithTimestamp(`❌ 移除撥號名單項目時發生錯誤: ${removeError instanceof Error ? removeError.message : String(removeError)}`);
            }
          }
          break;
        default:
          warnWithTimestamp(`分機 ${previousCallRecord.dn} 狀態為未知，無法記錄前一通電話結果`);
          // 即使狀態未知，也要移除使用過的撥號名單項目，避免名單殘存
          try {
            await CallListManager.removeUsedCallListItem(previousCallRecord.projectId, previousCallRecord.customerId);
            logWithTimestamp(`🗑️ 已移除未知狀態的撥號名單項目 - 專案: ${previousCallRecord.projectId}, 客戶: ${previousCallRecord.customerId}`);
          } catch (removeError) {
            errorWithTimestamp(`❌ 移除未知狀態撥號名單項目時發生錯誤: ${removeError instanceof Error ? removeError.message : String(removeError)}`);
          }
      }

    } catch (error) {
      const errorMsg = `記錄 Bonsale 通話結果失敗: ${error instanceof Error ? error.message : String(error)}`;
      await this.setError(errorMsg);
      errorWithTimestamp('記錄 Bonsale 通話結果失敗:', error);

      // 即使發生錯誤，也要移除使用過的撥號名單項目，避免名單殘存
      if (previousCallRecord) {
        try {
          await CallListManager.removeUsedCallListItem(previousCallRecord.projectId, previousCallRecord.customerId);
          logWithTimestamp(`🗑️ 已移除異常處理中的撥號名單項目 - 專案: ${previousCallRecord.projectId}, 客戶: ${previousCallRecord.customerId}`);
        } catch (removeError) {
          errorWithTimestamp(`❌ 移除異常處理中撥號名單項目時發生錯誤: ${removeError instanceof Error ? removeError.message : String(removeError)}`);
        }
      }
      // 不拋出錯誤，避免影響主要的外撥流程
    }
  }

  /**
   * 檢查並補充撥號名單
   * 如果 Redis 中的名單數量低於分機數量的 2 倍，則自動從 Bonsale 拉取新名單
   * @private
   */
  private async checkAndReplenishCallList(): Promise<void> {
    try {
      // 獲取當前 Redis 中的撥號名單數量
      const currentCount = await CallListManager.getCallListCount(this.projectId);
      const minimumRequired = this.agentQuantity * 2;

      logWithTimestamp(`📊 專案 ${this.projectId} 撥號名單檢查 - 當前: ${currentCount}, 最低需求: ${minimumRequired} (分機數 ${this.agentQuantity} x 2)`);

      if (currentCount < minimumRequired) {
        logWithTimestamp(`🔄 撥號名單不足，開始自動補充 - 專案: ${this.projectId}`);
        
        // 調用現有的 getBonsaleOutboundCallList 方法來補充名單
        await this.getBonsaleOutboundCallList();
        
        // 再次檢查補充後的數量
        const newCount = await CallListManager.getCallListCount(this.projectId);
        logWithTimestamp(`✅ 撥號名單補充完成 - 專案: ${this.projectId}, 補充前: ${currentCount}, 補充後: ${newCount}`);
      } else {
        logWithTimestamp(`✅ 撥號名單充足 - 專案: ${this.projectId}, 當前: ${currentCount}`);
      }
    } catch (error) {
      errorWithTimestamp(`❌ 檢查並補充撥號名單失敗 - 專案: ${this.projectId}:`, error);
      // 不拋出錯誤，避免影響主要的撥打流程
    }
  }

  /**
   * 從 Bonsale API 獲取外撥名單
   * @private
   */
  private async getBonsaleOutboundCallList(): Promise<void> {
    try {
      logWithTimestamp(`開始從 Bonsale API 獲取專案 ${this.projectId} 的撥號名單`);

      // 獲取當前 Redis 中的撥號名單數量
      const currentCount = await CallListManager.getCallListCount(this.projectId);
      const maxAllowed = this.agentQuantity * 3; // Redis 存放上限：分機數量的 3 倍
      
      // 計算還能補充的數量
      const spaceLeft = maxAllowed - currentCount;
      if (spaceLeft <= 0) {
        logWithTimestamp(`🚫 撥號名單已達上限 - 專案: ${this.projectId}, 當前: ${currentCount}, 上限: ${maxAllowed}`);
        return;
      }

      const limit = this.agentQuantity * 5; // 拉取名單：分機數量的 5 倍
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

      // 驗證名單資料（只檢查必要欄位）並過濾重複
      const validItems: Array<Outbound> = [];
      
      for (const item of outboundList) {
        // 檢查必要欄位
        if (!item.customerId || !item.customer?.phone || item.customer.phone.trim() === '') {
          continue;
        }
        
        // 檢查是否已存在於 Redis 中
        const exists = await CallListManager.isCustomerExists(this.projectId, item.customerId);
        if (exists) {
          logWithTimestamp(`⚠️ 跳過重複客戶 - 客戶ID: ${item.customerId}, 姓名: ${item.customer?.memberName}`);
          continue;
        }
        
        validItems.push(item);
        
        // 檢查是否已達到 Redis 存放上限
        if (validItems.length >= spaceLeft) {
          logWithTimestamp(`✅ 已達到 Redis 存放上限 ${spaceLeft} 筆，停止過濾`);
          break;
        }
      }

      if (validItems.length === 0) {
        warnWithTimestamp('過濾後沒有可用的新名單（全部重複或資料不完整）');
        return;
      }

      logWithTimestamp(`📋 過濾結果 - 原始拉取: ${outboundList.length}/${limit}, 過濾後有效: ${validItems.length}, 將補充: ${Math.min(validItems.length, spaceLeft)}`);

      // 批次處理撥號名單，只處理到 Redis 存放上限為止
      const itemsToAdd = validItems.slice(0, spaceLeft);
      const addPromises = itemsToAdd.map(item => {
        const callListItem = new CallListManager(
          item.projectId,
          item.customerId,
          item.customer?.memberName || '未知客戶',
          item.customer?.phone || '',
          item.customer?.description || null, // description
          item.customer?.description2 || null, // description2
          false, // dialing - 新項目預設為未撥打
          null   // dialingAt - 新項目預設為 null
        );
        return CallListManager.addCallListItem(callListItem);
      });

      const results = await Promise.allSettled(addPromises);
      
      // 統計結果
      const successCount = results.filter(result => 
        result.status === 'fulfilled' && result.value === true
      ).length;
      const failCount = results.length - successCount;

      // 獲取最終數量
      const finalCount = await CallListManager.getCallListCount(this.projectId);

      logWithTimestamp(`✅ Bonsale 撥號名單補充完成 - 補充: ${successCount}/${itemsToAdd.length}, 失敗: ${failCount}, 最終總數: ${finalCount}/${maxAllowed}`);
      
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
      const errorMsg = `處理 Bonsale 撥號名單失敗: ${error instanceof Error ? error.message : String(error)}`;
      await this.setError(errorMsg);
      errorWithTimestamp('處理 Bonsale 撥號名單失敗:', error);
    }
  }

  /**
   * WebSocket 連接成功後的統一初始化邏輯
   * @param broadcastWs 廣播 WebSocket 伺服器實例
   * @param context 上下文描述（用於日誌）
   * @private
   */
  private async handleWebSocketInitialization(broadcastWs?: WebSocketServer, context: string = '3CX WebSocket 連接成功'): Promise<void> {
    try {
      logWithTimestamp(`🔗 3CX WebSocket ${context}`);
      
      // 檢查專案狀態，只有在 active 狀態下才執行初始化
      if (this.state !== 'active') {
        logWithTimestamp(`📊 專案 ${this.projectId} 狀態為 ${this.state}，跳過 WebSocket 初始化`);
        return;
      }
      
      // 檢查並補充撥號名單
      logWithTimestamp(`📋 檢查並補充撥號名單 - 專案: ${this.projectId}`);
      await this.checkAndReplenishCallList();
      
      // 執行外撥邏輯
      logWithTimestamp(`📞 執行外撥邏輯 - 專案: ${this.projectId}`);
      // 使用 throttle 版本
      if (this.throttledOutboundCall) {
        await this.throttledOutboundCall(broadcastWs, null, true, true);
      }
      
      // 啟動空閒檢查定時器
      this.startIdleCheck(broadcastWs);
      
      logWithTimestamp(`✅ WebSocket ${context} - 初始化完成`);
    } catch (error) {
      errorWithTimestamp(`❌ WebSocket ${context}後初始化時發生錯誤:`, error);
      // 不拋出錯誤，避免影響 WebSocket 連接
    }
  }

  /**
   * 創建 WebSocket 管理器配置
   * @param broadcastWs 廣播 WebSocket 伺服器實例
   * @returns WebSocket 管理器配置對象
   * @private
   */
  private createWebSocketManagerConfig(broadcastWs?: WebSocketServer) {
    return {
      connection: {
        url: `${WS_HOST_3CX}/callcontrol/ws`,
        headers: {
          Authorization: `Bearer ${this.access_token}`
        },
        heartbeatInterval: 30000, // 30秒心跳
        reconnectDelay: 3000, // 3秒重連延遲
        maxReconnectAttempts: 5
      },
      handlers: {
        onOpen: () => {
          logWithTimestamp({ isForce: true }, '🔗 WebSocket 連接成功 - 完整專案資訊:', {
            projectId: this.projectId,
            callFlowId: this.callFlowId,
            state: this.state,
            client_id: this.client_id,
            agentQuantity: this.agentQuantity,
            access_token: this.access_token ? '***已設置***' : '未設置',
            recurrence: this.recurrence,
            error: this.error,
            wsConnected: this.wsManager?.isConnected() || false,
            timestamp: new Date().toISOString()
          });
          this.handleWebSocketInitialization(broadcastWs, '3CX WebSocket 連接成功')
        },
        onMessage: (data: Buffer) => {
          // 將 Buffer 轉換為字符串
          const messageString = data.toString('utf8');
          
          // 嘗試解析 JSON
          const messageObject = JSON.parse(messageString);
          logWithTimestamp('📨 3CX WebSocket data:', messageObject);
          logWithTimestamp( '📨 3CX WebSocket 收到訊息:', {
            projectId: this.projectId,
            callFlowId: this.callFlowId,
            state: this.state,
            client_id: this.client_id,
            agentQuantity: this.agentQuantity,
            access_token: this.access_token ? '***已設置***' : '未設置',
            recurrence: this.recurrence,
            error: this.error,
            wsConnected: this.wsManager?.isConnected() || false,
            timestamp: new Date().toISOString()
          });
          if (broadcastWs) {
            this.handleWebSocketMessage(broadcastWs, data);
          }
        },
        onError: async (error: Error) => {
          const errorMsg = `3CX WebSocket 錯誤: ${error.message}`;
          await this.setError(errorMsg);
          errorWithTimestamp('3CX WebSocket 錯誤:', error);
        },
        onClose: (code: number, reason: Buffer) => {
          logWithTimestamp(`3CX WebSocket 關閉: ${code} - ${reason.toString()}`);
        },
        onReconnect: () => this.handleWebSocketInitialization(broadcastWs, '3CX WebSocket 重新連接成功')
      }
    };
  }

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
   * 開始空閒檢查定時器（使用指數退避機制）
   * @param broadcastWs 廣播 WebSocket 伺服器實例
   * @private
   */
  private startIdleCheck(broadcastWs?: WebSocketServer): void {
    // 先停止現有的定時器（如果有的話）
    this.stopIdleCheck();

    // 保存 WebSocket 引用
    this.broadcastWsRef = broadcastWs;

    // 重置檢查間隔為最小值
    this.idleCheckInterval = this.minIdleCheckInterval;

    // 啟動第一次檢查
    this.scheduleNextIdleCheck();

    logWithTimestamp(`🕰️ 專案 ${this.projectId} 空閒檢查定時器已啟動（指數退避機制，初始間隔：${this.idleCheckInterval / 1000}秒）`);
  }

  /**
   * 停止空閒檢查定時器
   * @private
   */
  private stopIdleCheck(): void {
    if (this.idleCheckTimer) {
      clearTimeout(this.idleCheckTimer);
      this.idleCheckTimer = null;
      logWithTimestamp(`⏹️ 專案 ${this.projectId} 空閒檢查定時器已停止`);
    }
  }

  /**
   * 安排下一次空閒檢查（使用指數退避）
   * @private
   */
  private scheduleNextIdleCheck(): void {
    this.idleCheckTimer = setTimeout(async () => {
      try {
        const hasIdleExtension = await this.checkIdleAndTriggerOutbound();
        
        if (hasIdleExtension) {
          // 如果有空閒分機並觸發了外撥，重置間隔為最小值
          this.idleCheckInterval = this.minIdleCheckInterval;
          logWithTimestamp(`🔄 專案 ${this.projectId} 檢測到活動，重置檢查間隔為 ${this.idleCheckInterval / 1000} 秒`);
        } else {
          // 如果沒有空閒分機，增加檢查間隔（指數退避）
          this.idleCheckInterval = Math.min(
            this.idleCheckInterval * this.idleCheckBackoffFactor,
            this.maxIdleCheckInterval
          );
          logWithTimestamp(`⏰ 專案 ${this.projectId} 無活動，增加檢查間隔為 ${this.idleCheckInterval / 1000} 秒`);
        }
        
        // 安排下一次檢查
        if (this.state === 'active') {
          this.scheduleNextIdleCheck();
        }
      } catch (error) {
        errorWithTimestamp(`空閒檢查時發生錯誤 - 專案 ${this.projectId}:`, error);
        // 發生錯誤時也要安排下一次檢查
        if (this.state === 'active') {
          this.scheduleNextIdleCheck();
        }
      }
    }, this.idleCheckInterval);
  }

  /**
   * 檢查空閒狀態並觸發外撥
   * @returns Promise<boolean> - true 如果找到空閒分機並觸發外撥，false 如果沒有
   * @private
   */
  private async checkIdleAndTriggerOutbound(): Promise<boolean> {
    // 檢查專案狀態
    if (this.state !== 'active') {
      return false;
    }

    // 檢查是否有空閒分機
    if (!this.caller || this.caller.length === 0) {
      return false;
    }

    // 檢查是否有空閒且非忙碌的分機
    const hasIdleExtension = this.caller.some(caller => {
      // 檢查分機是否空閒（沒有通話中）
      const isIdle = !caller.participants || caller.participants.length === 0;
      
      return isIdle;
    });

    if (hasIdleExtension) {
      logWithTimestamp(`🔄 檢測到空閒分機，準備延遲觸發外撥邏輯 - 專案: ${this.projectId}`);
      
      // 添加隨機延遲（2-5秒），避免多個定時器同時觸發造成的競態條件
      const randomDelay = Math.random() * 3000 + 2000; // 2000-5000ms 的隨機延遲
      
      setTimeout(async () => {
        logWithTimestamp(`🔄 延遲後觸發外撥邏輯 - 專案: ${this.projectId}`);
        // 🆕 使用 debounced 版本
        if (this.throttledOutboundCall) {
          await this.throttledOutboundCall(this.broadcastWsRef, null, true, true);
        }
      }, randomDelay);
      
      return true;
    }
    
    return false;
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
   * 處理所有未完成的通話記錄
   * 在專案完全停止前，確保所有通話記錄都被正確處理
   * @private
   */
  private async processPendingCallRecords(): Promise<void> {
    try {
      logWithTimestamp(`🔄 專案 ${this.projectId} 開始處理未完成的通話記錄`);

      // 檢查是否有未處理的 latestCallRecord
      if (this.latestCallRecord && this.latestCallRecord.length > 0) {
        logWithTimestamp(`📞 發現 ${this.latestCallRecord.length} 筆未處理的通話記錄`);
        
        // 將所有 latestCallRecord 移動到 previousCallRecord 以便處理
        for (const callRecord of this.latestCallRecord) {
          if (callRecord) {
            // 初始化 previousCallRecord（如果需要）
            if (!this.previousCallRecord) {
              this.previousCallRecord = [];
            }
            
            // 檢查是否已存在該分機的記錄
            const existingIndex = this.previousCallRecord.findIndex(call => call?.dn === callRecord.dn);
            if (existingIndex >= 0) {
              this.previousCallRecord[existingIndex] = { ...callRecord };
            } else {
              this.previousCallRecord.push({ ...callRecord });
            }
            
            logWithTimestamp(`📋 移動通話記錄到待處理清單 - 分機: ${callRecord.dn}, 客戶: ${callRecord.memberName} (${callRecord.customerId})`);
          }
        }
        
        // 清空 latestCallRecord
        this.latestCallRecord = [];
        
        // 更新到 Redis
        await ProjectManager.updateProjectLatestCallRecord(this.projectId, this.latestCallRecord);
      }

      // 處理所有 previousCallRecord
      if (this.previousCallRecord && this.previousCallRecord.length > 0) {
        logWithTimestamp(`🔄 開始處理 ${this.previousCallRecord.length} 筆待處理的通話記錄`);
        
        const processPromises = this.previousCallRecord
          .filter(record => record !== null)
          .map(async (record) => {
            try {
              await this.recordBonsaleCallResult(record);
              logWithTimestamp(`✅ 完成處理通話記錄 - 分機: ${record!.dn}, 客戶: ${record!.memberName}`);
            } catch (error) {
              errorWithTimestamp(`❌ 處理通話記錄失敗 - 分機: ${record!.dn}, 客戶: ${record!.memberName}:`, error);
            }
          });
        
        // 等待所有記錄處理完成
        await Promise.allSettled(processPromises);
        
        // 清空 previousCallRecord
        this.previousCallRecord = [];
        
        logWithTimestamp(`✅ 所有未完成的通話記錄處理完成`);
      } else {
        logWithTimestamp(`ℹ️ 沒有待處理的通話記錄`);
      }
      
    } catch (error) {
      errorWithTimestamp(`處理未完成通話記錄時發生錯誤:`, error);
      // 不拋出錯誤，避免影響停止流程
    }
  }

  /**
   * 執行完全停止邏輯
   * @param broadcastWs 廣播 WebSocket 伺服器實例
   */
  async executeCompleteStop(broadcastWs: WebSocketServer): Promise<void> {
    try {
      // 停止空閒檢查定時器
      this.stopIdleCheck();
      
      // 處理所有未完成的通話記錄
      await this.processPendingCallRecords();
      
      // 清空該專案在 Redis 中的暫存撥號名單
      logWithTimestamp(`🗑️ 清空專案 ${this.projectId} 的 Redis 暫存撥號名單`);
      const clearResult = await CallListManager.removeProjectCallList(this.projectId);
      if (clearResult) {
        logWithTimestamp(`✅ 成功清空專案 ${this.projectId} 的撥號名單`);
      } else {
        warnWithTimestamp(`⚠️ 清空專案 ${this.projectId} 撥號名單失敗`);
      }
      
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
        
        // 重新創建 WebSocket 管理器，使用新的 token 和統一配置
        const wsConfig = this.createWebSocketManagerConfig(broadcastWs);
        // 更新 onOpen 回調以使用正確的上下文
        wsConfig.handlers.onOpen = () => this.handleWebSocketInitialization(broadcastWs, '3CX WebSocket 重新連接成功（token 更新後）');
        
        this.wsManager = new WebSocketManager(wsConfig.connection, wsConfig.handlers);
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
    // 停止空閒檢查定時器
    this.stopIdleCheck();
    
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
        await runningProject.updateState('stop');
        
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