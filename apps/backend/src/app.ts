import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import dotenv from 'dotenv';
import { createServer } from 'http';
import { WebSocketServer } from 'ws';

import { router as bonsaleRouter, clientWsWebHook } from './routes/bonsale';

import { logWithTimestamp, warnWithTimestamp, errorWithTimestamp } from './util/timestamp';
import Project from './class/project';
import { initRedis, closeRedis } from './services/redis';
import { broadcastAllProjects, broadcastError } from './components/broadcast';
import { ProjectManager } from './class/projectManager';
import { CallListManager } from './class/callListManager';

// Load environment variables
dotenv.config();

const app: express.Application = express();
const PORT = process.env.HTTP_PORT || 4020;

// Middleware
app.use(helmet()); // Security headers
app.use(cors()); // Enable CORS
app.use(morgan('dev')); // Logging
app.use(express.json({ limit: '10mb' })); // Parse JSON bodies
app.use(express.urlencoded({ extended: true })); // Parse URL-encoded bodies

// Mount API routes
app.use('/api/bonsale', bonsaleRouter);

// Root endpoint
app.get('/', (req, res) => {
  res.json({
    message: 'Welcome to the API',
    version: '0.0.1'
  });
});

// 404 handler
app.use('*', (req, res) => {
  res.status(404).json({
    success: false,
    message: 'Route not found'
  });
});

// Error handling middleware
app.use((err: Error, req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error('Error:', err);
  
  res.status(500).json({
    success: false,
    message: err.message || 'Internal server error',
    ...(process.env.NODE_ENV === 'development' && { stack: err.stack })
  });
});

// Start server
const httpServer = createServer(app);

// 建立主要 WebSocket 服務器
const mainWebSocketServer = new WebSocketServer({ noServer: true });

// 處理 WebSocket 升級請求
httpServer.on('upgrade', (request, socket, head) => {
  const pathname = new URL(request.url!, `http://${request.headers.host}`).pathname;
  
  if (pathname === '/api/bonsale/WebHook') {
    // 處理 Bonsale WebHook WebSocket 連接
    clientWsWebHook.handleUpgrade(request, socket, head, (websocket) => {
      clientWsWebHook.emit('connection', websocket, request);
    });
  } else {
    // 處理主要的 WebSocket 連接
    mainWebSocketServer.handleUpgrade(request, socket, head, (websocket) => {
      mainWebSocketServer.emit('connection', websocket, request);
    });
  }
});

// 輕量級管理：只維護活躍專案實例的引用（用於正確停止）
const activeProjects = new Map<string, Project>();

/**
 * 自動恢復之前的活躍專案
 * 當服務器重啟後，從 Redis 中恢復之前正在進行的專案
 */
