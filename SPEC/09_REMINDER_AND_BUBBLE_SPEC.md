# 添心小助手：提醒項與氣泡通訊整合規格 (v1.0)

## 📌 概述
本文件整合了系統中所有自動化提醒 (Reminder) 與視覺化氣泡 (Mascot Bubble/Toast) 的技術實現、通訊格式與連動邏輯。旨在確保「外部訊息」從雲端到使用者桌面的流程透明且可控。

---

## ☁️ Firebase 雲端通訊格式
系統透過 Firebase Realtime Database 監聽實時訊息。

### 1. 訊息路徑 (Path)
`notifications/{userId}/{msgId}`

### 2. 數據結構 (Schema)
```json
{
  "message": "訊息內容文字",
  "senderName": "發送者姓名 (LINE Display Name)",
  "senderUid": "發送者唯一識別碼 (LINE Uid)",
  "senderId":  "發送者別名 (相容舊版)",
  "gid": "群組識別碼 (若為群組訊息)",
  "source": "line | fb | system",
  "timestamp": 1710722400000,
  "siteName": "來源據點名稱",
  "icon": "💬",
  "createdAt": "2026-03-18T08:50:00Z"
}
```

---

## 🏗️ 系統處理流程 (Pipe-line)

### 1. 接收與過濾 (FirebaseService)
- **物理清理**: 訊息一經 `child_added` 獲取後，立即執行 `remove()` 確保雲端不堆積。
- **過濾機制 (MVP 強化版)**:
    - **UID 檢查**: 比對 `senderUid` 是否存在於內部員工快取。
    - **GID 檢查**: 比對 `gid` 是否為內部群組（如：工程回報群、內部討論群）。
    - **靜默策略**: 命中過濾則僅執行 log 紀錄，不觸發 UI。

### 2. 聚合緩衝 (Batching)
- **防抖 (Debounce)**: 相同發送者在 2 秒內的訊息會自動合併。
- **格式化**: 多筆訊息使用 ` | ` 分隔。

### 3. 渲染與互動 (ReminderService)
- **氣泡載體 (Toast)**: 
    - 寬度固定 `400px`，位於螢幕左下角（Margin: 20px）。
    - 支援「✅ 完成」與「⏰ 稍後提醒」互動。
- **Mascot 同步**: 
    - 訊息同步推送至 `statsWindow` 的 Mascot Dialogue Queue (MDQ)。
    - 背景小秘書會同步播報訊息內容。

---

## 📋 預計實施計畫 (v2.6.401)

### [Phase 1: 標記修復]
- **目標**: 解決 GitHub Release 停滯於 400 的問題。
- **動作**: 清除無效 Tag `v`，針對最新 Commit 打上 `v2.6.401`。

### [Phase 2: 過濾機制強化]
- **目標**: 徹底解決「內部通訊」（如：俊豪）干擾使用者的問題。
- **技術細節**:
    - **apiBridge.js**: 在 `getEmployeeList` 中強制將 `userId`/`uid` 轉為字串快取，確保與 Firebase 的 `senderUid` 資料型態一致。
    - **UID 比對**: 確保 `isEmployee` 執行精確 ID 查表，排除依賴模糊姓名的不確定性。

### [Phase 3: 驗證]
- 確認 LINE 群組訊息（包含「俊豪」發出的訊息）被正確靜默。
- 確認 GitHub 產出正確的發布版本。
