import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import dotenv from 'dotenv';
import { createServer } from 'http';
import WebSocket, { WebSocketServer } from 'ws';

import { router as bonsaleRouter } from './routes/bonsale';
import projectOutboundRouter from './routes/projectOutbound';

// Load environment variables
dotenv.config();

const app: express.Application = express();
const PORT = process.env.HTTP_PORT || 4020;

// Middleware
app.use(helmet()); // Security headers
app.use(cors()); // Enable CORS
app.use(morgan('combined')); // Logging
app.use(express.json({ limit: '10mb' })); // Parse JSON bodies
app.use(express.urlencoded({ extended: true })); // Parse URL-encoded bodies

// API Routes
// Mount API routes
app.use('/api/bonsale', bonsaleRouter);
app.use('/api/project-outbound', projectOutboundRouter);

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

// 建立 WebSocket 服務器
const ws = new WebSocketServer({ server: httpServer });

ws.on('connection', (prams) => {
  console.log('🔌 WebSocket client connected');

  prams.on('message', (message) => {
    console.log('💬 Received:', message.toString());
    // 廣播給所有連線中的 client
    ws.clients.forEach((client) => {
      if (client.readyState === WebSocket.OPEN) {
        client.send(message.toString());
      }
    });
  });

  prams.on('close', () => {
    console.log('👋 WebSocket client disconnected');
  });
});

httpServer.listen(PORT, () => {
  console.log(`🚀 Server is running on port ${PORT}`);
  console.log(`📍 Check: http://localhost:${PORT}`);
  console.log(`🌍 Environment: ${process.env.NODE_ENV || 'development'}`);
  console.log(`🔌 WebSocket server is running at ws://localhost:${PORT}`);
});

export default app;