async function recoverActiveProjects(): Promise<void> {
  try {
    // 檢查是否啟用自動恢復功能
    const autoRecover = process.env.AUTO_RECOVER_ON_RESTART;
    if (autoRecover === 'true') {
      logWithTimestamp({ isForce: true }, '🔄 檢查並恢復之前的活躍專案...');
      
      // 從 Redis 獲取所有活躍專案
      const allActiveProjects = await ProjectManager.getAllActiveProjects();
      
      if (allActiveProjects.length === 0) {
        logWithTimestamp({ isForce: true }, '📭 沒有發現需要恢復的專案');
        return;
      }
      
      logWithTimestamp({ isForce: true }, `📋 發現 ${allActiveProjects.length} 個需要恢復的專案`);
      
      // 逐一恢復專案
      for (const savedProject of allActiveProjects) {
        try {
          if (savedProject.state === 'active') {
            logWithTimestamp({ isForce: true }, `🔄 恢復專案: ${savedProject.projectId} (callFlowId: ${savedProject.callFlowId})`);
            
            // 重新初始化專案實例
            const projectInstance = await Project.initOutboundProject({
              projectId: savedProject.projectId,
              callFlowId: savedProject.callFlowId,
              client_id: savedProject.client_id,
              client_secret: savedProject.client_secret || '', // 如果沒有 client_secret，使用空字串
              recurrence: savedProject.recurrence,
              callRestriction: savedProject.callRestriction || []
            });
            
            // 將專案實例保存到活躍專案映射中
            activeProjects.set(savedProject.projectId, projectInstance);
            
            // 清空舊的撥號名單，避免重複撥打
            logWithTimestamp({ isForce: true }, `🗑️ 清空專案 ${savedProject.projectId} 的舊撥號名單...`);
            const clearResult = await CallListManager.removeProjectCallList(savedProject.projectId);
            if (clearResult) {
              logWithTimestamp({ isForce: true }, `✅ 專案 ${savedProject.projectId} 舊撥號名單已清空`);
            } else {
              warnWithTimestamp(`⚠️ 專案 ${savedProject.projectId} 清空撥號名單失敗，但不影響恢復流程`);
            }
            
            // 設定廣播 WebSocket 引用
            projectInstance.setBroadcastWebSocket(mainWebSocketServer);
            
            // 重新建立 3CX WebSocket 連接
            await projectInstance.create3cxWebSocketConnection(mainWebSocketServer);
            
            logWithTimestamp({ isForce: true }, `✅ 專案 ${savedProject.projectId} 恢復成功，代理數量: ${savedProject.agentQuantity}`);
          } else {
            logWithTimestamp(`⏭️ 跳過非活躍專案: ${savedProject.projectId} (狀態: ${savedProject.state})`);
          }
        } catch (error) {
          errorWithTimestamp(`恢復專案 ${savedProject.projectId} 失敗:`, error);
          // 繼續處理下一個專案，不因單個專案失敗而中斷整個恢復流程
        }
      }
      
      logWithTimestamp({ isForce: true }, `🎉 專案恢復完成，成功恢復 ${activeProjects.size} 個專案`);
      
      // 廣播更新後的專案列表
      await broadcastAllProjects(mainWebSocketServer);
    } else {
      logWithTimestamp({ isForce: true }, '⏸️ 自動恢復功能未啟用，跳過專案恢復');

      const clearAllProjectCallListResult = await CallListManager.clearAllProjectCallList();
      if (clearAllProjectCallListResult.success) {
        logWithTimestamp({ isForce: true }, `✅ 成功清空所有專案的舊撥號名單 (共 ${clearAllProjectCallListResult.clearedProjects} 個專案，${clearAllProjectCallListResult.totalRecords} 筆記錄)`);
      } else {
        warnWithTimestamp(`⚠️ 清空所有專案的舊撥號名單失敗，但不影響恢復流程`);
      }

      await ProjectManager.clearAllProjects();
      logWithTimestamp({ isForce: true }, `✅ 成功清空所有專案緩存`);
    }
  } catch (error) {
    errorWithTimestamp('恢復活躍專案時發生錯誤:', error);
    // 恢復失敗不應該阻止服務器啟動
  }
}

