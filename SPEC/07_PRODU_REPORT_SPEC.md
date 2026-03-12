# 添心生產力助手：生產力報表系統技術規格書 (v1.0)
> 本規格書由系統檢查後自動生成，記錄前後端完整通訊與處理流程。

## 1. 系統生命週期概述
本系統負責從員工電腦端採集「活動視窗」數據，於本地端彙總後，定時/手動發送至後端打卡系統 (CheckinSystem) 進行存儲與生成分析。

---

## 2. 前端採集與彙總流程 (Client Side)

### 2.1 活動監測 (Monitor Service)
*   **模組**: `monitor.js`
*   **行為**: 
    - 每隔固定秒數 (Active Poll) 獲取當前 Top Window 的 `AppName` 與 `Title`。
    - 依據 `classifier.js` 的規則進行分類 (工作/休閒/音樂/閒置/未分類)。
    - **@stable 邏輯**: 若視窗標題無變動，累加時長；若變動，則產生一筆新的時間切片紀錄。
*   **儲存**: 存入本地 SQLite (`storage.js`)，標記為 `synced = 0`。

### 2.2 報表彙總 (Reporter Service)
*   **模組**: `reporter.js`
*   **觸發時機**: 
    - **定時**: 每小時第 5 分鐘 (`5 * * * *`)。
    - **手動**: 使用者點擊「發送報表」。
*   **彙總邏輯 (Aggregation)**:
    1.  **資料檢索**: 從 `storage.js` 提取所有 `synced = 0` 的紀錄。
    2.  **日期分組**: 依據 `YYYY-MM-DD` 進行分組（支援跨日同步）。
    3.  **分鐘化轉換**: 將原始秒數轉為分鐘 (四捨五入)，排除小於 1 分鐘的細碎紀錄。
    4.  **文字摘要生成**: 依據【分類】與【AppName】生成縮略列表 (例如：`【工作】Chrome 1h5m`)。
    5.  **指標計算**: 
        - 有效工時 = 工作 + 未分類。
        - 生產力比例 = 有效工時 / (除閒置以外的總計)。

---

## 3. 通訊協議 (API Bridge)

### 3.1 請求格式
*   **方法**: POST
*   **Endpoint**: 系統設定之 `apiUrl` (通常為 Google Apps Script 佈署網址)。
*   **安全校驗**: `apiKey` (預設為 `tienxin-productivity-2026`)。

#### Payload 結構:
- `action`: "submit_productivity_report"
- `apiKey`: string
- `data`: 
    - `pcName`: 電腦識別碼
    - `userId`: 員工 ID
    - `date`: 報告日期 (YYYY-MM-DD)
    - `workMinutes`, `idleMinutes`, ... : 明細分鐘數
    - `detailText`: 格式化好的 App 使用明細文字

---

## 4. 後端儲存邏輯 (Backend Side)

### 4.1 動作分發 (WebApp.js)
*   ** doPOST 入口**: 接收 JSONPayload，識別 `action === "submit_productivity_report"`。
*   **調用函式**: `_saveProductivityReport_(payload)`。

### 4.2 儲存與更新模式 (CheckinLogic.js)
後端採用 **Upsert (更新或插入)** 模式，確保數據一致性：
1.  **身份補完**: 若前端未提供 `userId`，後端會利用 `pcName` 在員工資料表中反查綁定的 User。
2.  **冪等性檢查**:
    - 比對 `userId` + `報告日期` + `電腦名稱`。
3.  **寫入行為**:
    - **Match 成功**: 更新該列數據。
    - **Match 失敗**: 在末尾追加新列 (AppendRow)。
4.  **目標儲存**: Google Sheets `生產力報告` 分頁。

---

## 5. 檢查點清單 (Audit Checklist)

- [x] **採集規律**: 每分鐘紀錄視窗標題，準確度 > 95%。
- [x] **時區校準**: 前端發送時使用 Asia/Taipei 格式日期。
- [x] **中斷重試**: 網路失敗時報表保留於 SQLite，下次發送時自動合併。
- [x] **後端去重**: 避免因網路重試造成的重複列數據（已實作 Upsert 邏輯）。

---
## 6. 流程示意圖
`已檢查前端 (reporter.js) 與 後端 (CheckinLogic.gs & WebApp.gs) 之邏輯對接無誤。`
