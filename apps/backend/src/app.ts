import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import dotenv from 'dotenv';
import { createServer } from 'http';
import { WebSocketServer } from 'ws';

import { router as bonsaleRouter } from './routes/bonsale';

import { logWithTimestamp, warnWithTimestamp, errorWithTimestamp } from './util/timestamp';
import Project from './class/project';
import { initRedis, closeRedis } from './services/redis';
import { broadcastAllProjects, broadcastError } from './components/broadcast';
import { extensionStatusManager } from './components/extensionStatusManager';

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

// 建立 WebSocket 服務器
const ws = new WebSocketServer({ server: httpServer });

// 輕量級管理：只維護活躍專案實例的引用（用於正確停止）
const activeProjects = new Map<string, Project>();

ws.on('connection', (wsClient) => {
  logWithTimestamp('🔌 WebSocket client connected');
  broadcastAllProjects(ws);

  wsClient.on('message', async (message) => {
    try {
      const { event, payload } = JSON.parse(message.toString());

      switch (event) {
        case 'startOutbound':
          // 使用 Project 類的靜態方法初始化專案
          const projectInstance = await Project.initOutboundProject(payload.project);
          // 將活躍的專案實例保存到Map中（這樣才能正確停止WebSocket連接）
          activeProjects.set(payload.project.projectId, projectInstance);
          // 設定廣播 WebSocket 引用以供錯誤廣播使用
          projectInstance.setBroadcastWebSocket(ws);
          // 連線 3CX WebSocket，並傳入 ws 實例以便廣播
          await projectInstance.create3cxWebSocketConnection(ws);
          break;
        case 'stopOutbound':
          logWithTimestamp('停止 外撥事件:', payload.project);
          // 使用 Project 類的靜態方法停止外撥專案
          const stopSuccess = await Project.stopOutboundProject(payload.project, activeProjects, ws);
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
      broadcastError(ws, error);
    }
  });

  wsClient.on('close', () => {
    logWithTimestamp('👋 WebSocket client disconnected');
  });
});

httpServer.listen(PORT, async () => {
  try {
    // 初始化 Redis 連接
    await initRedis();
    
    // 初始化分機狀態管理器 (使用管理員權限)
    logWithTimestamp('🔧 正在初始化分機狀態管理器...');
    await extensionStatusManager.startPolling();
    
    logWithTimestamp(`🚀 Server is running on port ${PORT}`);
    logWithTimestamp(`📍 Check: http://localhost:${PORT}`);
    logWithTimestamp(`🌍 Environment: ${process.env.NODE_ENV || 'development'}`);
    logWithTimestamp(`🔌 WebSocket server is running at ws://localhost:${PORT}`);
    logWithTimestamp(`🔴 Redis server is connected`);
    logWithTimestamp(`📊 Extension Status Manager is initialized`);
  } catch (error) {
    errorWithTimestamp('啟動服務器失敗:', error);
    process.exit(1);
  }
});

// 優雅關閉
process.on('SIGINT', async () => {
  logWithTimestamp('收到 SIGINT 信號，正在關閉服務器...');
  try {
    // 停止分機狀態管理器
    extensionStatusManager.stopPolling();
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
    // 停止分機狀態管理器
    extensionStatusManager.stopPolling();
    // 關閉 Redis 連接
    await closeRedis();
    process.exit(0);
  } catch (error) {
    errorWithTimestamp('關閉服務器失敗:', error);
    process.exit(1);
  }
});

export default app;