mainWebSocketServer.on('connection', async (wsClient) => {
  logWithTimestamp('🔌 WebSocket client connected');
  broadcastAllProjects(mainWebSocketServer);
  
  // 設定心跳機制
  let isAlive = true;
  let heartbeatInterval: NodeJS.Timeout;
  
  // 每60秒發送一次 ping
  const startHeartbeat = () => {
    heartbeatInterval = setInterval(() => {
      if (!isAlive) {
        logWithTimestamp('💔 WebSocket client ping 超時，終止連線');
        wsClient.terminate();
        return;
      }
      
      isAlive = false;
      wsClient.ping();
      // logWithTimestamp('💓 發送 WebSocket ping');
    }, 60000);
  };
  
  // 開始心跳
  startHeartbeat();
  
  // 監聽 pong 回應
  wsClient.on('pong', () => {
    // logWithTimestamp('💚 收到 WebSocket pong');
    isAlive = true;
  });

  wsClient.on('message', async (message) => {
    try {
      const { event, payload } = JSON.parse(message.toString());

      switch (event) {
        case 'ping':
          // 回應前端的 ping 請求
          wsClient.send(JSON.stringify({ event: 'pong', timestamp: Date.now() }));
          break;
        case 'startOutbound':
          // 使用 Project 類的靜態方法初始化專案
          console.log('Received startOutbound event with payload:', payload);
          const projectInstance = await Project.initOutboundProject(payload.project);
          // 將活躍的專案實例保存到Map中（這樣才能正確停止WebSocket連接）
          activeProjects.set(payload.project.projectId, projectInstance);
          // 設定廣播 WebSocket 引用以供錯誤廣播使用
          projectInstance.setBroadcastWebSocket(mainWebSocketServer);
          // 連線 3CX WebSocket，並傳入 mainWebSocketServer 實例以便廣播
          await projectInstance.create3cxWebSocketConnection(mainWebSocketServer);
          break;
        case 'stopOutbound':
          logWithTimestamp('停止 外撥事件:', payload.project);
          // 使用 Project 類的靜態方法停止外撥專案
          const stopSuccess = await Project.stopOutboundProject(payload.project, activeProjects, mainWebSocketServer);
          if (!stopSuccess) {
            warnWithTimestamp(`停止專案 ${payload.project.projectId} 失敗`);
          }
          break;
        default:
          warnWithTimestamp('未知事件:', event);
      }
    } catch (error) {
      errorWithTimestamp('WebSocket message handling error:', error);
      // 發送錯誤訊息給客戶端
      broadcastError(mainWebSocketServer, error);
    }
  });

  wsClient.on('close', () => {
    logWithTimestamp('👋 WebSocket client disconnected');
    // 清理心跳定時器
    if (heartbeatInterval) {
      clearInterval(heartbeatInterval);
    }
  });
  
  wsClient.on('error', (error) => {
    errorWithTimestamp('WebSocket client error:', error);
    // 清理心跳定時器
    if (heartbeatInterval) {
      clearInterval(heartbeatInterval);
    }
  });
});

httpServer.listen(PORT, async () => {
  try {
    // 初始化 Redis 連接
    await initRedis();
    
    logWithTimestamp({ isForce: true }, `🚀 Server is running on port ${PORT}`);
    logWithTimestamp({ isForce: true }, `🌍 Environment: ${process.env.NODE_ENV || 'development'}`);
    logWithTimestamp({ isForce: true }, `🔌 WebSocket server is running on port ${PORT}`);
    logWithTimestamp({ isForce: true }, `🖥️ Bonsale WebHook WebSocket is available on port ${PORT}/api/bonsale/webhook-ws`);
    logWithTimestamp({ isForce: true }, `🔴 Redis server is connected`);
    logWithTimestamp({ isForce: true }, `ℹ️ Version: v0.0.1`);
    
    // 🆕 自動恢復之前的活躍專案
    await recoverActiveProjects();
    
  } catch (error) {
    errorWithTimestamp('啟動服務器失敗:', error);
    process.exit(1);
  }
});

// 優雅關閉
process.on('SIGINT', async () => {
  logWithTimestamp('收到 SIGINT 信號，正在關閉服務器...');
  try {
    // 關閉 Redis 連接
    await closeRedis();
    process.exit(0);
  } catch (error) {
    errorWithTimestamp('關閉服務器失敗:', error);
    process.exit(1);
  }
});

process.on('SIGTERM', async () => {
  logWithTimestamp('收到 SIGTERM 信號，正在關閉服務器...');
  try {
    // 關閉 Redis 連接
    await closeRedis();
    process.exit(0);
  } catch (error) {
    errorWithTimestamp('關閉服務器失敗:', error);
    process.exit(1);
  }
});

export default app;