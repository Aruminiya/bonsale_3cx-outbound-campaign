# WebSocket 訊息格式統一規範

## 概述

為了統一前後端之間的 WebSocket 通訊格式，我們制定了以下規範：

## 📤 客戶端發送給伺服器的訊息格式

所有從客戶端發送到伺服器的訊息都必須遵循以下格式：

```typescript
{
  event: string;        // 事件類型
  payload: {            // 載荷資料
    // 根據不同事件類型包含不同的資料
  }
}
```

### 具體範例

#### 1. 開始外撥專案
```typescript
{
  event: 'startOutbound',
  payload: {
    project: {
      callFlowId: string;
      projectId: string;
      client_id: string;
      client_secret: string;
      action: 'init' | 'active';
      error: string | null;
    }
  }
}
```

#### 2. 停止外撥專案
```typescript
{
  event: 'stopOutbound',
  payload: {
    project: {
      projectId: string;
    }
  }
}
```

## 📥 伺服器發送給客戶端的訊息格式

所有從伺服器發送到客戶端的訊息都必須遵循以下格式：

```typescript
{
  event: string;        // 事件類型
  payload: {            // 載荷資料
    timestamp: string;  // 時間戳記（必須）
    // 其他根據事件類型的資料
  }
}
```

### 具體範例

#### 1. 專案資訊更新
```typescript
{
  event: 'projectsUpdate',
  payload: {
    type: 'allProjects',
    data: [
      {
        projectId: string;
        callFlowId: string;
        action: 'init' | 'active';
        client_id: string;
        agentQuantity: number;
        caller: unknown;
        access_token: string | null;  // 隱藏敏感資訊顯示為 '***'
        ws_connected: boolean;
        createdAt: string;
        updatedAt: string;
      }
      // ... 更多專案
    ],
    stats: {
      totalProjects: number;
      activeProjects: number;
      connectedProjects: number;
    },
    timestamp: string;
    triggeredBy: string;  // 觸發來源（專案ID 或 'system'）
  }
}
```

#### 2. 專案狀態變更
```typescript
{
  event: 'projectStatusChange',
  payload: {
    data: {
      projectId: string;
      oldAction: string;
      newAction: string;
      changedAt: string;
    },
    timestamp: string;
  }
}
```

#### 3. 錯誤訊息
```typescript
{
  event: 'error',
  payload: {
    error: string;
    message: string;
    timestamp: string;
  }
}
```

## 💡 優點

### 1. 統一性
- 前後端使用相同的訊息結構
- 容易理解和維護

### 2. 擴展性
- `payload` 欄位可以根據不同事件包含不同的資料結構
- 方便新增新的事件類型

### 3. 類型安全
- 使用 TypeScript 介面定義，提供完整的類型檢查
- 共用類型定義在 `packages/shared-types`

### 4. 可追蹤性
- 每個訊息都包含 `timestamp`
- 伺服器訊息包含 `triggeredBy` 便於除錯

## 🔧 實作細節

### 類型定義位置
- `packages/shared-types/src/websocket.ts` - 包含所有 WebSocket 相關的類型定義
- 前後端都可以匯入使用這些類型

### 後端處理
```typescript
wsClient.on('message', async (message) => {
  const { event, payload } = JSON.parse(message.toString());
  
  switch (event) {
    case 'startOutbound':
      await initOutboundProject(payload.project);
      break;
    case 'stopOutbound':
      await ProjectManager.removeProject(payload.project.projectId);
      break;
  }
});
```

### 前端發送
```typescript
const sendMessage = (message: ClientToServerMessage) => {
  if (wsRef.current?.readyState === WebSocket.OPEN) {
    wsRef.current.send(JSON.stringify(message));
  }
};

// 使用範例
sendMessage({
  event: 'startOutbound',
  payload: {
    project: {
      callFlowId: 'cf-123',
      projectId: 'proj-456',
      client_id: 'client-789',
      client_secret: 'secret',
      action: 'init',
      error: null
    }
  }
});
```

## 📋 規範檢查清單

在實作時請確認：

- ✅ 所有訊息都包含 `event` 和 `payload` 欄位
- ✅ 伺服器訊息的 `payload` 包含 `timestamp`
- ✅ 使用 shared-types 中定義的類型
- ✅ 敏感資訊（如 access_token）在傳輸時已隱藏
- ✅ 錯誤處理遵循統一格式
- ✅ 事件名稱使用 camelCase 格式
