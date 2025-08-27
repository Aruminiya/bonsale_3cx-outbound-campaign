import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import dotenv from 'dotenv';
import { createServer } from 'http';
import WebSocket, { WebSocketServer } from 'ws';

import { router as bonsaleRouter } from './routes/bonsale';

import { logWithTimestamp, warnWithTimestamp } from './util/timestamp';
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


// 這邊實作 startOutbound 的功能 之後要搬到其他檔案歸類
async function initOutboundProject(projectData: any) {
  // 步驟一: 建立專案並抓 3CX token
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
  logWithTimestamp('Initialized Project:', project);
}


// 建立 WebSocket 服務器
const ws = new WebSocketServer({ server: httpServer });

ws.on('connection', (wsClient) => {
  logWithTimestamp('🔌 WebSocket client connected');

  wsClient.on('message', (message) => {
    const { event, project } = JSON.parse(message.toString());

    switch (event) {
      case 'startOutbound':
        // 處理開始外撥事件
        // logWithTimestamp('開始 外撥事件:', project);
        initOutboundProject(project)
        break;
      case 'stopOutbound':
        // 處理停止外撥事件
        logWithTimestamp('停止 外撥事件:', project);
        break;
      default:
        warnWithTimestamp('未知事件:', event);
    }

    // logWithTimestamp('💬 Received:', message.toString());
    // 廣播給所有連線中的 client
    ws.clients.forEach((client) => {
      if (client.readyState === WebSocket.OPEN) {
        client.send(message.toString());
      }
    });
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