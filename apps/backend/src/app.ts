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
app.use((err: any, req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error('Error:', err);
  
  res.status(err.status || 500).json({
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

  const token = await get3cxToken(client_id, client_secret);

  const project = new Project(
    client_id,
    client_secret,
    callFlowId,
    projectId,
    'init',
    null,
    token.data.access_token
  );
  // logWithTimestamp('Initialized Project:', project);
  return project;
}



// =================================================================

// 建立 WebSocket 服務器
const ws = new WebSocketServer({ server: httpServer });

ws.on('connection', (wsClient) => {
  logWithTimestamp('🔌 WebSocket client connected');

  wsClient.on('message', async (message) => {
    try {
      const { event, project } = JSON.parse(message.toString());

      switch (event) {
        case 'startOutbound':
          // 步驟一: 初始化專案並抓 3CX token
          const projectInstance = await initOutboundProject(project);
          // 步驟二: 連線 3CX WebSocket，並傳入 ws 實例以便廣播
          await projectInstance.create3cxWebSocketConnection(ws);
          break;
        case 'stopOutbound':
          logWithTimestamp('停止 外撥事件:', project);
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

httpServer.listen(PORT, () => {
  logWithTimestamp(`🚀 Server is running on port ${PORT}`);
  logWithTimestamp(`📍 Check: http://localhost:${PORT}`);
  logWithTimestamp(`🌍 Environment: ${process.env.NODE_ENV || 'development'}`);
  logWithTimestamp(`🔌 WebSocket server is running at ws://localhost:${PORT}`);
});

export default app;