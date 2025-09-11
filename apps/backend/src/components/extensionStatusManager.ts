import { getAllUsers } from '../services/api/xApi';
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
 */
export class ExtensionStatusManager {
  private static instance: ExtensionStatusManager;
  private busyExtensions: Map<string, ExtensionStatus> = new Map();
  private pollingInterval: NodeJS.Timeout | null = null;
  private currentAccessToken: string | null = null;
  private isPolling: boolean = false;
  private readonly POLLING_INTERVAL = 5000; // 5 秒輪詢一次

  private constructor() {}

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
   * 開始輪詢分機狀態
   * @param accessToken 3CX 存取權杖
   */
  public startPolling(accessToken: string): void {
    if (this.isPolling && this.currentAccessToken === accessToken) {
      return; // 已經在輪詢且 token 相同，不需要重新開始
    }

    // 如果已經在輪詢但 token 不同，先停止舊的輪詢
    if (this.isPolling) {
      this.stopPolling();
    }

    this.currentAccessToken = accessToken;
    this.isPolling = true;

    logWithTimestamp('🔄 開始分機狀態輪詢管理器');

    // 立即執行一次檢查
    this.checkExtensionStatus();

    // 設定輪詢間隔
    this.pollingInterval = setInterval(() => {
      this.checkExtensionStatus();
    }, this.POLLING_INTERVAL);
  }

  /**
   * 停止輪詢分機狀態
   */
  public stopPolling(): void {
    if (this.pollingInterval) {
      clearInterval(this.pollingInterval);
      this.pollingInterval = null;
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
   * 更新存取權杖
   * @param newAccessToken 新的存取權杖
   */
  public updateAccessToken(newAccessToken: string): void {
    if (this.currentAccessToken !== newAccessToken) {
      this.currentAccessToken = newAccessToken;
      if (this.isPolling) {
        // 立即執行一次檢查以使用新 token
        this.checkExtensionStatus();
      }
    }
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
