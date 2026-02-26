# 添心生產力助手 - 更新日誌 (2026-02)

## 📅 2026-02-16 ~ 02-17 更新彙整

### 1. 🎯 主要目標：管理員戰情室 v2.0 (Manager Command Center)
為了提供更全面的管理視角，我們針對「即時監控」與「歷史稽核」進行了重大升級。

### 2. 🛠️ 後端核心修改 (Backend: CheckinSystem)

*   **歷史數據重構 (`CheckinLogic.js`)**
    *   **修正分組邏輯**：原本直接累加所有資料，造成同一天多筆紀錄混亂。現在改為以 `User + Date` 為唯一鍵值進行分組。
    *   **新・生產力公式**：
        *   `有效工時` = 工作 (Work) + 其他 (Other)
        *   `總活躍時間` = 工作 + 其他 + 休閒 (排除閒置)
        *   `生產力分數` = 有效工時 / 總活躍時間
    *   **異常偵測系統 (Anomaly Detection)**：新增 `anomalies` 欄位，自動標記：
        *   `🔴 high_leisure`：單日休閒時間 > 30 分鐘。
        *   `📉 low_score`：生產力分數 < 60% (且活躍時間 > 30分鐘)。

*   **API 介面調整 (`WebApp.js`)**
    *   **全員名單優化**：`get_team_status` 改為讀取完整員工名單，即使員工離線或請假也能顯示在列表中 (原本只顯示線上員工)。
    *   **[Backend] API 快取 (Caching)**: 已為 `get_team_status` 加入 20 秒快取，並優化了打卡紀錄讀取範圍 (僅讀取最後 1000 筆)。
    *   **[Deployment] 後端部署**: 已部署 v2.2.1 (Fix Report Duplicates)，修復了「因缺少電腦名稱導致重複建立新列」的問題。
    *   **修正邏輯**: 當上傳包含 PC Name 的新報告時，若發現當天已有「無 PC Name」的舊紀錄，系統會自動合併而非新增。
    *   **廠商過濾 (暫時回滾)**：嘗試過濾掉 `身份='廠商'` 的使用者，但因部署問題暫時回滾到 v2.0 穩定版 (目前廠商仍會顯示)。

### 3. 🖥️ 前端介面更新 (Frontend: Client)

*   **管理員面板 (`adminDashboard.js`)**
    *   **新增「歷史詳細列表」**：在圖表下方新增資料表格，直接列出每日、每人的詳細時數與生產力分數。
    *   **異常標記視覺化**：在表格中以「紅底/橘底」標籤顯示 `低生產力` 或 `高休閒` 警示。
    *   **日期顯示修復**：修正離線員工因無心跳紀錄而在「最後更新」欄位顯示 `Invalid Date` 的問題 (現在顯示為 `-`)。

*   **設定與連線 (`config.js` / `checkinService.js`)**
    *   **金鑰修復**：解決了因部署過程導致 Deployment ID 截斷或錯誤，造成客戶端出現 `Unexpected token <` (無法連線) 的問題。目前已鎖定在穩定的 v2.0 版本金鑰。
    *   **強制重啟機制**：建立強制關閉背景 `electron.exe` 的流程，確保設定檔更新能正確套用。

### 4. 🐛 故障排除紀錄 (Troubleshooting)

*   **2026-02-17 20:00 - 資料分組錯誤**
    *   **現象**：歷史報表顯示重複或錯誤的加總。
    *   **處置**：重寫 `CheckinLogic.js` 的 `_getProductivityHistory_` 函式，確保以人/日為單位正確歸戶。

*   **2026-02-17 21:00 - 連線錯誤 (Unexpected token <)**
    *   **現象**：管理員面板無法讀取資料，跳出 HTML 解析錯誤。
    *   **原因**：Google Apps Script 部署 ID 在更新 `config.js` 時發生複製錯誤 (缺字)，導致導向至 Google 404 頁面。
    *   **處置**：
        1.  使用 `verify_manager_api.js` 驗證後端 API 正常。
        2.  比對 `id.txt` 與 `config.js`，發現 ID 不一致。
        3.  修正 `config.js` 並強制重啟 Client App。

*   **2026-02-18 01:00 - 部署失敗與回滾**
    *   **現象**：嘗試部署 v2.1 (過濾廠商功能) 時，新產生的 ID 無法被外部存取。
    *   **處置**：緊急回滾至 v2.0 穩定版 ID (`AKfycbwv...`)，優先確保系統可用性。廠商過濾功能列入待辦，待 Google 服務穩定後再部署。

---

*   **2026-02-18 20:30 - API 嚴重錯誤 (Unexpected token <)**
    *   **現象**：管理員面板顯示 `Unexpected token <`，無法讀取任何資料。
    *   **原因**：**[Critical]** 開發過程中的 Node.js 輔助腳本 (如 `cleanup_project.js`, `debug_deploy.js`) 被意外推送到 Google Apps Script 專案中。由於 GAS 不支援 `require()` 語法，導致整個後端 Runtime 崩潰，所有 API 請求皆回傳 Google 的 HTML 錯誤頁面。
    *   **處置**：
        1.  清理專案目錄，將所有 Node.js 腳本移至 `CheckinSystem_DevOps` 資料夾。
        2.  重新部署乾淨的後端版本 (v2.2.2 / Deployment v227)。
        3.  更新 Client Config 指向新的 Deployment ID。

---

**目前版本狀態**:
*   **Client**: v1.2.2 (Config v2.2.2 Clean)
*   **Backend**: v2.2.2 (Clean, Fix Report Duplicates)
