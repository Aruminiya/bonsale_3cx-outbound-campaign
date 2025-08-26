import WebSocket from 'ws';

export function create3CXWebSocket(
  room: string, 
  roomWebSockets: Map<string, WebSocket>
): WebSocket {
  // 假設的 3CX WebSocket 端點（需替換為實際端點和認證參數）
  const ws = new WebSocket('wss://chatserver002.3cx.net/chatchannel?cid=18490&pid=example');

  ws.on('open', () => {
    console.log(`3CX WebSocket 連線已建立`);
  });

  ws.on('message', (data: WebSocket.Data) => {
    // 處理 3CX WS 的訊息並轉發到房間
    console.log(`3CX WebSocket 收到訊息 (房間: ${room}): ${data}`);
  });

  ws.on('error', (error: Error) => {
    console.error(`3CX WebSocket 錯誤 (房間: ${room}): ${error.message}`);
  });

  ws.on('close', () => {
    console.log(`3CX WebSocket 連線已關閉 (房間: ${room})`);
    roomWebSockets.delete(room); // 移除連線記錄
  });

  // 將連線存儲到管理器中
  roomWebSockets.set(room, ws);

  return ws;
}