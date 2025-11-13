import { WebSocketServer } from "ws";
import dotenv from 'dotenv';
import { throttle, type DebouncedFunc } from 'lodash';
import { Mutex } from 'async-mutex';
import { logWithTimestamp, warnWithTimestamp, errorWithTimestamp } from '../util/timestamp';
import { getCaller, getCallerDn, makeCall, get3cxToken, getParticipants } from '../services/api/callControl'
import { ProjectManager } from '../class/projectManager';
import { broadcastAllProjects } from '../components/broadcast';
import { WebSocketManager } from './webSocketManager';
import { TokenManager } from './tokenManager';
import { CallListManager } from './callListManager';
import { getOutbound, updateCallStatus, updateDialUpdate, updateVisitRecord, updateBonsaleProjectAutoDialExecute } from '../services/api/bonsale';
import { getUsers } from '../services/api/xApi';
import { Outbound } from '../types/bonsale/getOutbound';
import { Participant } from '@/types/3CX/callControl';
import { post9000Dummy, post9000 } from '../services/api/insertOverdueMessageForAi';
import { isTodayInSchedule } from '../util/iCalendar';

dotenv.config();

/**
 * 定義常數
 * @param WS_HOST_3CX 定義 3CX WebSocket 伺服器地址
 * @param IS_STARTIDLECHECK 是否啟動空閒檢查定時器
 * @param IDLE_CHECK_INTERVAL 當前檢查間隔（毫秒）
 * @param MIN_IDLE_CHECK_INTERVAL 最小檢查間隔（毫秒）
 * @param MAX_IDLE_CHECK_INTERVAL 最大檢查間隔（毫秒）
 * @param IDLE_CHECK_BACKOFF_FACTOR 指數退避倍數
 */

// 定義 3CX WebSocket 伺服器地址
const WS_HOST_3CX = process.env.WS_HOST_3CX;
// 空間檢查定時器 冷卻時間
const IS_STARTIDLECHECK = process.env.IS_STARTIDLECHECK === 'true' ? true : false;
// 當前檢查間隔（毫秒）
const IDLE_CHECK_INTERVAL = process.env.IDLE_CHECK_INTERVAL ? parseInt(process.env.IDLE_CHECK_INTERVAL) : 30000;
// 最小檢查間隔（毫秒）
const MIN_IDLE_CHECK_INTERVAL = process.env.MIN_IDLE_CHECK_INTERVAL ? parseInt(process.env.MIN_IDLE_CHECK_INTERVAL) : 30000;
// 最大檢查間隔（毫秒）
const MAX_IDLE_CHECK_INTERVAL = process.env.MAX_IDLE_CHECK_INTERVAL ? parseInt(process.env.MAX_IDLE_CHECK_INTERVAL) : 300000;
// 指數退避倍數
const IDLE_CHECK_BACKOFF_FACTOR = process.env.IDLE_CHECK_BACKOFF_FACTOR ? parseFloat(process.env.IDLE_CHECK_BACKOFF_FACTOR) : 1.5;

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

