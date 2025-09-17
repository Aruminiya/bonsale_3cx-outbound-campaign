import { WebSocketServer, WebSocket } from 'ws';
import { ProjectManager } from '../services/projectManager';
import { logWithTimestamp, errorWithTimestamp } from '../util/timestamp';

/**
 * 廣播所有專案資訊給所有連線中的 WebSocket 客戶端
 * @param broadcastWs WebSocket 服務器實例
 * @param includeProjectId 可選：特定專案 ID，用於日誌記錄
 */
export async function broadcastAllProjects(
  broadcastWs: WebSocketServer, 
  includeProjectId?: string
): Promise<void> {
  try {
    // 獲取所有活躍專案和統計資訊
    const [allProjects, projectStats] = await Promise.all([
      ProjectManager.getAllActiveProjects(),
      ProjectManager.getProjectStats()
    ]);
    
    // 構建廣播訊息 - 統一格式
    const allProjectsMessage = JSON.stringify({
      event: 'allProjects',
      payload: {
        allProjects: allProjects.map(p => ({
          projectId: p.projectId,
          callFlowId: p.callFlowId,
          state: p.state,
          client_id: p.client_id,
          agentQuantity: p.agentQuantity,
          caller: p.caller,
          latestCallRecord: p.latestCallRecord || null, // 直接使用，因為 Project 實例中已經是正確的型別
          access_token: p.access_token ? '***' : null, // 隱藏敏感資訊
          recurrence: p.recurrence || null,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString()
        })),
        stats: projectStats,
        timestamp: new Date().toISOString(),
        triggeredBy: includeProjectId || 'system' // 記錄是哪個專案觸發的廣播
      }
    });

    // 廣播給所有連線中的客戶端
    let connectedClients = 0;
    broadcastWs.clients.forEach((client) => {
      if (client.readyState === WebSocket.OPEN) {
        client.send(allProjectsMessage);
        connectedClients++;
      }
    });
    
    // 記錄廣播結果
    const triggerInfo = includeProjectId ? `由專案 ${includeProjectId} 觸發` : '系統觸發';
    logWithTimestamp(
      `✅ 已廣播所有專案資訊 (${triggerInfo}) - ` +
      `專案數: ${allProjects.length}, 客戶端數: ${connectedClients}`
    );
    
  } catch (error) {
    errorWithTimestamp('❌ 廣播所有專案資訊失敗:', error);
    throw error; // 重新拋出錯誤，讓調用方決定如何處理
  }
}

/**
 * 廣播有錯誤發生的資訊給所有連線中的 WebSocket 客戶端
 * @param broadcastWs WebSocket 服務器實例
 * @param errorInfo 錯誤資訊
 */
export async function broadcastError(
  broadcastWs: WebSocketServer,
  errorInfo: unknown
): Promise<void> {
  // 處理錯誤對象，確保可以正確序列化
  let errorData: Record<string, unknown>;
  
  if (errorInfo instanceof Error) {
    errorData = {
      name: errorInfo.name,
      message: errorInfo.message,
      stack: process.env.NODE_ENV === 'development' ? errorInfo.stack : undefined
    };
    
    // 如果有 cause 屬性，也加入
    if ('cause' in errorInfo && errorInfo.cause) {
      errorData.cause = errorInfo.cause;
    }
  } else if (typeof errorInfo === 'string') {
    errorData = {
      message: errorInfo
    };
  } else if (typeof errorInfo === 'object' && errorInfo !== null) {
    errorData = { ...errorInfo as Record<string, unknown> };
  } else {
    errorData = {
      message: String(errorInfo) || 'Unknown error'
    };
  }

  // 構建廣播訊息 - 統一格式
  const errorMessage = JSON.stringify({
    event: 'error',
    payload: {
      error: errorData,
      timestamp: new Date().toISOString()
    }   
  });

  // 廣播給所有連線中的客戶端
  let connectedClients = 0;
  broadcastWs.clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(errorMessage);
      connectedClients++;
    }
  });
  
  errorWithTimestamp(`❌ 已廣播錯誤訊息給 ${connectedClients} 個客戶端:`, errorData);
}