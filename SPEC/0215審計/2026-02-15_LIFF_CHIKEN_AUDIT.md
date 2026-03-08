# LIFF 打卡與管理系統審查報告 (2026-02-15)

## 📑 審查概述
對 `CODING` 專案（LIFF 打卡與整合主控台）進行核心邏輯審查，重點評估外觀美化後的內部架構安全性、防作弊機制與離線同步的穩健性。

---

## 🔍 已識別之缺陷與改善方案 (Identified Risks & Remediation)

### 1. 嚴重安全漏洞：敏感資訊透過 URL 傳遞 (Exposure of Sensitive Data in GET)
- **位置**：`spa/app.js` -> `fetchAttendanceData`, `fetchHubProjectsData` / `checkin.html` -> `sendCheckinData`
- **目前運作方式 (白話說明)**：
  現在系統在傳遞使用者身分時，是直接把「我是誰 (ID)」和「我的權限」寫在網址列上傳送。這就像把身分證字號和存摺密碼直接寫在信封外面寄出去。
- **風險**：任何人如果偷看到這網址，或者自己修改網址上的一行字，就能假冒成其他員工，甚至假冒成管理員，看到不該看的資料。
- **改善方案 A：LINE Login Token (OpenID Connect) [推薦]**
  - **作法**：前端使用 `liff.getIDToken()` 取得 JWT。後端 (GAS) 驗證該 Token 的簽章與使用者身分，不再信任任何 URL 參數傳入的 UserID。
- **改善方案 B：一次性令牌 (One-time Token)**
  - **作法**：若不想驗證 JWT，可透過後端生成短效期的 `session_token`，前端僅傳遞此 Token，後端透過 Token 查表反推 UserID。

### 2. 業務邏輯漏洞：離線模式時間篡改 (Client-side Time Tampering)
- **位置**：`checkin.html` -> `checkinButton.addEventListener` (Line 569)
- **目前運作方式 (白話說明)**：
  當員工在沒網路的地方打卡時，系統是信任**員工手機上的時間**。
- **風險**：如果員工遲到了，他只要把手機時間往回調 10 分鐘，然後再進行離線打卡，系統就會以為他準時上班。
- **改善方案 A：伺服器時間校正 (Server Time Offset) [推薦]**
  - **作法**：App 啟動與連線恢復時，向後端請求「現在時間」，計算 `offset = severTime - localTime`。打卡時記錄 `timestamp` 與 `offset`，後端修正後存入。
- **改善方案 B：補傳標記 (Flagging)**
  - **作法**：凡是「離線補上傳」的紀錄，在報表上一律標記「⚠️ 離線補登」，需主管人工覆核。

### 3. 定位安全風險：缺乏地理座標校驗 (Location Spoofing)
- **位置**：`checkin.html` -> `latitude`, `longitude`
- **目前運作方式 (白話說明)**：
  系統現在是無條件相信瀏覽器回報的 GPS 座標。
- **風險**：現在有很多「虛擬定位 (Mock Location)」的 App。員工可以在家裡睡覺，但把手機定位設在公司，進行遠端打卡，系統完全無法發現。
- **改善方案 A：距離/速度合理性檢查 (Plausibility Check) [實用]**
  - **作法**：後端比對上一次打卡位置。若兩次打卡距離過遠且時間過短（例如 1 分鐘移動 10 公里），則判定為異常並拒絕或標記。
- **改善方案 B：信任裝置檢查**
  - **作法**：利用 LINE Beacon 或公司 Wi-Fi IP 白名單作為輔助驗證，不完全依賴 GPS。

### 4. 併發性能地雷：GAS 併發上傳限制 (GAS Throttling via Chunks)
- **位置**：`projectApi.js` -> `_uploadChunks` (Line 184)
- **目前運作方式 (白話說明)**：
  當上傳多張照片時，程式會試圖**同一時間把所有照片都丟給伺服器**。
- **風險**：Google 伺服器會覺得「這個人是不是在攻擊我？」，然後把後面的請求全部擋掉。結果就是員工看起來照片傳出去了，但實際上後台只收到前面幾張。
- **改善方案 A：循序上傳 (Sequential Queue) [推薦]**
  - **作法**：使用 `for...of` 迴圈配合 `await`，確保前一個 Chunk 上傳成功後才發送下一個。雖然速度較慢，但在 GAS 環境下最穩定。
