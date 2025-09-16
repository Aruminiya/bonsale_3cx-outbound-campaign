import { getAllUsers } from '../services/api/xApi';
import { get3cxToken } from '../services/api/callControl';
import { logWithTimestamp, errorWithTimestamp } from '../util/timestamp';

/**
 * 分機狀態資料結構
 */
interface ExtensionStatus {
  number: string;
  profileName: string;
  lastUpdated: Date;
}

/**
 * 分機狀態管理器
 * 負責統一輪詢所有分機的狀態，避免重複 API 調用
 * 使用管理員權限的 token 進行全域分機狀態監控
 */
export class ExtensionStatusManager {
  private static instance: ExtensionStatusManager;
  private busyExtensions: Map<string, ExtensionStatus> = new Map();
  private pollingInterval: NodeJS.Timeout | null = null;
  private tokenRefreshInterval: NodeJS.Timeout | null = null;
  private currentAccessToken: string | null = null;
  private isPolling: boolean = false;
  private readonly POLLING_INTERVAL = 5000; // 5 秒輪詢一次
  private readonly TOKEN_REFRESH_INTERVAL = 1800000; // 30 分鐘刷新一次 token (3CX token 通常 1 小時過期)
  
  // 管理員憑證 (從環境變數讀取)
  private readonly adminClientId: string;
  private readonly adminClientSecret: string;

  private constructor() {
    // 從環境變數獲取管理員憑證
    this.adminClientId = process.env.ADMIN_3CX_CLIENT_ID || '';
    this.adminClientSecret = process.env.ADMIN_3CX_CLIENT_SECRET || '';
    
    if (!this.adminClientId || !this.adminClientSecret) {
      errorWithTimestamp('❌ 分機狀態管理器初始化失敗：缺少管理員憑證環境變數 ADMIN_3CX_CLIENT_ID 或 ADMIN_3CX_CLIENT_SECRET');
    }
  }

  /**
   * 獲取單例實例
   */
  public static getInstance(): ExtensionStatusManager {
    if (!ExtensionStatusManager.instance) {
      ExtensionStatusManager.instance = new ExtensionStatusManager();
    }
    return ExtensionStatusManager.instance;
  }

  /**
   * 開始輪詢分機狀態 (伺服器啟動時調用一次)
   */
  public async startPolling(): Promise<void> {
    if (this.isPolling) {
      logWithTimestamp('🔄 分機狀態管理器已在運行中，跳過重複啟動');
      return;
    }

    if (!this.adminClientId || !this.adminClientSecret) {
      errorWithTimestamp('❌ 無法啟動分機狀態管理器：缺少管理員憑證');
      return;
    }

    try {
      // 獲取管理員 token
      await this.refreshAdminToken();
      
      if (!this.currentAccessToken) {
        errorWithTimestamp('❌ 無法獲取管理員 token，分機狀態管理器啟動失敗');
        return;
      }

      this.isPolling = true;
      logWithTimestamp('🔄 開始分機狀態輪詢管理器 (使用管理員權限)');

      // 立即執行一次檢查
      await this.checkExtensionStatus();

      // 設定輪詢間隔
      this.pollingInterval = setInterval(() => {
        this.checkExtensionStatus();
      }, this.POLLING_INTERVAL);

      // 設定 token 刷新間隔
      this.tokenRefreshInterval = setInterval(() => {
        this.refreshAdminToken();
      }, this.TOKEN_REFRESH_INTERVAL);

      logWithTimestamp('✅ 分機狀態管理器啟動成功');
    } catch (error) {
      errorWithTimestamp('❌ 分機狀態管理器啟動失敗:', error);
    }
  }

  /**
   * 刷新管理員 token
   * @private
   */
  private async refreshAdminToken(): Promise<void> {
    try {
      logWithTimestamp('🔑 正在刷新管理員 token...');
      const tokenResult = await get3cxToken(this.adminClientId, this.adminClientSecret);
      
      if (!tokenResult.success) {
        throw new Error(`獲取管理員 token 失敗: ${tokenResult.error?.error || 'Unknown error'}`);
      }

      const { access_token } = tokenResult.data;
      if (!access_token) {
        throw new Error('管理員 token 為空');
      }

      this.currentAccessToken = access_token;
      logWithTimestamp('✅ 管理員 token 刷新成功');
    } catch (error) {
      errorWithTimestamp('❌ 刷新管理員 token 失敗:', error);
      // token 刷新失敗時，清空當前 token
      this.currentAccessToken = null;
    }
  }

