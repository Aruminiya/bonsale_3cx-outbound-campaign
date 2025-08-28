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
      event: 'projectsUpdate',
      payload: {
        type: 'allProjects',
        data: allProjects.map(p => ({
          projectId: p.projectId,
          callFlowId: p.callFlowId,
          action: p.action,
          client_id: p.client_id,
          agentQuantity: p.agentQuantity,
          caller: p.caller,
          access_token: p.access_token ? '***' : null, // 隱藏敏感資訊
          ws_connected: p.isWebSocketConnected(), // 添加 WebSocket 連接狀態
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
 * 廣播特定類型的訊息給所有連線中的客戶端
 * @param broadcastWs WebSocket 服務器實例
 * @param messageType 訊息類型
 * @param data 要廣播的資料
 * @param additionalInfo 額外資訊
 */
export async function broadcastMessage(
  broadcastWs: WebSocketServer,
  messageType: string,
  data: unknown,
  additionalInfo?: Record<string, unknown>
): Promise<void> {
  try {
    const message = JSON.stringify({
      event: messageType,
      payload: {
        data: data,
        timestamp: new Date().toISOString(),
        ...additionalInfo
      }
    });

    let connectedClients = 0;
    broadcastWs.clients.forEach((client) => {
      if (client.readyState === WebSocket.OPEN) {
        client.send(message);
        connectedClients++;
      }
    });

    logWithTimestamp(`📡 已廣播 ${messageType} 訊息給 ${connectedClients} 個客戶端`);
    
  } catch (error) {
    errorWithTimestamp(`❌ 廣播 ${messageType} 訊息失敗:`, error);
    throw error;
  }
}

/**
 * 廣播專案狀態變更
 * @param broadcastWs WebSocket 服務器實例
 * @param projectId 專案 ID
 * @param oldAction 舊狀態
 * @param newAction 新狀態
 */
export async function broadcastProjectStatusChange(
  broadcastWs: WebSocketServer,
  projectId: string,
  oldAction: string,
  newAction: string
): Promise<void> {
  await broadcastMessage(broadcastWs, 'projectStatusChange', {
    projectId,
    oldAction,
    newAction,
    changedAt: new Date().toISOString()
  });
  
  // 狀態變更後，也廣播所有專案的最新資訊
  await broadcastAllProjects(broadcastWs, projectId);
}
