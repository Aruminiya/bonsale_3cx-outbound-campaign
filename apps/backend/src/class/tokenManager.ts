import jwt from 'jsonwebtoken';
import { logWithTimestamp, warnWithTimestamp, errorWithTimestamp } from '../util/timestamp';
import { get3cxToken, getCaller } from '../services/api/callControl';
import { ProjectManager } from '../class/projectManager';

/**
 * Token 管理器類別
 * 負責處理 JWT token 的解析、驗證、刷新等功能
 */
export class TokenManager {
  private clientId: string;
  private clientSecret: string;
  private projectId: string;
  private accessToken: string | null;

  /**
   * TokenManager 構造函數
   * @param clientId 3CX 客戶端 ID
   * @param clientSecret 3CX 客戶端密鑰
   * @param projectId 專案 ID
   * @param accessToken 存取權杖
   */
  constructor(clientId: string, clientSecret: string, projectId: string, accessToken: string | null = null) {
    this.clientId = clientId;
    this.clientSecret = clientSecret;
    this.projectId = projectId;
    this.accessToken = accessToken;
  }

  /**
   * 獲取當前的 access token
   * @returns string | null - 當前的存取權杖，如果不存在則返回 null
   */
  getAccessToken(): string | null {
    return this.accessToken;
  }

  /**
   * 更新 access token
   * @param newToken 新的存取權杖
   */
  updateAccessToken(newToken: string): void {
    this.accessToken = newToken;
  }

  /**
   * 解析 JWT payload
   * @param token JWT token
   * @returns 解析後的 payload 或 null
   * @private
   */
  private parseJwtPayload(token: string): { exp?: number; [key: string]: unknown } | null {
    try {
      // 使用 jsonwebtoken 套件解碼 JWT（不驗證簽名，僅解碼）
      const decoded = jwt.decode(token) as { exp?: number; [key: string]: unknown } | null;
      
      if (!decoded) {
        throw new Error('Failed to decode JWT token');
      }
      
      return decoded;
    } catch (error) {
      errorWithTimestamp('解析 JWT token 失敗:', error);
      return null;
    }
  }

  /**
   * 檢查 token 是否過期
   * @param token JWT token
   * @param bufferMinutes 緩衝時間（分鐘），提前這麼多時間就認為需要刷新，預設 5 分鐘
   * @returns boolean - true 如果 token 已過期或即將過期，false 如果仍有效
   */
  isTokenExpired(token: string, bufferMinutes: number = 5): boolean {
    try {
      const payload = this.parseJwtPayload(token);
      if (!payload || !payload.exp) {
        // 如果無法解析或沒有過期時間，假設已過期
        warnWithTimestamp('Token 缺少過期時間資訊，假設已過期');
        return true;
      }
      
      const expirationTime = payload.exp * 1000; // JWT exp 是秒，轉換為毫秒
      const currentTime = Date.now();
      const bufferTime = bufferMinutes * 60 * 1000; // 緩衝時間轉換為毫秒
      
      // 如果 token 在緩衝時間內過期，就認為需要刷新
      const isExpired = currentTime >= (expirationTime - bufferTime);
      
      if (isExpired) {
        const remainingTime = Math.max(0, expirationTime - currentTime);
        logWithTimestamp(`Token 將在 ${Math.round(remainingTime / 1000 / 60)} 分鐘內過期，需要刷新`);
      } else {
        const remainingTime = expirationTime - currentTime;
        logWithTimestamp(`Token 還有 ${Math.round(remainingTime / 1000 / 60)} 分鐘有效`);
      }
      
      return isExpired;
    } catch (error) {
      errorWithTimestamp('檢查 token 過期時間失敗:', error);
      return true; // 出錯時假設已過期
    }
  }

  /**
   * 檢查並刷新 token
   * @param bufferMinutes 緩衝時間（分鐘），預設 5 分鐘
   * @returns Promise<boolean> - true 如果 token 有效，false 如果無法獲得有效 token
   */
  async checkAndRefreshToken(bufferMinutes: number = 5): Promise<boolean> {
    try {
      if (!this.accessToken) {
        logWithTimestamp('當前沒有 access_token');
        return false;
      }

      // 使用 getCaller 驗證 token 是否可用
      const callerResult = await getCaller(this.accessToken);
      if (!callerResult.success) {
        warnWithTimestamp('Token 無法使用（getCaller 驗證失敗），需要重新獲取:', callerResult.error);
        return await this.forceRefreshToken();
      }

      // 檢查 token 是否即將過期
      if (!this.isTokenExpired(this.accessToken, bufferMinutes)) {
        // Token 仍然有效且可用，無需刷新
        return true;
      }
      
      // Token 即將過期或已過期，嘗試刷新
      logWithTimestamp('Token 即將過期，開始刷新 access token...');
      
      const newTokenResult = await get3cxToken(this.clientId, this.clientSecret);
      
      if (!newTokenResult.success) {
        errorWithTimestamp('刷新 access token 失敗:', newTokenResult.error);
        
        // 如果刷新失敗，檢查當前 token 是否還沒完全過期且可用
        if (!this.isTokenExpired(this.accessToken, 0)) {
          // 再次驗證 token 是否可用
          const fallbackCallerResult = await getCaller(this.accessToken, 'extension');
          if (fallbackCallerResult.success) {
            warnWithTimestamp('Token 刷新失敗，但當前 token 仍然有效，繼續使用');
            return true;
          }
        }
        return false;
      }
      
      const { access_token } = newTokenResult.data;
      
      // 更新當前實例的 token
      this.accessToken = access_token;
      
      // 更新 Redis 中的 token
      await ProjectManager.updateProjectAccessToken(this.projectId, access_token);
      
      logWithTimestamp('Access token 已成功刷新');
      return true;
      
    } catch (error) {
      errorWithTimestamp('檢查和刷新 token 時發生錯誤:', error);
      return false;
    }
  }

  /**
   * 獲取 token 的剩餘有效時間（分鐘）
   * @param token JWT token
   * @returns number - 剩餘時間（分鐘），如果無法解析則返回 0
   */
  getTokenRemainingTime(token: string): number {
    try {
      const payload = this.parseJwtPayload(token);
      if (!payload || !payload.exp) {
        return 0;
      }
      
      const expirationTime = payload.exp * 1000;
      const currentTime = Date.now();
      const remainingTime = Math.max(0, expirationTime - currentTime);
      
      return Math.round(remainingTime / 1000 / 60); // 轉換為分鐘
    } catch (error) {
      errorWithTimestamp('獲取 token 剩餘時間失敗:', error);
      return 0;
    }
  }

  /**
   * 強制刷新 token
   * @returns Promise<boolean> - true 如果刷新成功，false 如果失敗
   */
  async forceRefreshToken(): Promise<boolean> {
    try {
      logWithTimestamp('強制刷新 access token...');
      
      const newTokenResult = await get3cxToken(this.clientId, this.clientSecret);
      
      if (!newTokenResult.success) {
        errorWithTimestamp('強制刷新 access token 失敗:', newTokenResult.error);
        return false;
      }
      
      const { access_token } = newTokenResult.data;
      
      // 更新當前實例的 token
      this.accessToken = access_token;
      
      // 更新 Redis 中的 token
      await ProjectManager.updateProjectAccessToken(this.projectId, access_token);
      
      logWithTimestamp('Access token 強制刷新成功');
      return true;
      
    } catch (error) {
      errorWithTimestamp('強制刷新 token 時發生錯誤:', error);
      return false;
    }
  }
}