  /**
   * 停止輪詢分機狀態
   */
  public stopPolling(): void {
    if (this.pollingInterval) {
      clearInterval(this.pollingInterval);
      this.pollingInterval = null;
    }
    
    if (this.tokenRefreshInterval) {
      clearInterval(this.tokenRefreshInterval);
      this.tokenRefreshInterval = null;
    }
    
    this.isPolling = false;
    this.currentAccessToken = null;
    this.busyExtensions.clear();
    logWithTimestamp('⏹️ 分機狀態輪詢管理器已停止');
  }

  /**
   * 檢查指定分機是否忙碌
   * @param extensionNumber 分機號碼
   * @returns boolean - true 表示忙碌，false 表示可用
   */
  public isExtensionBusy(extensionNumber: string): boolean {
    const status = this.busyExtensions.get(extensionNumber);
    if (!status) {
      return false; // 如果找不到記錄，假設分機可用
    }

    // 檢查資料是否過期（超過 10 秒）
    const now = new Date();
    const timeDiff = now.getTime() - status.lastUpdated.getTime();
    if (timeDiff > 10000) {
      // 資料過期，移除並假設分機可用
      this.busyExtensions.delete(extensionNumber);
      return false;
    }

    return true; // 分機忙碌
  }

  /**
   * 獲取所有忙碌分機的狀態
   * @returns Map<string, ExtensionStatus> - 忙碌分機狀態映射
   */
  public getBusyExtensions(): Map<string, ExtensionStatus> {
    return new Map(this.busyExtensions);
  }

  /**
   * 獲取忙碌分機數量
   * @returns number - 忙碌分機數量
   */
  public getBusyExtensionCount(): number {
    return this.busyExtensions.size;
  }

  /**
   * 更新存取權杖 (已廢棄 - 現在使用管理員 token 自動管理)
   * @param _newAccessToken 新的存取權杖 (已不使用)
   * @deprecated 此方法已廢棄，分機狀態管理器現在使用管理員權限自動管理 token
   */
  public updateAccessToken(_newAccessToken: string): void {
    // 此方法保留是為了向後兼容，但不再使用
    logWithTimestamp('⚠️ updateAccessToken 已廢棄，分機狀態管理器現在使用管理員 token 自動管理');
  }

  /**
   * 檢查所有分機狀態
   * @private
   */
  private async checkExtensionStatus(): Promise<void> {
    if (!this.currentAccessToken) {
      errorWithTimestamp('分機狀態檢查失敗：缺少存取權杖');
      return;
    }

    try {
      // 使用 getAllUsers API 獲取所有非 Available 狀態的分機
      const queryString = "$select=Number,CurrentProfileName&$filter=CurrentProfileName ne 'Available'";
      const result = await getAllUsers(this.currentAccessToken, queryString);

      if (!result.success) {
        errorWithTimestamp('獲取分機狀態失敗:', result.error?.error);
        return;
      }

      const users = result.data?.value || [];
      const now = new Date();

      // 清空舊的忙碌分機記錄
      this.busyExtensions.clear();

      // 更新忙碌分機記錄
      for (const user of users) {
        if (user.Number && user.CurrentProfileName) {
          this.busyExtensions.set(user.Number, {
            number: user.Number,
            profileName: user.CurrentProfileName,
            lastUpdated: now
          });
        }
      }

      logWithTimestamp(`📊 分機狀態更新完成 - 忙碌分機數量: ${this.busyExtensions.size}`);

      // 在開發模式下顯示詳細資訊
      // if (this.busyExtensions.size > 0) {
      //   const busyExtensionsList = Array.from(this.busyExtensions.entries())
      //     .map(([number, status]) => `${number}(${status.profileName})`)
      //     .join(', ');
      //   logWithTimestamp(`🔴 忙碌分機: ${busyExtensionsList}`);
      // }

    } catch (error) {
      errorWithTimestamp('檢查分機狀態時發生錯誤:', error);
    }
  }

  /**
   * 獲取管理器狀態資訊（用於除錯）
   */
  public getStatus(): {
    isPolling: boolean;
    busyExtensionCount: number;
    hasAccessToken: boolean;
  } {
    return {
      isPolling: this.isPolling,
      busyExtensionCount: this.busyExtensions.size,
      hasAccessToken: !!this.currentAccessToken
    };
  }
}

// 導出單例實例
export const extensionStatusManager = ExtensionStatusManager.getInstance();