- **改善方案 B：生產者-消費者模型 (Producer-Consumer)**
  - **作法**：限制同時併發數 (Concurrency Limit) 為 2 或 3，平衡速度與穩定性。

### 5. 資源管理隱憂：Service Worker 緩存無限制增長 (Storage Bloat)
- **位置**：`sw.js` -> `IMAGE_HOST = 'drive.google.com'`
- **目前運作方式 (白話說明)**：
  為了讓 App 跑得快一點，它會把看過的照片存一份在手機裡。但是**沒有設定上限**，也沒有過期刪除機制。
- **風險**：用久了之後，這個 App 可能會默默吃掉手機幾 GB 的空間，導致員工手機空間不足，或被系統強制清除所有資料。
- **改善方案 A：LRU 快取策略 [推薦]**
  - **作法**：在 Service Worker 中實作 Least Recently Used 演算法。當 Cache 大小超過 500MB 或圖片數超過 1000 張時，刪除最舊的圖片。
- **改善方案 B：Clear-Site-Data Header**
  - **作法**：後端 API 可偶爾回傳 `Clear-Site-Data: "cache"` Header，強制瀏覽器清理快取 (較激進)。

### 6. 程式碼維護債：冗餘 API 邏輯 (Code Duplication)
- **位置**：`shared/js/apiService.js` 與 `modules/projects/js/projectApi.js`
- **目前運作方式 (白話說明)**：
  系統裡有兩份長得幾乎一模一樣的程式碼 (`ProjectApi` 和 `ApiService`)，都在做跟伺服器溝通這件事。
- **風險**：如果以後要改連線設定，工程師改了 A 檔卻忘了改 B 檔，就會發生「有些功能壞掉、有些功能正常」的奇怪現象。
- **改善方案 A：共用模組 (Shared Module) [推薦]**
  - **作法**：提取核心邏輯為 `CoreApi.js`，其他模組透過 `import` 或 `<script src="...">` 引用。保持單一真值來源 (SSOT)。

### 7. CORS 規避技術債 (Cross-Origin Hack)
- **位置**：所有 POST 請求皆強制封裝成 `FormData` 的 `payload` 字串。
- **目前運作方式 (白話說明)**：
  為了繞過 Google 的一些安全性限制，我們被迫使用一種**非標準的、有點旁門左道**的方式來傳送資料。
- **風險**：這讓後端程式沒辦法用正規、高效的方式處理資料，而且也犧牲了一些原本瀏覽器會自動幫忙做好的安全性檢查。
- **改善方案 A：維持現狀但標準化封裝**
  - **作法**：GAS 的 CORS 行為極難改變。建議維持 text/plain 傳輸，但在前端建立標準的 `ResponseInterceptor` 來自動解析回傳的 JSON 字串，隱藏此技術債。

---

## ⚖️ 修復優先級建議 (Priority Suggestions)

根據風險嚴重性與對業務運作的影響，建議的處理順序如下：

| 優先級 | 項目 (Issue) | 風險等級 | 建議行動 |
| :--- | :--- | :--- | :--- |
| **P0** | **敏感資訊透過 URL 傳遞** (#1) | Critical | 立即引入 LINE Login Token 驗證，停止在 URL 中暴露 UserID。 |
| **P1** | **離線模式時間篡改** (#2) | High | 建立伺服器時間校準機制，或在連線恢復時標記「補傳」狀態以供人工審核。 |
| **P1** | **GAS 併發上傳限制** (#4) | High | 改寫上傳邏輯為循序佇列 (Sequential Queue)，確保大檔上傳不丟失。 |
| **P2** | **定位安全風險** (#3) | Medium | 若業務允許，增加後端對異常距離或移動速度的自動警示。 |
| **P2** | **Service Worker 緩存肥大** (#5) | Medium | 實作 LRU 快取策略或過期清除機制，限制本地儲存占用。 |
| **P3** | **冗餘程式碼與 CORS 規避** (#6, #7) | Low | 隨下一次功能迭代進行重構，合併 API 服務層。 |
