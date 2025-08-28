# 錯誤處理改進測試

## 🔧 修正的問題

### 1. Error 對象 JSON 序列化問題
**問題**：JavaScript 的 Error 對象在 `JSON.stringify()` 時會變成空對象 `{}`

**修正前**：
```json
{"event":"error","payload":{"error":{},"timestamp":"2025-08-28T03:45:44.716Z"}}
```

**修正後**：
```json
{
  "event": "error",
  "payload": {
    "error": {
      "name": "TypeError",
      "message": "Cannot destructure property 'access_token' of 'token.data' as it is undefined.",
      "stack": "TypeError: Cannot destructure property 'access_token'..."
    },
    "timestamp": "2025-08-28T03:45:44.716Z"
  }
}
```

### 2. initOutboundProject 函數的錯誤處理
**問題**：當 `get3cxToken` 失敗時，`token.data` 為 undefined，但代碼仍嘗試解構

**修正前**：
```typescript
const token = await get3cxToken(client_id, client_secret);
const { access_token } = token.data; // 💥 如果 token.success = false，這裡會出錯
```

**修正後**：
```typescript
const token = await get3cxToken(client_id, client_secret);
if (!token.success) {
  throw new Error(`Failed to obtain access token: ${token.error?.error || 'Unknown error'}`);
}
const { access_token } = token.data; // ✅ 安全解構
```

## 🧪 測試場景

### 1. 無效的認證資訊
**觸發方式**：使用錯誤的 client_id 或 client_secret

**預期錯誤**：
```json
{
  "event": "error",
  "payload": {
    "error": {
      "name": "Error",
      "message": "Failed to obtain access token: Error get3cxToken request: Request failed with status code 401"
    },
    "timestamp": "2025-08-28T..."
  }
}
```

### 2. JSON 格式錯誤
**觸發方式**：發送無效的 JSON 字串

**預期錯誤**：
```json
{
  "event": "error", 
  "payload": {
    "error": {
      "name": "SyntaxError",
      "message": "Unexpected token..."
    },
    "timestamp": "2025-08-28T..."
  }
}
```

### 3. 缺少必要欄位
**觸發方式**：發送不完整的 payload

**預期錯誤**：
```json
{
  "event": "error",
  "payload": {
    "error": {
      "name": "TypeError", 
      "message": "Cannot read properties of undefined..."
    },
    "timestamp": "2025-08-28T..."
  }
}
```

## 📋 broadcastError 函數特性

### 1. 智能錯誤處理
- ✅ Error 對象 → 提取 name, message, stack
- ✅ 字串錯誤 → 包裝成 message
- ✅ 其他對象 → 直接序列化
- ✅ 其他類型 → 轉換為字串

### 2. 開發環境友好
- ✅ 開發環境包含 stack trace
- ✅ 生產環境隱藏 stack trace
- ✅ 詳細的日誌記錄

### 3. 統一的訊息格式
- ✅ 遵循 WebSocket 訊息格式規範
- ✅ 包含時間戳記
- ✅ 類型安全的錯誤結構

## 🎯 前端處理建議

```typescript
// 前端 WebSocket 訊息處理
ws.onmessage = (event) => {
  const message = JSON.parse(event.data);
  
  if (message.event === 'error') {
    const errorInfo = message.payload.error;
    console.error('伺服器錯誤:', errorInfo.message);
    
    // 顯示使用者友好的錯誤訊息
    if (errorInfo.message.includes('401')) {
      showNotification('認證失敗，請檢查 App ID 和 Secret', 'error');
    } else {
      showNotification(`操作失敗: ${errorInfo.message}`, 'error');
    }
  }
};
```
