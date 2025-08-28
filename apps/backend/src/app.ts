import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import dotenv from 'dotenv';
import { createServer } from 'http';
import { WebSocketServer } from 'ws';

import { router as bonsaleRouter } from './routes/bonsale';

import { logWithTimestamp, warnWithTimestamp, errorWithTimestamp } from './util/timestamp';
import { get3cxToken } from './services/api/callControl';
import Project from './class/project';
import { initRedis, closeRedis } from './services/redis';
import { ProjectManager } from './class/projectManager';
import { getCaller } from './services/api/callControl'

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


// TODO 功能實作區
// 這邊實作 startOutbound 的功能 之後要搬到其他檔案歸類
// =================================================================

type ProjectData = {
  projectId: string;
  callFlowId: string;
  client_id: string;
  client_secret: string;
};

// 初始化專案
async function initOutboundProject(projectData: ProjectData) {
  const { projectId, callFlowId, client_id, client_secret } = projectData;

  // 檢查專案是否已存在
  const existingProject = await ProjectManager.getProject(projectId);
  if (existingProject) {
    logWithTimestamp(`專案 ${projectId} 已存在，更新 token 並返回實例`);
    
    // 更新 access token（因為可能已過期）
    const token = await get3cxToken(client_id, client_secret);
    const { access_token } = token.data;
    if (!access_token) {
      throw new Error('Failed to obtain access token');
    }
    
    // 更新專案實例的 token
    existingProject.access_token = access_token;
    
    // 更新 Redis 中的 token
    await ProjectManager.updateProjectAccessToken(projectId, access_token);
    
    logWithTimestamp(`專案 ${projectId} token 已更新`);
    return existingProject;
  }

  const token = await get3cxToken(client_id, client_secret);
  const { access_token } = token.data;
  if (!access_token) {
    throw new Error('Failed to obtain access token');
  }

  const caller = await getCaller(access_token);
  if (!caller.success) {
    throw new Error('Failed to obtain caller information');
  }
  const callerData = caller.data;
  const agentQuantity = caller.data.length;

  const project = new Project(
    client_id,
    client_secret,
    callFlowId,
    projectId,
    'init',
    null,
    access_token,
    callerData,
    agentQuantity
  );

  // 儲存專案到 Redis
  await ProjectManager.saveProject(project);
  
  logWithTimestamp(`專案 ${projectId} 初始化完成並儲存到 Redis`);
  return project;
}



// =================================================================

// 建立 WebSocket 服務器
const ws = new WebSocketServer({ server: httpServer });

ws.on('connection', (wsClient) => {
  logWithTimestamp('🔌 WebSocket client connected');

  wsClient.on('message', async (message) => {
    try {
      const { event, payload } = JSON.parse(message.toString());

      switch (event) {
        case 'startOutbound':
          // 初始化專案並抓 3CX token，儲存到 Redis
          const projectInstance = await initOutboundProject(payload.project);
          // 連線 3CX WebSocket，並傳入 ws 實例以便廣播
          await projectInstance.create3cxWebSocketConnection(ws);
          break;
        case 'stopOutbound':
          logWithTimestamp('停止 外撥事件:', payload.project);
          // 移除專案
          await ProjectManager.removeProject(payload.project.projectId);
          break;
        default:
          warnWithTimestamp('未知事件:', event);
      }
    } catch (error) {
      errorWithTimestamp('WebSocket message handling error:', error);
      // 可以選擇發送錯誤訊息給客戶端
      // if (wsClient.readyState === WebSocket.OPEN) {
      //   wsClient.send(JSON.stringify({ 
      //     error: 'Message processing failed',
      //     message: typeof error === 'object' && error !== null && 'message' in error ? (error as { message?: string }).message : String(error)
      //   }));
      // }
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
    
    logWithTimestamp(`🚀 Server is running on port ${PORT}`);
    logWithTimestamp(`📍 Check: http://localhost:${PORT}`);
    logWithTimestamp(`🌍 Environment: ${process.env.NODE_ENV || 'development'}`);
    logWithTimestamp(`🔌 WebSocket server is running at ws://localhost:${PORT}`);
    logWithTimestamp(`🔴 Redis server is connected`);
  } catch (error) {
    errorWithTimestamp('啟動服務器失敗:', error);
    process.exit(1);
  }
});

// 優雅關閉
process.on('SIGINT', async () => {
  logWithTimestamp('收到 SIGINT 信號，正在關閉服務器...');
  try {
    await closeRedis();
    process.exit(0);
  } catch (error) {
    errorWithTimestamp('關閉 Redis 連接失敗:', error);
    process.exit(1);
  }
});

process.on('SIGTERM', async () => {
  logWithTimestamp('收到 SIGTERM 信號，正在關閉服務器...');
  try {
    await closeRedis();
    process.exit(0);
  } catch (error) {
    errorWithTimestamp('關閉 Redis 連接失敗:', error);
    process.exit(1);
  }
});

export default app;