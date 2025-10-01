import { useCallback, useEffect, useRef } from 'react';

// 取得本機 IP domain
const { hostname } = window.location;
const WS_PROTOCOL = import.meta.env.VITE_WS_PROTOCOL;
const PORT = import.meta.env.VITE_API_PORT;
const DOMAIN = import.meta.env.VITE_DOMAIN;
const WS_HOST = DOMAIN === 'localhost' ? `${WS_PROTOCOL}://${hostname}:${PORT}` : `${WS_PROTOCOL}://${DOMAIN}:${PORT}`;

// Bonsale WebHook 訊息型別定義
type BonsaleWebHookMessage = {
  type: string;
  body: Record<string, unknown>;
  [key: string]: unknown;
};

type ConnectBonsaleWebHookWebSocketProps = {
  setProjectOutboundData: React.Dispatch<React.SetStateAction<ProjectOutboundDataType[]>>;
};

export default function useConnectBonsaleWebHookWebSocket({ setProjectOutboundData }: ConnectBonsaleWebHookWebSocketProps) {
  const wsRef = useRef<WebSocket | null>(null);

  // 處理 WebSocket 訊息
  const handleWebSocketMessage = useCallback(async (event: MessageEvent) => {
    try {
      const message = JSON.parse(event.data) as BonsaleWebHookMessage;
      console.log('📨 收到 Bonsale WebHook 訊息:', message);

      switch (message.type) {
        case 'auto-dial.created': {
          console.log('🆕 新增專案外撥設定:', message.body);
          // 這裡可以根據需要處理新增專案的邏輯
          // 例如重新獲取專案列表或直接添加到現有列表
          break;
        }
        case 'auto-dial.updated': {
          console.log('📝 更新專案外撥設定:', message.body);
          // 這裡可以根據需要處理更新專案的邏輯
          break;
        }
        case 'project.updated': {
          console.log('🔄 專案狀態更新:', message.body);
          const { Id: projectId, isEnable } = message.body;
          
          if (projectId && typeof isEnable === 'boolean') {
            setProjectOutboundData(prevData => 
              prevData.map(item => 
                item.projectId === projectId 
                  ? { ...item, isEnable }
                  : item
              )
            );
          }
          break;
        }
        default: {
          console.warn('⚠️ 未知的 WebHook 訊息類型:', message.type);
          break;
        }
      }
    } catch (error) {
      console.error('❌ 處理 Bonsale WebHook 訊息時發生錯誤:', error);
    }
  }, [setProjectOutboundData]);

  // 建立 WebSocket 連線
  const connectWebSocket = useCallback(() => {
    const ws = wsRef.current;
    if (!ws) {
      console.error('❌ Bonsale WebHook WebSocket 未初始化');
      return;
    }

    ws.onopen = () => {
      console.log('📡 Bonsale WebHook WebSocket 連線已建立');
    };

    ws.onmessage = handleWebSocketMessage;

    ws.onerror = (error) => {
      console.error('❌ Bonsale WebHook WebSocket 錯誤:', error);
    };

    ws.onclose = (event) => {
      console.log('👋 Bonsale WebHook WebSocket 連線已關閉', {
        code: event.code,
        reason: event.reason,
        wasClean: event.wasClean
      });
      
      // 如果不是正常關閉，嘗試重連
      if (!event.wasClean && event.code !== 1000) {
        console.log('🔄 嘗試在 3 秒後重新連接 Bonsale WebHook WebSocket...');
        setTimeout(() => {
          if (wsRef.current?.readyState === WebSocket.CLOSED) {
            wsRef.current = new WebSocket(`${WS_HOST}/api/bonsale/WebHook`);
            connectWebSocket();
          }
        }, 3000);
      }
    };
  }, [handleWebSocketMessage]);

  useEffect(() => {
    // 初始化 WebSocket 連接
    wsRef.current = new WebSocket(`${WS_HOST}/api/bonsale/WebHook`);
    connectWebSocket();

    return () => {
      if (wsRef.current) {
        wsRef.current.close();
        console.log('🧹 Bonsale WebHook WebSocket 連線已清理');
      }
    };
  }, [connectWebSocket]);

  // 返回 WebSocket 狀態和方法
  return {
    isConnected: wsRef.current?.readyState === WebSocket.OPEN,
    disconnect: () => wsRef.current?.close(),
  };
}
