import express, { Router } from 'express';
import { createServer } from "http";
import { Server } from "socket.io";
import app from '../app';
import { create3CXWebSocket } from '../services/websocket/create3CXWebSocket';
import { roomWebSockets } from '../services/websocket/connectionManager';

const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST'],
    credentials: true
  }
});

io.on('connection', (socket) => {
  console.log(`客戶端已連線，ID: ${socket.id}`);

  // 處理加入房間
  socket.on('join room', (room) => {
    socket.join(room);
    console.log(`客戶端 ${socket.id} 加入房間 ${room}`);
  });

  // 處理離開房間
  socket.on('leave room', (room) => {
    socket.leave(room);
    console.log(`客戶端 ${socket.id} 離開房間 ${room}`);
  });

  socket.on('disconnect', () => {
    console.log(`客戶端已斷線，ID: ${socket.id}`);
  });
});

console.log(`🚀 Socket.IO server is running at http://localhost:4020`);

const router: Router = express.Router();

export default router;