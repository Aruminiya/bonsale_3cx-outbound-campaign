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

  /**
   * 獲取下一個要撥打的電話號碼並移除該項目（原子性操作）
   * @param projectId 專案 ID
   * @returns Promise<CallListManager | null> 下一個撥號項目，如果沒有則返回 null
   */
  static async getNextCallItem(projectId: string): Promise<CallListManager | null> {
    try {
      const callListKey = this.getCallListKey(projectId);
      
      // 使用 Lua 腳本確保原子性操作：獲取第一個項目並立即刪除
      const luaScript = `
        local key = KEYS[1] 
        local fields = redis.call('HKEYS', key)
        if #fields == 0 then
          return nil
        end
        local firstField = fields[1]
        local value = redis.call('HGET', key, firstField)
        if value then
          redis.call('HDEL', key, firstField)
          return {firstField, value}
        end
        return nil
      `;
      /*
        這段 Lua 腳本的作用是：
          local key = KEYS[1]  -- 這是我們傳入的 Redis key，例如 "call_list:project123"
          local fields = redis.call('HKEYS', key)  -- 獲取所有 hash fields
          if #fields == 0 then  -- 如果沒有任何 fields（撥號名單是空的）
            return nil  -- 返回 nil
          end
          local firstField = fields[1]  -- 取第一個 field（例如 "customer001"）
          local value = redis.call('HGET', key, firstField)  -- 獲取該 field 的值
          if value then  -- 如果值存在
            redis.call('HDEL', key, firstField)  -- 刪除該 field
            return {firstField, value}  -- 返回 field 名稱和值
          end
          return nil  -- 如果沒有值，返回 nil
      */

      // 執行 Lua 腳本
      const result = await redisClient.eval(luaScript, {
        keys: [callListKey],
        arguments: []
      }) as [string, string] | null;

      if (!result || !Array.isArray(result) || result.length !== 2) {
        logWithTimestamp(`📞 專案 ${projectId} 的撥號名單已空`);
        return null;
      }

      const [customerId, itemDataStr] = result;
      
      // 檢查資料是否有效
      if (!customerId || !itemDataStr) {
        logWithTimestamp(`📞 專案 ${projectId} 獲取到無效的撥號資料`);
        return null;
      }

      // 解析資料
      let itemData;
      try {
        itemData = JSON.parse(itemDataStr);
      } catch (parseError) {
        errorWithTimestamp(`❌ 解析撥號項目 JSON 失敗 - 專案: ${projectId}, 原始資料:`, itemDataStr);
        errorWithTimestamp('JSON 解析錯誤:', parseError);
        return null;
      }
      
      // 創建 CallListManager 實例
      const callListItem = new CallListManager(
        itemData.projectId,
        itemData.customerId,
        itemData.memberName,
        itemData.phone
      );
      
      // 設置原始的時間戳
      callListItem.createdAt = itemData.createdAt;
      callListItem.updatedAt = itemData.updatedAt;

      logWithTimestamp(`📞 原子性獲取撥號項目 - 專案: ${projectId}, 客戶: ${callListItem.memberName} (${callListItem.customerId}), 電話: ${callListItem.phone}`);
      
      return callListItem;
    } catch (error) {
      errorWithTimestamp('❌ 原子性獲取下一個撥號項目失敗:', error);
      return null;
    }
  }

  /**
   * 獲取專案的撥號名單數量
   * @param projectId 專案 ID
   * @returns Promise<number> 撥號名單數量
   */
  static async getCallListCount(projectId: string): Promise<number> {
    try {
      const callListKey = this.getCallListKey(projectId);
      const count = await redisClient.hLen(callListKey);
      return count;
    } catch (error) {
      errorWithTimestamp('❌ 獲取撥號名單數量失敗:', error);
      return 0;
    }
  }
}