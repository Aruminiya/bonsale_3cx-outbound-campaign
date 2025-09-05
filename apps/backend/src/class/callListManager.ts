import redisClient from '../services/redis';
import { logWithTimestamp, errorWithTimestamp } from '../util/timestamp';

/**
 * 撥號名單管理器
 */
export class CallListManager {
  private static readonly CALL_LIST_PREFIX = 'call_list:';
  
  // 實例屬性
  projectId: string;             // 專案 ID
  customerId: string;            // 客戶 ID
  memberName: string;            // 客戶會員名稱
  phone: string;                 // 電話號碼
  createdAt: string;             // 建立時間 (ISO string)
  updatedAt: string;             // 更新時間 (ISO string)

  constructor(
    projectId: string,
    customerId: string,
    memberName: string,
    phone: string
  ) {
    this.projectId = projectId;
    this.customerId = customerId;
    this.memberName = memberName;
    this.phone = phone;
    this.createdAt = new Date().toISOString();
    this.updatedAt = new Date().toISOString();
  }

  /**
   * 生成撥號名單的 Redis key
   * @param projectId 專案 ID
   * @returns Redis key
   */
  private static getCallListKey(projectId: string): string {
    return `${this.CALL_LIST_PREFIX}${projectId}`;
  }

  /**
   * 添加撥號名單項目到 Redis
   * @param callListItem 撥號名單項目
   * @returns Promise<boolean> 是否成功添加
   */
  static async addCallListItem(callListItem: CallListManager): Promise<boolean> {
    try {
      const callListKey = this.getCallListKey(callListItem.projectId);
      
      // 使用 customerId 作為 hash field，存儲整個項目資料
      const itemData = {
        customerId: callListItem.customerId,
        memberName: callListItem.memberName,
        phone: callListItem.phone,
        projectId: callListItem.projectId,
        createdAt: callListItem.createdAt,
        updatedAt: callListItem.updatedAt
      };

      await redisClient.hSet(callListKey, callListItem.customerId, JSON.stringify(itemData));
      
      logWithTimestamp(`✅ 成功添加撥號名單項目 - 專案: ${callListItem.projectId}, 客戶: ${callListItem.customerId}, 電話: ${callListItem.phone}`);
      return true;
    } catch (error) {
      errorWithTimestamp('❌ 添加撥號名單項目失敗:', error);
      return false;
    }
  }

  /**
   * 移除撥號名單項目從 Redis
   * @param projectId 專案 ID
   * @param customerId 客戶 ID
   * @returns Promise<boolean> 是否成功移除
   */
  static async removeCallListItem(projectId: string, customerId: string): Promise<boolean> {
    try {
      const callListKey = this.getCallListKey(projectId);
      
      // 檢查項目是否存在
      const exists = await redisClient.hExists(callListKey, customerId);
      if (!exists) {
        logWithTimestamp(`⚠️ 撥號名單項目不存在 - 專案: ${projectId}, 客戶: ${customerId}`);
        return false;
      }

      // 刪除 hash field
      const deletedCount = await redisClient.hDel(callListKey, customerId);
      
      if (deletedCount > 0) {
        logWithTimestamp(`✅ 成功移除撥號名單項目 - 專案: ${projectId}, 客戶: ${customerId}`);
        return true;
      } else {
        logWithTimestamp(`❌ 移除撥號名單項目失敗 - 專案: ${projectId}, 客戶: ${customerId}`);
        return false;
      }
    } catch (error) {
      errorWithTimestamp('❌ 移除撥號名單項目失敗:', error);
      return false;
    }
  }
}