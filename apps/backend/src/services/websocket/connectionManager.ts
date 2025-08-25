import WebSocket from 'ws';

// 儲存房間與 3CX WebSocket 連線的對應關係
export const roomWebSockets = new Map<string, WebSocket>();

// 清理連線的輔助函數
export function cleanupConnection(room: string): void {
  const ws = roomWebSockets.get(room);
  if (ws) {
    ws.close();
    roomWebSockets.delete(room);
  }
}

// 檢查連線狀態
export function isConnectionActive(room: string): boolean {
  const ws = roomWebSockets.get(room);
  return ws ? ws.readyState === WebSocket.OPEN : false;
}

// 獲取所有活動連線
export function getActiveConnections(): string[] {
  const activeRooms: string[] = [];
  roomWebSockets.forEach((ws, room) => {
    if (ws.readyState === WebSocket.OPEN) {
      activeRooms.push(room);
    }
  });
  return activeRooms;
}
