# 添心行動交辦中心 (TANXIN Task-Center) v4.0 完整技術規範書

## 1. 系統願景
打造一個「離線優先 (Local-First)」、高效、且具備深度回饋能力的執行終端，確保交辦事項不僅是被「看到」，而是被「處理」與「追蹤」。

## 2. 核心架構：GAS 中繼與本地緩衝
- **後端存儲 (The Brain)**：維持以 **Google Apps Script (GAS) + Google Sheets** 作為核心中繼，負責數據持久化與跨裝置同步。
- **本地緩衝 (Local Cache)**：操作優先存於本地 SQLite，確保 UI 零延遲。
- **背景同步 (Sync Engine)**：
  - **策略**: 本地優先 (Local-First)，定期批次同步。
  - **穩定性**: 解決網路波動導致 UI 卡死的問題。

## 3. 任務生命週期：詳細流程

### 階段 A：發起 (Initiation)
1. **輸入方式**：
   - **快速命令 (Command Bar)**：在視窗頂部輸入 `/e 會議資料` (緊急) 或 `/s60 繪圖` (限時60分)。
   - **詳細表單 (Detailed Form)**：點擊「➕」開啟完整介面，填寫案號、工種、收件人與細節。
2. **屬性定義**：
   - `action_type`: `None` / `ReplyText` / `ConfirmCompletion`
   - `priority_mode`: `normal` / `sprint` / `emergency`

### 階段 B：派發與提醒 (Dispatch & Alert)
1. **本地觸發**：`ReminderService` 每分鐘掃描。
2. **視覺表現**：
   - 普通：右下角靜默通知。
   - 緊急：小秘書視窗置頂，伴隨紅色呼吸燈邊框。

### 階段 C：處理與回饋 (Feedback Loop) - **詳細流程與 API**
當用戶點擊任務進行互動時，觸發以下本地流程：

1. **[✅ 標註完成]**：
   - **UI**: 彈出模態框，要求輸入 `Note`。
   - **API**: 調用 `updateTaskResponse({id, note, duration})`。
   - **結果**: 狀態設為 `Completed`，並累計執行時長。

2. **[⚠️ 遭遇困難]**：
   - **UI**: 顯示原因選單 (施工受阻/缺料/人手等)。
   - **API**: 調用 `reportBlockReason({id, reason, duration})`。
   - **結果**: 標籤變為紅色 `⚠️ 受阻`，方便管理端即時察覺。

3. **[⏳ 請求延時]**：
   - **UI**: 提供快捷按鈕 (+30min, +1h, 延至明天)。
   - **API**: 調用 `updateLocalTask` 修改 `due_time`。
   - **結果**: 重新計算提醒時間。

### 階段 D：結案與歸檔 (Closing & Archiving)
- 所有回報內容自動生成 `Communication log` 回傳原始任務串。
- 完成的交辦任務在隔日凌晨自動移入 `history_tasks`。

## 4. 資料庫架構 (SQLite)
`local_tasks` 資料表欄位擴展：
- `status`: `Unread` / `Processing` / `Completed` / `Blocked` / `Archived`
- `block_reason`: 困難回報原因 (JSON)
- `response_note`: 最後一次回覆文字
- `actual_duration`: 實際執行的累計分鐘數

## 6. 雲端整合：NotificationCenter API 對接方案

### 方案 A：零改動模式 (Zero-Backend Change) [推薦]
小助手會自動將進階數據封裝為 JSON 格式，存入現有的 **`ActionPayload`** 欄位。

1.  **發送端 (PC)**：
    - 將 `{ reason, note, duration }` 轉為 `JSON.stringify()`。
    - 對應欄位：`Status` 設為新狀態，其餘回報填入 `ActionPayload`。
2.  **接收端 (SPA)**：
    - 主控台前端讀取 `ActionPayload` 時，判斷是否為 JSON，若是則解析並顯示。

### 方案 B：結構化模式 (Structural Upgrade)
若決定更動 GAS，作業流程如下：
1.  **Sheets 調整**：於 `RelatedLink` 欄位後方新增 `BlockReason`, `ResponseNote`, `Duration`。
2.  **GAS 修改**：更新 `WebApp.js` 中的 `syncTaskUpdate` 路由處理器。

---

## 7. 軟體架構：TaskCenterManager API 封裝
為了落實職責分離，小助手採用單一進入點 (Single Entry Point) 處理任務：

```javascript
/* TaskCenter API 呼叫範例 */
// 1. 同步回傳困難
await TaskCenter.reportBlocked(taskId, {
    reason: "案場停電無法施工",
    duration: 15
});

// 2. 獲取本地待辦 (包含雲端標記)
const list = await TaskCenter.getDashboardData();
```
