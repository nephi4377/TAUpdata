# 系統架構優化與設定管理方案 (2026-02-18)

## 1. 廠商過濾邏輯變更 (Completed)
依據您的指示，後端代碼已進行以下修正 (目前在本地，待部署)：
*   **舊邏輯**：過濾 `Status != '廠商'`。
*   **新邏輯**：過濾 `pcName` 存在且不為空。
*   **效益**：只要員工有綁定電腦 (無論是廠商、正職或兼職)，都會顯示在監控面板中；反之，單純的外勤人員 (無 PC) 則不佔用版面。

## 2. 團隊狀態 API 效能分析 (Performance Audit)
您詢問 `get_team_status` 的效能瓶頸，目前該 API 執行時會依序讀取三張工作表：

1.  **員工資料 (Employees)**: 讀取所有員工設定 (為了取得 `pcName` 和 `Group`)。
    *   *消耗*: 低 (約 100 列)。
2.  **即時狀態 (UserStatus)**: 讀取心跳紀錄。
    *   *消耗*: 低 (約 50 列，僅最新的狀態)。
3.  **打卡紀錄 (CheckinRecords)**: 讀取 **今日** 的所有打卡紀錄 (為了判斷「請假」或「公出」)。
    *   *消耗*: **高**。隨著時間累積，打卡紀錄會越來越多。目前是讀取全表再過濾今日，這在資料量大時會變慢。

**🚀 立即優化建議**:
*   **快取 (Cache)**: 將 `get_team_status` 的計算結果快取 15~30 秒。這樣多個管理員同時觀看時，不會重複查詢 Google Sheet。
*   **範圍讀取優化**: 針對「打卡紀錄」，改為只讀取「最後 500 筆」或使用 `TextFinder` 搜尋今日日期，避免載入整張數萬筆的表。

## 3. 設定管理：完整解決方案 (Remote Config)
為了解決「後端重新部署導致 URL 變更，客戶端必須更新」的痛點，建議採用 **遠端設定檔 (Remote Configuration)** 架構。

### 架構圖
`Client App` -> `Public Config URL (JSON)` -> `Backend API URL`

### 實作步驟
1.  **建立公開設定檔**: 在您的 Dropbox 公開資料夾 (或 GitHub Pages / 固定 URL 的任何空間) 放置一個 `app-config.json`。
    ```json
    {
        "minVersion": "1.2.1",
        "apiUrl": "https://script.google.com/macros/s/AKfycb.../exec",
        "announcement": "系統維護中，請稍後"
    }
    ```
2.  **客戶端改造**: 修改 `ConfigManager`，在啟動時先去讀取這個 JSON。
    *   如果有 `apiUrl`，則覆蓋本地設定。
    *   如果有 `minVersion` > 目前版本，強制提示更新。
3.  **管理流程**:
    *   未來 `clasp deploy` 產生新 ID 後，您只需要編輯這個 `app-config.json`。
    *   所有安裝在外的客戶端重啟後自動抓到新網址，**無需重新安裝**。

## 4. IPC 通訊架構重構 (Refactor Plan)
依據建議，我們將進行以下重構：
*   **移除**: `AdminDashboard.js` 中的 `ipcMain` 監聽代碼。
*   **新增**: 在 `main.js` 統一管理所有 IPC 通道 (`admin-login`, `fetch-status`)。
*   **效益**: 避免視窗開關導致的監聽器洩漏或重複註冊錯誤，且代碼職責更清晰。

---
**接下來的行動**:
1.  推動 **IPC 架構重構** (修改 `main.js` 與 `adminDashboard.js`)。
2.  若您同意，我將實作 **Remote Config** 的客戶端邏輯 (需請您提供一個可公開存取的 JSON URL 或檔案路徑，例如 Dropbox public link)。