// 紀錄分機最後執行時間的物件
type CallerExtensionLastExecutionTime = {
  [extension: string]: string;
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
  latestCallRecord: Map<string, CallRecord> = new Map(); // 保存當前撥打記錄 (Key: dn/分機號碼)
  agentQuantity: number | 0;
  recurrence: string | null = null; // 新增 recurrence 屬性
  callRestriction: Map<string, CallRestriction> = new Map(); // 新增 callRestriction 屬性 (Key: id)
  callerExtensionLastExecutionTime: CallerExtensionLastExecutionTime = {}; // 分機最新執行時間記錄
  private previousCallRecord: Map<string, CallRecord> = new Map(); // 保存前一筆撥打記錄 (Key: dn/分機號碼)
  private wsManager: WebSocketManager | null = null;
  private tokenManager: TokenManager;
  // 為 outboundCall 方法添加 throttled
  private throttledOutboundCall: DebouncedFunc<(broadcastWs: WebSocketServer | undefined, eventEntity: string | null, isExecuteOutboundCalls?: boolean, isInitCall?: boolean, participantSnapshot?: { success: boolean; data?: Participant; error?: { errorCode: string; error: string; } } | null) => Promise<void>> | null = null;
  // 為 handleStopStateLogic 方法添加 throttled - 防止 case 0 多次觸發
  private throttledHandleStopStateLogic: DebouncedFunc<(broadcastWs: WebSocketServer) => Promise<void>> | null = null;
  private idleCheckTimer: NodeJS.Timeout | null = null; // 空閒檢查定時器
  private idleCheckInterval: number = IDLE_CHECK_INTERVAL || 30000; // 當前檢查間隔 預設 30000 毫秒 (30 秒)
  private readonly minIdleCheckInterval: number = MIN_IDLE_CHECK_INTERVAL || 30000; // 最小檢查間隔 預設 30000 毫秒 (30 秒)
  private readonly maxIdleCheckInterval: number = MAX_IDLE_CHECK_INTERVAL || 300000; // 最大檢查間隔 預設 300000 毫秒 (5 分鐘)
  private readonly idleCheckBackoffFactor: number = IDLE_CHECK_BACKOFF_FACTOR || 1.5; // 指數退避倍數 預設 1.5 倍
  private broadcastWsRef: WebSocketServer | undefined = undefined; // 保存 WebSocket 引用

  // 全域 Mutex - 保護 latestCallRecord 和 previousCallRecord 的原子性
  private readonly processCallerMutex: Mutex = new Mutex(); // 全域互斥鎖，確保只有一個分機能同時執行 processCallerOutbound

// 🆕 分機級 Mutex 映射 - 允許不同分機並行執行
  private readonly processMutexPerExtension: Map<string, Mutex> = new Map();

  // 🆕 Token 刷新 Flag - 防止重複刷新 WebSocket 連接
  private isRefreshingToken: boolean = false;

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
    latestCallRecord: Array<CallRecord> | Map<string, CallRecord> = new Map(),
    agentQuantity: number | 0,
    recurrence: string | null = null,
    callRestriction: CallRestriction[] | Map<string, CallRestriction> = new Map(),
    callerExtensionLastExecutionTime: CallerExtensionLastExecutionTime = {}
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
    // 如果接收到陣列，轉換為 Map；如果已是 Map，直接使用
    this.latestCallRecord = latestCallRecord instanceof Map ? latestCallRecord : this._convertArrayToMapForLatestCallRecord(latestCallRecord);
    this.agentQuantity = agentQuantity;
    this.recurrence = recurrence;
    // 如果接收到陣列，轉換為 Map；如果已是 Map，直接使用
    this.callRestriction = callRestriction instanceof Map ? callRestriction : this._convertArrayToMapForCallRestriction(callRestriction);
    this.callerExtensionLastExecutionTime = callerExtensionLastExecutionTime;

    // 初始化 TokenManager
    this.tokenManager = new TokenManager(client_id, client_secret, projectId, access_token);

    // 初始化 throttle outboundCall 方法 (500ms 內最多執行一次)
    this.throttledOutboundCall = throttle(this.outboundCall.bind(this), 500, {
      leading: false,   // 第一次不立即執行
      trailing: true  // 在等待期結束後執行
    });

    // 初始化 throttle handleStopStateLogic 方法 (500ms 內最多執行一次) - 防止 case 0 多次觸發
    this.throttledHandleStopStateLogic = throttle(this.handleStopStateLogic.bind(this), 500, {
      leading: false,   // 第一次不立即執行
      trailing: true  // 在等待期結束後執行
    });

  }

  /**
   * 將 CallRecord 陣列轉換為 Map
   * @param records CallRecord 陣列
   * @returns Map<string, CallRecord>
   */
  private _convertArrayToMapForLatestCallRecord(records: Array<CallRecord>): Map<string, CallRecord> {
    const map = new Map<string, CallRecord>();
    if (Array.isArray(records) && records.length > 0) {
      records.forEach(record => {
        if (record && record.dn) {
          map.set(record.dn, record);
        }
      });
    }
    return map;
  }

  /**
   * 將 CallRestriction 陣列轉換為 Map
   * @param restrictions CallRestriction 陣列
   * @returns Map<string, CallRestriction>
   */
  private _convertArrayToMapForCallRestriction(restrictions: CallRestriction[]): Map<string, CallRestriction> {
    const map = new Map<string, CallRestriction>();
    if (Array.isArray(restrictions) && restrictions.length > 0) {
      restrictions.forEach(restriction => {
        map.set(restriction.id, restriction);
      });
    }
    return map;
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
    callRestriction: CallRestriction[] | Map<string, CallRestriction>;
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

      // 為所有分機初始化 Mutex
      if (callerData && callerData.length > 0) {
        for (const c of callerData) {
          project.processMutexPerExtension.set(c.dn, new Mutex());
          logWithTimestamp(`🔒 為分機 ${c.dn} 初始化 Mutex`);
        }
      }

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
          // ✅ 改進：在 WebSocket 事件處理時立即捕獲 participant 快照
          // 這樣可以避免在 Mutex 排隊期間 entity 失效導致的問題

          // 🔑 立即捕獲當下的 participant 快照，避免在 Mutex 排隊期間 entity 失效
          let participantSnapshot0 = null;
          try {
            if (eventEntity && this.access_token) {
              // 解析 eventEntity 來獲取分機資訊
              const eventEntity_dn = eventEntity.split('/')[2]; // 格式固定為 /callcontrol/{dnnumber}/participants/{id}
              const participantResult = await getParticipants(this.access_token, eventEntity_dn);
              if (!participantResult.success) {
                errorWithTimestamp(`❌ 無法獲取 participant 快照`);
                return;
              };
              participantSnapshot0 = participantResult;
              logWithTimestamp(`✅ 捕獲 participant 快照 - entity: ${eventEntity}`);
            }
          } catch (captureError) {
            errorWithTimestamp(`❌ 捕獲 participant 快照失敗:`, captureError);
          }

          // 如果專案狀態是 stop，使用 throttle 版本檢查是否還有活躍通話
          if (this.state === 'stop') {
            logWithTimestamp(`專案狀態為 stop，調用 throttle 版本的停止狀態邏輯`);
            // 使用 throttle 版本，防止 case 0 多次觸發
            if (this.throttledHandleStopStateLogic) {
              this.throttledHandleStopStateLogic(broadcastWs)!.catch(error => {
                errorWithTimestamp('case 0 觸發停止狀態邏輯時發生錯誤:', error);
              });
            }
            return;
          }

          if (this.throttledOutboundCall) {
            // 使用 throttled 版本的 outboundCall，並傳入快照
            // 注意：不 await，讓它在背景執行，避免在 WebSocket 事件處理器內造成死鎖

            this.throttledOutboundCall(broadcastWs, eventEntity, false, false, participantSnapshot0)!.catch(error => {
              errorWithTimestamp('case 0 觸發外撥邏輯時發生錯誤:', error);
            });
          }
          break;
        case 1:
          logWithTimestamp(`狀態 ${eventType}:`, messageObject.event);
          // ✅ 改進：在 WebSocket 事件處理時立即捕獲 participant 快照
          // 這樣可以避免在 Mutex 排隊期間 entity 失效導致的問題

          // 🔑 立即捕獲當下的 participant 快照，避免在 Mutex 排隊期間 entity 失效
          let participantSnapshot1 = null;
          try {
            if (eventEntity && this.access_token) {
              // 解析 eventEntity 來獲取分機資訊
              const eventEntity_dn = eventEntity.split('/')[2]; // 格式固定為 /callcontrol/{dnnumber}/participants/{id}
              const participantResult = await getParticipants(this.access_token, eventEntity_dn);
              if (!participantResult.success) {
                errorWithTimestamp(`❌ 無法獲取 participant 快照`);
                return;
              };
              participantSnapshot1 = participantResult;
              logWithTimestamp(`✅ 捕獲 participant 快照 - entity: ${eventEntity}`);
            }
          } catch (captureError) {
            errorWithTimestamp(`❌ 捕獲 participant 快照失敗:`, captureError);
          }

          // 如果專案狀態是 stop，檢查是否還有活躍通話
          if (this.state === 'stop') {
            logWithTimestamp(`專案狀態為 stop，執行停止狀態邏輯處理`);
            await this.handleStopStateLogic(broadcastWs, participantSnapshot1, eventEntity);
            return;
          } 
          
          // 將捕獲的快照傳入 outboundCall
          logWithTimestamp(`調用 outboundCall 處理事件 entity: ${eventEntity}，狀態: ${this.state}`);
          // 注意：不 await，讓它在背景執行，避免在 WebSocket 事件處理器內造成死鎖
          this.outboundCall(broadcastWs, eventEntity, true, false, participantSnapshot1).catch(error => {
            errorWithTimestamp('case 1 觸發外撥邏輯時發生錯誤:', error);
          });

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
   * 紀錄分機執行時間
   * @param eventEntity 事件實體字串
   * @private
   */
  private async recordCallerExtensionLastExecutionTime(dn: string): Promise<void> {
    if (dn) {
      this.callerExtensionLastExecutionTime[dn] = new Date().toISOString();
      logWithTimestamp(`📝 紀錄分機 ${dn} 最後執行時間: ${this.callerExtensionLastExecutionTime[dn]}`);

      // 同時保存到 Redis
      try {
        await ProjectManager.saveProject(this);
        logWithTimestamp(`✅ 分機 ${dn} 執行時間已保存到 Redis`);
      } catch (error) {
        errorWithTimestamp(`❌ 保存分機 ${dn} 執行時間到 Redis 失敗:`, error);
      }
    }
  }

  /**
   * 執行外撥邏輯
   * @param broadcastWs 廣播 WebSocket 伺服器實例
   * @param updateCaller 是否更新 caller 資訊，預設為 true
   * @private
   */
  private async outboundCall(
    broadcastWs: WebSocketServer | undefined,
    eventEntity: string | null,
    isExecuteOutboundCalls: boolean = true,
    isInitCall: boolean = false,
    participantSnapshot: { success: boolean; data?: Participant; error?: { errorCode: string; error: string; } } | null = null
  ): Promise<void> {
    // 🔒 使用 Mutex 保護整個方法，確保初始撥號和 WebSocket 事件序列化執行
    const outboundCallStartTime = Date.now();
    logWithTimestamp(`[🔴 outboundCall 嘗試獲取 Mutex] eventEntity: ${eventEntity}`);

    let eventEntity_dn = null;
    let extensionMutex: Mutex | null = null;

    if (isInitCall) {
      logWithTimestamp('初始化撥號流程，使用全域 Mutex 進行保護');
      // 使用全域 Mutex 保護（初始化撥號）
      extensionMutex = this.processCallerMutex;
    } else {
      if (!eventEntity) {
        errorWithTimestamp('❌ eventEntity 為空，無法進行 outboundCall');
        this.setError('eventEntity 為空，無法進行 outboundCall');
        return;
      }

      eventEntity_dn = eventEntity.split('/')[2];
      extensionMutex = this.processMutexPerExtension.get(eventEntity_dn) || null;
      if (!extensionMutex) {
        errorWithTimestamp(`未找到分機 ${eventEntity_dn} 的 Mutex，無法進行 outboundCall`);
        this.setError(`未找到分機 ${eventEntity_dn} 的 Mutex，無法進行 outboundCall`);
        return;
      }
    }

    
    await extensionMutex.runExclusive(async () => {
      const mutexAcquiredTime = Date.now();
      logWithTimestamp(`[🔴 outboundCall 已獲取 Mutex] 等待時間: ${mutexAcquiredTime - outboundCallStartTime}ms`);

      try {
        logWithTimestamp('[🔴 outboundCall 開始執行邏輯]', {
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
          // Token 已更新，但不要在 Mutex 內重新建立 WebSocket 連接，避免死鎖
          // 改為異步處理，讓 WebSocket 重連接在 Mutex 釋放後進行
          logWithTimestamp('⚠️ Token 已更新，將在 Mutex 釋放後重新建立 WebSocket 連接');

          // 🆕 使用 Flag 防止重複刷新 WebSocket 連接
          if (!this.isRefreshingToken) {
            this.isRefreshingToken = true;  // 🔒 立即鎖定
            logWithTimestamp('🔒 設置 isRefreshingToken = true，防止重複刷新');

            // 使用 setImmediate 延遲執行，確保 Mutex 先釋放
            setImmediate(() => {
              this.handleTokenUpdateWebSocketReconnect(broadcastWs)
                .catch(error => {
                  errorWithTimestamp('Token 更新後非同步重連 WebSocket 失敗:', error);
                })
                .finally(() => {
                  this.isRefreshingToken = false;  // 🔓 解鎖
                  logWithTimestamp('🔓 設置 isRefreshingToken = false，允許下次刷新');
                });
            });
          } else {
            logWithTimestamp('⏭️ 已有 WebSocket 重連接在進行中，跳過此次刷新');
          }
          // 注意：分機狀態管理器現在使用管理員 token 自動管理，不需要同步更新
        }
        
        // 步驟三: 更新 caller 資訊
        // 初始化播號：調用全局函數，更新所有分機的 caller 資訊（全域 Mutex 保護）
        // 後續播號：只更新該分機的部分，避免全局競爭（分機級 Mutex 保護）
        if (isInitCall) {
          // 全局更新 caller 資訊 因為有全域鎖保護 所以安全
          await this.updateCallerInfo();
        } else {
          if (participantSnapshot && participantSnapshot.success && this.caller && participantSnapshot.data) {
            const participant = participantSnapshot.data;
            const callerIndex = this.caller.findIndex(c => c.dn === eventEntity_dn);
            if (callerIndex >= 0) {
              // 如果 participant 已經是陣列，直接賦值；否則包裝成陣列
              this.caller[callerIndex].participants = Array.isArray(participant)
                ? participant
                : [participant] as Participants[];
              logWithTimestamp(`[分機 ${eventEntity_dn}] 已更新 caller 資訊`);

              // 同步該分機的更新到 Redis
              await ProjectManager.updateProjectCaller(this.projectId, this.caller);
            } else {
              logWithTimestamp(`[分機 ${eventEntity_dn}] 無法更新 caller 資訊：未找到對應分機`);
            }
          }
        }


        // 步驟四: 更新 latestCallRecord 狀態
        // 初始化播號：調用全局函數，更新所有分機的狀態（全域 Mutex 保護）
        // 後續播號：只更新該分機的記錄，避免全局競爭（分機級 Mutex 保護）
        if (isInitCall) {
          // 全局更新 latestCallRecord 狀態 因為有全域鎖保護 所以安全
          await this.updateLatestCallRecordStatus();
        } else {
          if (!eventEntity_dn || !participantSnapshot) {
            errorWithTimestamp('❌ 無法更新 latestCallRecord 狀態，缺少 eventEntity_dn 或 participantSnapshot');
            this.setError('無法更新 latestCallRecord 狀態，缺少 eventEntity_dn 或 participantSnapshot');
            return;
          }

          const currentCall = this.latestCallRecord.get(eventEntity_dn);
          if (currentCall && participantSnapshot?.data) {
            // 如果 data 是陣列，取第一個元素；否則直接用
            const participant = Array.isArray(participantSnapshot.data)
              ? participantSnapshot.data[0]
              : participantSnapshot.data;

            if (participant?.status) {
              const newStatus = participant.status as "Dialing" | "Connected";
              if (currentCall.status !== newStatus) {
                const oldStatus = currentCall.status;
                this.latestCallRecord.set(eventEntity_dn, {
                  ...currentCall,
                  status: newStatus
                });
                logWithTimestamp(`[分機 ${eventEntity_dn}] 撥打狀態已更新: ${oldStatus} -> ${newStatus}`);

                // 同步該分機的更新到 Redis
                await ProjectManager.updateProjectLatestCallRecord(this.projectId, this.latestCallRecord);
              }
            }
          }
        }


        // 步驟五: 廣播專案資訊
        if (broadcastWs) {
          await this.broadcastProjectInfo(broadcastWs);
        }
        
        // 步驟六: 執行外撥邏輯
        // 是否初始撥號
        if (isInitCall) {
          await this.executeOutboundCalls(eventEntity, true, participantSnapshot);
          return;
        }
        // 確認是否要撥號
        if (isExecuteOutboundCalls) {
          await this.executeOutboundCalls(eventEntity, false, participantSnapshot);
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

      const mutexReleaseTime = Date.now();
      logWithTimestamp(`[🔴 outboundCall Mutex 釋放] 總耗時: ${mutexReleaseTime - outboundCallStartTime}ms`);
    });
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
      for (const [dn, currentCall] of this.latestCallRecord.entries()) {
        if (!currentCall || !dn) continue;

        // 找到對應的分機資訊
        const callerInfo = this.caller.find(caller => caller.dn === dn);

        if (callerInfo && callerInfo.participants && callerInfo.participants.length > 0) {
          const participant = callerInfo.participants[0];
          const newStatus = participant.status;

          // 如果狀態有變化，更新
          if (currentCall.status !== newStatus) {
            const oldStatus = currentCall.status;
            this.latestCallRecord.set(dn, { ...currentCall, status: newStatus });
            hasUpdate = true;

            logWithTimestamp(`撥打狀態更新 - 分機: ${dn}, 客戶: ${currentCall.memberName}, 狀態: ${oldStatus} -> ${newStatus}`);
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
   * @param eventEntity WebSocket 事件實體
   * @param isInitCall 是否為初始撥號
   * @param participantSnapshot 快照的 participant 狀態（可選）
   * @private
   */
  private async executeOutboundCalls(
    eventEntity: string | null,
    isInitCall: boolean,
    participantSnapshot: { success: boolean; data?: Participant; error?: { errorCode: string; error: string; } } | null = null
  ): Promise<void> {
    const executeStartTime = Date.now();
    logWithTimestamp(`[🟢 executeOutboundCalls 開始] eventEntity: ${eventEntity}, isInitCall: ${isInitCall}`);

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
    if (this.callRestriction && this.callRestriction.size > 0) {
      // callRestriction 的時間格式是 UTC+0，直接使用 UTC 時間比較
      const now = new Date();
      const currentTimeInMinutes = now.getUTCHours() * 60 + now.getUTCMinutes();

      // 檢查當前時間是否在任何一個限制時間範圍內
      const isInRestrictedTime = Array.from(this.callRestriction.values()).some(restriction => {
        const [startHour, startMinute] = restriction.startTime.split(':').map(Number);
        const [stopHour, stopMinute] = restriction.stopTime.split(':').map(Number);

        const startTimeInMinutes = startHour * 60 + startMinute;
        const stopTimeInMinutes = stopHour * 60 + stopMinute;

        // 處理兩種情況：
        // 1. 同一天內的時間範圍（例如 14:00 - 18:00）：startTime < stopTime
        //    此時檢查：currentTime >= startTime && currentTime <= stopTime
        // 2. 跨日期的時間範圍（例如 14:00 - 01:30）：startTime > stopTime
        //    此時檢查：currentTime >= startTime || currentTime <= stopTime
        //    （即從14:00到23:59，以及從00:00到01:30）
        if (startTimeInMinutes < stopTimeInMinutes) {
          // 同一天內：直接比較
          return currentTimeInMinutes >= startTimeInMinutes && currentTimeInMinutes <= stopTimeInMinutes;
        } else {
          // 跨日期：當前時間在開始時間之後 OR 在結束時間之前
          return currentTimeInMinutes >= startTimeInMinutes || currentTimeInMinutes <= stopTimeInMinutes;
        }
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

      // 🔒 製作快照防止迭代中修改
      const callerSnapshot = [...this.caller];
      for (const caller of callerSnapshot) {
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
          
          // 在處理下一個分機前添加延遲，給 API 和 WebSocket 一些反應時間
          // 使用快照長度而非 this.caller.length，避免 this.caller 被修改時的不一致
          const currentIndex = callerSnapshot.indexOf(caller);
          if (currentIndex < callerSnapshot.length - 1) {
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

      // 🔑 優先使用快照的 participant 狀態，避免重新查詢失效的 entity
      let participant;
      if (participantSnapshot) {
        logWithTimestamp(`✅ 使用快照的 participant 狀態，避免 entity 失效問題`);
        // 快照中可能包含成功的 participantResult 或失敗的 participantResult
        // 兩者都需要傳入供後續邏輯判斷 (根據 success 標誌)
        participant = participantSnapshot;
      } else {
        // 如果沒有快照，再進行查詢（通常是初始撥號的情況）
        logWithTimestamp(`⚠️ 沒有快照，重新查詢 participant 狀態`);
        // 解析 eventEntity 來獲取分機資訊
        const eventEntity_dn = eventEntity.split('/')[2]; // 格式固定為 /callcontrol/{dnnumber}/participants/{id}
        participant = await getParticipants(this.access_token, eventEntity_dn);
      }

      if (!participant.success) {
        errorWithTimestamp(`無法獲取事件實體 ${eventEntity} 的參與者資訊: ${participant.error?.error}`);
        this.setError(`無法獲取事件實體 ${eventEntity} 的參與者資訊: ${participant.error?.error}`);
        return;
      }

      if (participant.data.length === 0) {
        // 代理人用戶空閒了，執行外撥邏輯
        logWithTimestamp(`無法獲取事件實體 ${eventEntity} 這邊可能是對方掛斷了`);
        // 這邊可能是對方掛斷了
        // 解析 eventEntity 來獲取分機資訊
        const eventEntity_dn = eventEntity.split('/')[2]; // 格式固定為 /callcontrol/{dnnumber}/participants/{id}

        // 先取得 callerDn 資訊
        const callerDn = await getCallerDn(this.access_token, eventEntity_dn);
        if (!callerDn.success) {
          errorWithTimestamp(`無法獲取分機 ${eventEntity_dn} 的資訊，跳過外撥`);
          this.setError(`無法獲取分機 ${eventEntity_dn} 的資訊，跳過外撥`);
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
        const currentDeviceId = callerDn.data.devices[0]?.device_id;
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

    const executeEndTime = Date.now();
    logWithTimestamp(`[🟢 executeOutboundCalls 完成] 耗時: ${executeEndTime - executeStartTime}ms`);
  }

  /**
   * 處理單一呼叫者的外撥邏輯
   * 使用全域 Mutex 確保原子性，多個分機會排隊執行
   * @param dn 分機號碼
   * @param deviceId 設備 ID
   * @private
   */
  private async processCallerOutbound(dn: string, deviceId: string): Promise<void> {
    const processStartTime = Date.now();
    logWithTimestamp(`[🔵 processCallerOutbound 開始] dn: ${dn}, deviceId: ${deviceId}`);

    if (!dn || !deviceId) {
      errorWithTimestamp('分機或設備 ID 未定義，無法進行外撥處理');
      return;
    }
    // 注意：Mutex 保護已移到 executeOutboundCalls 外層
    // 該方法已被 executeOutboundCalls 的 Mutex 保護，無需重複加鎖（避免嵌套死鎖）
    try {
        // 從 Redis 獲取下一個要撥打的電話號碼
        logWithTimestamp(`[🔵 processCallerOutbound] 準備從 Redis 取得下一通電話...`);
        const getNextCallStartTime = Date.now();
        const nextCallItem = await CallListManager.getNextCallItem(this.projectId);
        const getNextCallEndTime = Date.now();
        logWithTimestamp(`[🔵 processCallerOutbound] 從 Redis 取得下一通電話完成，耗時: ${getNextCallEndTime - getNextCallStartTime}ms`);

        // 檢查並補充撥號名單（如果數量不足）
        await this.checkAndReplenishCallList();

        // 有撥號名單，進行撥打
        if (nextCallItem) {
          // 初始化 Map（如果需要）
          if (!this.latestCallRecord) {
            this.latestCallRecord = new Map();
          }
          // previousCallRecord 已在類屬性中初始化為 new Map()

          // 檢查該分機是否已有撥打記錄
          const existingCall = this.latestCallRecord.get(dn);
          if (existingCall) {
            // 如果該分機已有撥打記錄，移動到 previousCallRecord
            if (existingCall) {
              // 改為 Map，直接用 get(dn) 獲取舊記錄
              const oldRecord = this.previousCallRecord.get(dn);

              // 如果已經有舊記錄，需要先處理它，避免被覆蓋而遺失
              if (oldRecord) {
                logWithTimestamp(`⚠️ 偵測到分機 ${dn} 有未處理的舊記錄 - 客戶: ${oldRecord.memberName} (${oldRecord.customerId}), 立即處理以避免遺失`);

                try {
                  // 立即處理舊記錄
                  await this.recordBonsaleCallResult(oldRecord);
                  logWithTimestamp(`✅ 已處理分機 ${dn} 的舊記錄 - 客戶: ${oldRecord.memberName} (${oldRecord.customerId})`);
                } catch (error) {
                  errorWithTimestamp(`❌ 處理分機 ${dn} 的舊記錄時發生錯誤:`, error);
                  // 即使處理失敗，也繼續執行，避免阻塞流程
                }
              }

              // 使用 Map.set() 替代陣列操作，直接按分機號覆蓋
              this.previousCallRecord.set(dn, { ...existingCall });

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
          this.latestCallRecord.set(dn, newCallRecord);

          // 同步更新到 Redis
          await ProjectManager.updateProjectLatestCallRecord(this.projectId, this.latestCallRecord);
          
          // 有撥號名單，進行撥打
          logWithTimestamp(`準備撥打 - 客戶: ${nextCallItem.memberName} (${nextCallItem.customerId}), 電話: ${nextCallItem.phone}, 分機: ${dn}`);
          await this.makeOutboundCall(dn, deviceId, nextCallItem.phone, 2000);
        } else {
          // 沒有撥號名單，但要檢查該分機是否有當前撥打記錄需要處理
          logWithTimestamp(`專案 ${this.projectId} 的撥號名單已空，分機 ${dn} 暫無可撥打號碼`);

          // 初始化 Map（如果需要）
          if (!this.latestCallRecord) {
            this.latestCallRecord = new Map();
          }
          // previousCallRecord 已在類屬性中初始化為 new Map()

          // 檢查該分機是否有當前撥打記錄需要移動到 previousCallRecord
          const existingCall = this.latestCallRecord.get(dn);
          if (existingCall) {
            // 改為 Map，直接用 get(dn) 獲取舊記錄
            const oldRecord = this.previousCallRecord.get(dn);

            // 如果已經有舊記錄，需要先處理它，避免被覆蓋而遺失
            if (oldRecord) {
              logWithTimestamp(`⚠️ 偵測到分機 ${dn} 有未處理的舊記錄 - 客戶: ${oldRecord.memberName} (${oldRecord.customerId}), 立即處理以避免遺失`);

              try {
                // 立即處理舊記錄
                await this.recordBonsaleCallResult(oldRecord);
                logWithTimestamp(`✅ 已處理分機 ${dn} 的舊記錄 - 客戶: ${oldRecord.memberName} (${oldRecord.customerId})`);
              } catch (error) {
                errorWithTimestamp(`❌ 處理分機 ${dn} 的舊記錄時發生錯誤:`, error);
                // 即使處理失敗，也繼續執行，避免阻塞流程
              }
            }

            // 使用 Map.set() 替代陣列操作，直接按分機號覆蓋
            this.previousCallRecord.set(dn, { ...existingCall });

            // 從 latestCallRecord 中移除
            this.latestCallRecord.delete(dn);

            // 同步更新到 Redis
            await ProjectManager.updateProjectLatestCallRecord(this.projectId, this.latestCallRecord);

            logWithTimestamp(`保存分機 ${dn} 的最後一筆撥打記錄到 previousCallRecord - 客戶: ${existingCall.memberName} (${existingCall.customerId})`);
          }
          
          // 即使沒有撥號名單，也要呼叫 makeOutboundCall 來處理前一通電話的結果
          await this.makeOutboundCall(dn, deviceId, null, 2000);
        }
      } catch (error) {
        const errorMsg = `[🔵 processCallerOutbound] 處理分機 ${dn} 外撥時發生錯誤: ${error instanceof Error ? error.message : String(error)}`;
        await this.setError(errorMsg);
        errorWithTimestamp(errorMsg, error);
      }

      const processEndTime = Date.now();
      logWithTimestamp(`[🔵 processCallerOutbound 完成] dn: ${dn}, 耗時: ${processEndTime - processStartTime}ms`);
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
    const makeCallStartTime = Date.now();
    logWithTimestamp(`[🟡 makeOutboundCall 開始] dn: ${dn}, targetNumber: ${targetNumber}`);

    try {
      if (!this.access_token) {
        throw new Error('access_token 為空');
      }

      // 添加延遲
      logWithTimestamp(`[🟡 makeOutboundCall] 等待 ${delayMs}ms 後撥打電話: ${dn} -> ${targetNumber}`);
      await this.delay(delayMs);

      // 改為 Map，檢查是否有該分機的前一筆撥打記錄
      if (this.previousCallRecord && this.previousCallRecord.size > 0) {
        const previousCallForThisExtension = this.previousCallRecord.get(dn);
        if (previousCallForThisExtension) {
          // 有該分機的前一筆撥打記錄，執行寫紀錄到 Bonsale 裡面
          logWithTimestamp(`[🟡 makeOutboundCall] 準備記錄前一通電話結果 - 客戶: ${previousCallForThisExtension.memberName} (${previousCallForThisExtension.customerId})`);
          const recordStartTime = Date.now();
          await this.recordBonsaleCallResult(previousCallForThisExtension);
          const recordEndTime = Date.now();
          logWithTimestamp(`[🟡 makeOutboundCall] 記錄前一通電話結果完成，耗時: ${recordEndTime - recordStartTime}ms`);

          // 處理完成後，從 previousCallRecord 中移除該記錄，避免重複處理
          this.previousCallRecord.delete(dn);
          logWithTimestamp(`已移除分機 ${dn} 的已處理記錄，剩餘 previousCallRecord: ${this.previousCallRecord.size} 筆`);
        }
      }
      if (!targetNumber) {
        logWithTimestamp(`[🟡 makeOutboundCall] 分機 ${dn} 無撥號名單，跳過撥打`);
        return;
      }

      // 發起外撥
      logWithTimestamp(`[🟡 makeOutboundCall] 準備發起外撥: ${dn} -> ${targetNumber}`);
      const callStartTime = Date.now();
      await makeCall(this.access_token, dn, deviceId, "outbound", targetNumber);
      const callEndTime = Date.now();
      logWithTimestamp(`[🟡 makeOutboundCall] 成功發起外撥，耗時: ${callEndTime - callStartTime}ms - ${dn} -> ${targetNumber}`);

      const makeCallEndTime = Date.now();
      logWithTimestamp(`[🟡 makeOutboundCall 完成] 總耗時: ${makeCallEndTime - makeCallStartTime}ms`);
    } catch (error) {
      const errorMsg = `外撥失敗 ${dn} -> ${targetNumber}: ${error instanceof Error ? error.message : String(error)}`;
      await this.setError(errorMsg);
      errorWithTimestamp(`[🟡 makeOutboundCall] 外撥失敗 ${dn} -> ${targetNumber}:`, error);
      const makeCallEndTime = Date.now();
      logWithTimestamp(`[🟡 makeOutboundCall 失敗] 總耗時: ${makeCallEndTime - makeCallStartTime}ms`);
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
    const recordStartTime = Date.now();
    logWithTimestamp(`[🟢 recordBonsaleCallResult 開始] 客戶: ${previousCallRecord?.memberName} (${previousCallRecord?.customerId}), 分機: ${previousCallRecord?.dn}`);

    try {
      // 這裡可以根據當前的 caller 狀態來判斷前一通電話的通話結果
      if (!previousCallRecord) {
        warnWithTimestamp('沒有前一筆撥打記錄可供寫入 Bonsale');
        return;
      }
      logWithTimestamp(`[🟢 recordBonsaleCallResult] 準備記錄 Bonsale 通話結果 - 客戶: ${previousCallRecord.memberName} (${previousCallRecord.customerId}), 分機: ${previousCallRecord.dn}`);
      
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
            // 紀錄分機最後執行時間
            await this.recordCallerExtensionLastExecutionTime(previousCallRecord.dn);

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
            // 紀錄分機最後執行時間
            await this.recordCallerExtensionLastExecutionTime(previousCallRecord.dn);

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
      const errorMsg = `[🟢 recordBonsaleCallResult] 記錄 Bonsale 通話結果失敗: ${error instanceof Error ? error.message : String(error)}`;
      await this.setError(errorMsg);
      errorWithTimestamp(errorMsg, error);

      // 即使發生錯誤，也要移除使用過的撥號名單項目，避免名單殘存
      if (previousCallRecord) {
        try {
          await CallListManager.removeUsedCallListItem(previousCallRecord.projectId, previousCallRecord.customerId);
          logWithTimestamp(`[🟢 recordBonsaleCallResult] 🗑️ 已移除異常處理中的撥號名單項目 - 專案: ${previousCallRecord.projectId}, 客戶: ${previousCallRecord.customerId}`);
        } catch (removeError) {
          errorWithTimestamp(`[🟢 recordBonsaleCallResult] ❌ 移除異常處理中撥號名單項目時發生錯誤:`, removeError);
        }
      }
      const recordEndTime = Date.now();
      logWithTimestamp(`[🟢 recordBonsaleCallResult 失敗] 耗時: ${recordEndTime - recordStartTime}ms`);
      // 不拋出錯誤，避免影響主要的外撥流程
    }

    const recordEndTime = Date.now();
    logWithTimestamp(`[🟢 recordBonsaleCallResult 完成] 耗時: ${recordEndTime - recordStartTime}ms`);
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
      // 注意：由於 WebSocket onMessage 可能持有 Mutex，這裡不能 await throttledOutboundCall
      // 以免造成死鎖。改為 fire-and-forget，讓它在背景執行
      this.outboundCall(broadcastWs, null, true, true).catch(error => {
        errorWithTimestamp('異步執行初始外撥邏輯時發生錯誤:', error);
      });
      
      // 啟動空閒檢查定時器
      if (IS_STARTIDLECHECK) {
        logWithTimestamp(`🕰️ 啟動空閒檢查定時器 - 專案: ${this.projectId}`);
        logWithTimestamp(`🕰️ 空閒檢查參數 - 初始間隔: ${this.minIdleCheckInterval / 1000}秒, 最大間隔: ${this.maxIdleCheckInterval / 1000}秒`);
        logWithTimestamp(`🕰️ 空閒檢查指數退避參數 - 乘數: ${this.idleCheckBackoffFactor}`);
        this.startIdleCheck(broadcastWs);
      } else {
        logWithTimestamp(`⏸️ 未啟動空閒檢查定時器（IS_STARTIDLECHECK=${IS_STARTIDLECHECK}） - 專案: ${this.projectId}`);
      }

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
            this.processWebSocketMessage(broadcastWs, data);
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

    // 🆕 冷卻時間常數 (6分鐘)
    const EXTENSION_COOLDOWN_TIME_MS = 60000;

    // 檢查是否有空閒且非忙碌的分機，並且不在冷卻期內
    const hasIdleExtension = this.caller.some(caller => {
      // 檢查分機是否空閒（沒有通話中）
      const isIdle = !caller.participants || caller.participants.length === 0;

      if (!isIdle) {
        return false;
      }

      // 🆕 檢查分機是否在冷卻期內（防止重複撥號）
      const dn = caller.dn;
      const lastExecutionTime = this.callerExtensionLastExecutionTime[dn];

      if (lastExecutionTime) {
        const now = new Date();
        const lastTime = new Date(lastExecutionTime);
        const timeDiffMs = now.getTime() - lastTime.getTime();
        const timeDiffSeconds = timeDiffMs / 1000;

        // 如果距離上次執行少於 1 分鐘，則跳過此分機
        if (timeDiffMs < EXTENSION_COOLDOWN_TIME_MS) {
          logWithTimestamp(
            `⏱️ 分機 ${dn} 在冷卻期內 (${timeDiffSeconds.toFixed(1)}s)，跳過此次撥號`
          );
          return false;
        }
      }

      return true;
    });

    if (hasIdleExtension) {
      logWithTimestamp(`🔄 檢測到空閒分機，準備延遲觸發外撥邏輯 - 專案: ${this.projectId}`);

      // 添加隨機延遲（4-6秒），避免多個定時器同時觸發造成的競態條件
      const randomDelay = Math.random() * 2000 + 4000; // 4000-6000ms 的隨機延遲

      setTimeout(() => {
        logWithTimestamp(`🔄 延遲後觸發外撥邏輯 - 專案: ${this.projectId}`);
        // 注意：不 await，讓它在背景執行，避免可能的死鎖
        this.outboundCall(this.broadcastWsRef, null, true, true)!.catch(error => {
          errorWithTimestamp('延遲觸發外撥邏輯時發生錯誤:', error);
        });
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
   * 使用 isHandlingStop 旗標防止重複執行
   * @param broadcastWs 廣播 WebSocket 伺服器實例
   * @private
   */
  private async handleStopStateLogic(
    broadcastWs: WebSocketServer,
    participantSnapshot?: { success: boolean; data?: Participant; error?: { errorCode: string; error: string; } } | null,
    eventEntity?: string | null
  ): Promise<void> {
    try {
      logWithTimestamp(`🛑 專案 ${this.projectId} 開始處理停止狀態邏輯`);

      // 只更新該分機的 caller 資訊（不調用全局函數，避免競爭）
      if (participantSnapshot && participantSnapshot.success && this.caller && participantSnapshot.data && eventEntity) {
        const eventEntity_dn = eventEntity.split('/')[2];
        const participant = participantSnapshot.data;
        const callerIndex = this.caller.findIndex(c => c.dn === eventEntity_dn);
        if (callerIndex >= 0) {
          // 如果 participant 已經是陣列，直接賦值；否則包裝成陣列
          this.caller[callerIndex].participants = Array.isArray(participant)
            ? participant
            : [participant] as Participants[];
          logWithTimestamp(`[分機 ${eventEntity_dn}] 已更新 caller 資訊 (停止狀態)`);
        }

        // 更新到 Redis
        await ProjectManager.updateProjectCaller(this.projectId, this.caller);
      }

      // 只更新該分機的 latestCallRecord 狀態（不調用全局函數，避免競爭）
      if (participantSnapshot && eventEntity) {
        const eventEntity_dn = eventEntity.split('/')[2];
        const currentCall = this.latestCallRecord.get(eventEntity_dn);
        if (currentCall && participantSnapshot?.data?.status) {
          const newStatus = participantSnapshot.data.status as "Dialing" | "Connected";
          if (currentCall.status !== newStatus) {
            const oldStatus = currentCall.status;
            this.latestCallRecord.set(eventEntity_dn, {
              ...currentCall,
              status: newStatus
            });
            logWithTimestamp(`[分機 ${eventEntity_dn}] 撥打狀態已更新 (停止狀態): ${oldStatus} -> ${newStatus}`);

            // 同步該分機的更新到 Redis
            await ProjectManager.updateProjectLatestCallRecord(this.projectId, this.latestCallRecord);
          }
        }
      }

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
    } finally {
      logWithTimestamp(`✅ 專案 ${this.projectId} 完成停止狀態邏輯處理`);
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
      if (this.latestCallRecord && this.latestCallRecord.size > 0) {
        logWithTimestamp(`📞 發現 ${this.latestCallRecord.size} 筆未處理的通話記錄`);

        // 將所有 latestCallRecord 移動到 previousCallRecord 以便處理
        for (const callRecord of this.latestCallRecord.values()) {
          if (callRecord) {
            // previousCallRecord 已在類屬性中初始化為 new Map()
            // 改為 Map，直接用 set() 覆蓋或新增記錄
            this.previousCallRecord.set(callRecord.dn, { ...callRecord });

            logWithTimestamp(`📋 移動通話記錄到待處理清單 - 分機: ${callRecord.dn}, 客戶: ${callRecord.memberName} (${callRecord.customerId})`);
          }
        }

        // 清空 latestCallRecord
        this.latestCallRecord.clear();

        // 更新到 Redis
        await ProjectManager.updateProjectLatestCallRecord(this.projectId, this.latestCallRecord);
      }

      // 處理所有 previousCallRecord
      if (this.previousCallRecord && this.previousCallRecord.size > 0) {
        logWithTimestamp(`🔄 開始處理 ${this.previousCallRecord.size} 筆待處理的通話記錄`);

        // 改為 Map，直接遍歷 values()
        const processPromises = Array.from(this.previousCallRecord.values())
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

        // 使用 Map.clear() 清空 previousCallRecord
        this.previousCallRecord.clear();
        
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