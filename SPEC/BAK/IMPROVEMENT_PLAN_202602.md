# 添心生產力助手 - 系統改善與代碼審查報告 (2026-02)

## 1. 現狀分析 (Current Status)

目前系統處於 **Client v1.2.1** (搭配 **Backend v2.0**) 的混合狀態。
*   **Client 端**：已包含最新的「歷史詳細表格」與「Invalid Date 修復」。
*   **Backend 端**：由於部署回滾，目前運行的是 v2.0 (尚未包含「廠商過濾」功能)。
*   **原始碼 (Local)**：`WebApp.js` 中已包含「廠商過濾」代碼，等待下次成功部署。

## 2. 代碼審查發現 (Code Review Findings)

### A. 前端 (Client - adminDashboard.js)
1.  **錯誤訊息處理脆弱**
    *   **問題**: 當後端回傳 HTML 錯誤 (如 404/500) 時，`JSON.parse` 會失敗 (這部分已在 `checkinService` 處理)，但若後端回傳 `{ success: false, message: '<html>...' }`，前端直接將其塞入 `innerHTML`。
    *   **風險**: 雖然是內部工具，但可能導致版面跑版。
    *   **建議**: 在顯示錯誤訊息前進行長度截斷或移除 HTML 標籤。

2.  **IPC 通訊架構**
    *   **問題**: `AdminDashboard` 類別中直接呼叫 `ipcMain.removeAllListeners`。
    *   **風險**: 如果未來有多個視窗或模組監聽相同事件，會造成衝突。
    *   **建議**: 將 IPC 處理邏輯統一移至 `main.js`，透過 `webContents.send` 指定視窗回傳。

3.  **日期預設值**
    *   **現狀**: 預設查詢範圍為「最近 7 天」。
    *   **建議**: 可將此設定移至 `config`，讓用戶自訂預設範圍。

### B. 後端 (Backend - WebApp.js)
1.  **廠商過濾功能 (Vendor Filter)**
    *   **現狀**: 本地代碼 `lines 584-585` 已實作過濾，但線上版本未生效。
    *   **建議**: 建議在 Google 服務穩定後，執行 `clasp push` 與 `clasp deploy` 更新線上版本。

2.  **團隊狀態 API 效能**
    *   **問題**: `_getTeamStatus_` 每次都會讀取完整的 `UserStatus` 與 `打卡紀錄` Sheet。
    *   **建議**: 隨著資料量增長，應引入 `CacheService` 來快取計算結果 (例如快取 30 秒)，避免頻繁讀取試算表導致 Quota 超限。

### C. 設定管理 (Config)
1.  **Deployment ID 管理**
    *   **問題**: 目前依賴手動更新 `config.js` 中的 `CHECKIN_API_URL`。
    *   **建議**: 建立自動化部署腳本 (CI/CD)，在 `clasp deploy` 成功後自動更新 `config.js` 並驗證。

## 3. 建議改進方案 (Action Plan)

### 階段一：穩定性優先 (Immediate)
- [x] **Sanitize Error Messages**: 修改前端，確保後端錯誤不會破壞 UI (Completed).
- [x] **IPC Refactor**: 重構 `main.js` 與 `adminDashboard.js` 的通訊模式 (Completed).
- [x] **Vendor Filter Upgrade**: 升級為「電腦綁定過濾」與「多機展開顯示」 (Code Ready, Waiting for Deployment).
- [ ] **Retry Deployment**: 再次嘗試部署後端 v2.2，使上述功能生效。

### 階段二：架構優化 (Short-term)
- [ ] **Backend Caching**: 為 `get_team_status` 加入快取機制 (建議在本次部署一併加入).
- [ ] **Remote Config**: 實作遠端設定檔 (待確認 JSON URL).

### 階段三：長期維護 (Long-term)
- [ ] **Remote Config**: 實作遠端設定檔，讓 Client 端能動態取得最新的 API URL，免除重新打包發布的麻煩。
