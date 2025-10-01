import { useCallback, useEffect, useRef } from 'react';
import useGetOneBonsaleAutoDial from './api/useGetOneBonsaleAutoDial';

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
  const { getOneBonsaleAutoDial } = useGetOneBonsaleAutoDial();

  // 處理 WebSocket 訊息
  const handleWebSocketMessage = useCallback(async (event: MessageEvent) => {
    try {
      const message = JSON.parse(event.data) as BonsaleWebHookMessage;
      console.log('📨 收到 Bonsale WebHook 訊息:', message);

      switch (message.type) {
        case 'auto-dial.created': {
          console.log('🆕 新增專案外撥設定:', message.body);
          const { callFlowId, projectId } = message.body as { Id: string; callFlowId: string; projectId: string };
          
          if (projectId && callFlowId) {
            try {
              // 獲取新創建的專案外撥設定資料
              const newAutoDialData = await getOneBonsaleAutoDial(projectId, callFlowId);
              
              console.log('🔄 新增的外撥設定資料:', newAutoDialData);
              
              // 檢查專案是否已存在，避免重複添加
              setProjectOutboundData(prevData => {
                const existingProject = prevData.find(item => 
                  item.projectId === projectId && item.callFlowId === callFlowId
                );
                
                if (existingProject) {
                  console.log('📋 專案已存在，跳過添加:', projectId);
                  return prevData;
                }
                
                // 創建新的專案資料物件
                const newProjectData: ProjectOutboundDataType = {
                  appId: newAutoDialData.appId,
                  appSecret: newAutoDialData.appSecret,
                  callFlowId: newAutoDialData.callFlow?.Id || callFlowId,
                  projectId: newAutoDialData.projectId || projectId,
                  projectName: newAutoDialData.projectInfo?.projectName || '未知專案',
                  startDate: newAutoDialData.projectInfo?.startDate || new Date(),
                  endDate: newAutoDialData.projectInfo?.endDate || new Date(),
                  extension: newAutoDialData.callFlow?.phone || '',
                  recurrence: null, // 根據需要設定
                  isEnable: newAutoDialData.projectInfo?.isEnable ?? true,
                };
                
                // 將新專案添加到列表頂部
                return [newProjectData, ...prevData];
              });
              
              console.log('✅ 新專案外撥設定添加完成');
            } catch (error) {
              console.error('❌ 添加新專案外撥設定失敗:', error);
            }
          }
          break;
        }
        case 'auto-dial.updated': {
          console.log('📝 更新專案外撥設定:', message.body);
          const { callFlowId, projectId } = message.body as { Id: string; callFlowId: string; projectId: string };
          
          if (projectId && callFlowId) {
            try {
              // 獲取更新後的專案外撥設定資料
              const updatedAutoDialData = await getOneBonsaleAutoDial(projectId, callFlowId);
              
              console.log('🔄 更新的外撥設定資料:', updatedAutoDialData);
              
              // 更新前端的專案資料
              setProjectOutboundData(prevData => 
                prevData.map(item => {
                  if (item.projectId === projectId) {
                    return {
                      ...item,
                      // 更新相關欄位
                      appId: updatedAutoDialData.appId || item.appId,
                      appSecret: updatedAutoDialData.appSecret || item.appSecret,
                      callFlowId: updatedAutoDialData.callFlow?.Id || item.callFlowId,
                      projectName: updatedAutoDialData.projectInfo?.projectName || item.projectName,
                      startDate: updatedAutoDialData.projectInfo?.startDate || item.startDate,
                      endDate: updatedAutoDialData.projectInfo?.endDate || item.endDate,
                      extension: updatedAutoDialData.callFlow?.phone || item.extension,
                      isEnable: updatedAutoDialData.projectInfo?.isEnable ?? item.isEnable,
                    };
                  }
                  return item;
                })
              );
              
              console.log('✅ 專案外撥設定更新完成');
            } catch (error) {
              console.error('❌ 更新專案外撥設定失敗:', error);
            }
          }
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
  }, [setProjectOutboundData, getOneBonsaleAutoDial]);

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
