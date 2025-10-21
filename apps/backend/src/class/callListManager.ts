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
  description: string | null = null; // 描述或備註
  description2: string | null = null; // 第二個描述或備註
  createdAt: string;             // 建立時間 (ISO string)
  updatedAt: string;             // 更新時間 (ISO string)
  dialing: boolean = false;      // 是否正在撥打
  dialingAt: string | null = null; // 撥打開始時間

  constructor(
    projectId: string,
    customerId: string,
    memberName: string,
    phone: string,
    description: string | null,
    description2: string | null,
    dialing: boolean = false,
    dialingAt: string | null = null
  ) {
    this.projectId = projectId;
    this.customerId = customerId;
    this.memberName = memberName;
    this.phone = phone;
    this.description = description;
    this.description2 = description2;
    this.createdAt = new Date().toISOString();
    this.updatedAt = new Date().toISOString();
    this.dialing = dialing;
    this.dialingAt = dialingAt;
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
        description: callListItem.description,
        description2: callListItem.description2,
        projectId: callListItem.projectId,
        createdAt: callListItem.createdAt,
        updatedAt: callListItem.updatedAt,
        dialing: false, // 初始狀態為未撥打
        dialingAt: null // 撥打開始時間
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
   * 通話結束後移除使用過的撥號名單項目（在 recordBonsaleCallResult 後調用）
   * @param projectId 專案 ID
   * @param customerId 客戶 ID
   * @returns Promise<boolean> 是否成功移除
   */
  static async removeUsedCallListItem(projectId: string, customerId: string): Promise<boolean> {
    try {
      const callListKey = this.getCallListKey(projectId);
      
      // 檢查項目是否存在
      const exists = await redisClient.hExists(callListKey, customerId);
      if (!exists) {
        logWithTimestamp(`⚠️ 使用過的撥號名單項目不存在 - 專案: ${projectId}, 客戶: ${customerId}`);
        return false;
      }

      // 刪除 hash field
      const deletedCount = await redisClient.hDel(callListKey, customerId);
      
      if (deletedCount > 0) {
        logWithTimestamp(`🗑️ 成功移除使用過的撥號名單項目 - 專案: ${projectId}, 客戶: ${customerId}`);
        return true;
      } else {
        errorWithTimestamp(`❌ 移除使用過的撥號名單項目失敗，Redis 刪除操作未成功 - 專案: ${projectId}, 客戶: ${customerId} (預期刪除1個項目，實際刪除${deletedCount}個)`);
        return false;
      }
    } catch (error) {
      errorWithTimestamp(`❌ 移除使用過的撥號名單項目失敗 - 專案: ${projectId}, 客戶: ${customerId}:`, error);
      return false;
    }
  }

  /**
   * 獲取下一個要撥打的電話號碼並標記為正在撥打（原子性操作）
   * @param projectId 專案 ID
   * @returns Promise<CallListManager | null> 下一個撥號項目，如果沒有則返回 null
   */
  static async getNextCallItem(projectId: string): Promise<CallListManager | null> {
    try {
      const callListKey = this.getCallListKey(projectId);
      
      // 使用 Lua 腳本確保原子性操作：獲取第一個未標記的項目並標記為正在撥打
      const luaScript = `
        local key = KEYS[1] 
        local fields = redis.call('HKEYS', key)
        if #fields == 0 then
          return nil
        end
        
        -- 遍歷所有 fields，找到第一個沒有 dialing 標記的項目
        for i = 1, #fields do
          local field = fields[i]
          local value = redis.call('HGET', key, field)
          if value then
            local data = cjson.decode(value)
            -- 檢查是否沒有 dialing 標記或標記為 false
            if not data.dialing or data.dialing == false then
              -- 標記為正在撥打
              data.dialing = true
              data.dialingAt = ARGV[1]  -- 撥打開始時間
              local updatedValue = cjson.encode(data)
              redis.call('HSET', key, field, updatedValue)
              return {field, updatedValue}
            end
          end
        end
        return nil
      `;

      // 執行 Lua 腳本，傳入當前時間作為撥打開始時間
      const dialingAt = new Date().toISOString();
      const result = await redisClient.eval(luaScript, {
        keys: [callListKey],
        arguments: [dialingAt]
      }) as [string, string] | null;

      if (!result || !Array.isArray(result) || result.length !== 2) {
        logWithTimestamp(`📞 專案 ${projectId} 的撥號名單已空或所有項目正在撥打中`);
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
      
      // 創建 CallListManager 實例，包含 dialing 狀態
      const callListItem = new CallListManager(
        itemData.projectId,
        itemData.customerId,
        itemData.memberName,
        itemData.phone,
        itemData.description,
        itemData.description2,
        itemData.dialing || false,      // 撥打狀態
        itemData.dialingAt || null      // 撥打開始時間
      );
      
      // 設置原始的時間戳
      callListItem.createdAt = itemData.createdAt;
      callListItem.updatedAt = itemData.updatedAt;

      logWithTimestamp(`📞 標記撥號項目為正在撥打 - 專案: ${projectId}, 客戶: ${callListItem.memberName} (${callListItem.customerId}), 電話: ${callListItem.phone}, 撥打狀態: ${callListItem.dialing}`);
      
      return callListItem;
    } catch (error) {
      errorWithTimestamp('❌ 獲取並標記下一個撥號項目失敗:', error);
      return null;
    }
  }

  /**
   * 獲取專案的撥號名單數量（只計算未正在撥打的項目）
   * @param projectId 專案 ID
   * @returns Promise<number> 可用的撥號名單數量
   */
  static async getCallListCount(projectId: string): Promise<number> {
    try {
      const callListKey = this.getCallListKey(projectId);
      
      // 使用 Lua 腳本計算未標記為正在撥打的項目數量
      const luaScript = `
        local key = KEYS[1]
        local fields = redis.call('HKEYS', key)
        local count = 0
        
        for i = 1, #fields do
          local field = fields[i]
          local value = redis.call('HGET', key, field)
          if value then
            local data = cjson.decode(value)
            -- 只計算沒有正在撥打標記的項目
            if not data.dialing or data.dialing == false then
              count = count + 1
            end
          end
        end
        
        return count
      `;
      
      const count = await redisClient.eval(luaScript, {
        keys: [callListKey],
        arguments: []
      }) as number;
      
      return count || 0;
    } catch (error) {
      errorWithTimestamp('❌ 獲取撥號名單數量失敗:', error);
      return 0;
    }
  }

  /**
   * 檢查客戶是否已存在於撥號名單中
   * @param projectId 專案 ID
   * @param customerId 客戶 ID
   * @returns Promise<boolean> 是否存在
   */
  static async isCustomerExists(projectId: string, customerId: string): Promise<boolean> {
    try {
      const callListKey = this.getCallListKey(projectId);
      const exists = await redisClient.hExists(callListKey, customerId);
      return exists === 1; // Redis hExists 返回 1 表示存在，0 表示不存在
    } catch (error) {
      errorWithTimestamp('❌ 檢查客戶是否存在失敗:', error);
      return false;
    }
  }

  /**
   * 清空專案的所有撥號名單
   * @param projectId 專案 ID
   * @returns Promise<boolean> 是否清空成功
   */
  static async removeProjectCallList(projectId: string): Promise<boolean> {
    try {
      const callListKey = this.getCallListKey(projectId);
      
      // 檢查 key 是否存在
      const exists = await redisClient.exists(callListKey);
      if (!exists) {
        logWithTimestamp(`📭 專案 ${projectId} 的撥號名單已為空`);
        return true;
      }
      
      // 獲取清空前的數量用於日誌
      const countBefore = await redisClient.hLen(callListKey);
      
      // 刪除整個 hash key
      const result = await redisClient.del(callListKey);
      
      if (result === 1) {
        logWithTimestamp(`🗑️ 已清空專案 ${projectId} 的撥號名單 (清空 ${countBefore} 筆記錄)`);
        return true;
      } else {
        errorWithTimestamp(`❌ 清空專案 ${projectId} 撥號名單失敗，Redis 刪除操作未成功 (預期刪除1個key，實際刪除${result}個)`);
        return false;
      }
    } catch (error) {
      errorWithTimestamp(`❌ 清空專案 ${projectId} 撥號名單時發生錯誤:`, error);
      return false;
    }
  }

  /**
   * 清空所有專案的撥號名單
   * @returns Promise<{success: boolean, clearedProjects: number, totalRecords: number}> 清空結果統計
   */
  static async clearAllProjectCallList(): Promise<{success: boolean, clearedProjects: number, totalRecords: number}> {
    try {
      // 使用 SCAN 命令尋找所有撥號名單 key
      const pattern = `${this.CALL_LIST_PREFIX}*`;
      const keys: string[] = [];
      let cursor = '0';
      
      do {
        const result = await redisClient.scan(cursor, {
          MATCH: pattern,
          COUNT: 100
        });
        cursor = result.cursor.toString();
        keys.push(...result.keys);
      } while (cursor !== '0');
      
      if (keys.length === 0) {
        logWithTimestamp(`📭 沒有找到任何撥號名單需要清空`);
        return { success: true, clearedProjects: 0, totalRecords: 0 };
      }
      
      // 統計清空前的總記錄數
      let totalRecords = 0;
      for (const key of keys) {
        const count = await redisClient.hLen(key);
        totalRecords += count;
      }
      
      // 使用 pipeline 批量刪除所有撥號名單 key
      const pipeline = redisClient.multi();
      keys.forEach(key => {
        pipeline.del(key);
      });
      
      const results = await pipeline.exec();
      
      // 檢查執行結果
      const successCount = results?.filter(result => {
        if (!result || !Array.isArray(result)) return false;
        return result[1] === 1;
      }).length || 0;
      const isSuccess = successCount === keys.length;
      
      if (isSuccess) {
        logWithTimestamp(`🗑️ 已清空所有專案的撥號名單 (共 ${keys.length} 個專案，${totalRecords} 筆記錄)`);
        return { success: true, clearedProjects: keys.length, totalRecords };
      } else {
        errorWithTimestamp(`❌ 部分專案撥號名單清空失敗 (成功: ${successCount}/${keys.length})`);
        return { success: false, clearedProjects: successCount, totalRecords };
      }
    } catch (error) {
      errorWithTimestamp(`❌ 清空所有專案撥號名單時發生錯誤:`, error);
      return { success: false, clearedProjects: 0, totalRecords: 0 };
    }
  }
}