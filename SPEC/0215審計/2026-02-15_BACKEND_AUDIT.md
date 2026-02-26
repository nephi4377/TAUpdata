# 後端程式品質審查報告 (2026-02-15)

## 📑 審查概述
針對 CheckinSystem 後端核心代碼進行深度掃描，旨在識別影響穩定性、效能及可維護性的潛在風險。

---

## 🔍 已識別之缺陷與改善方案 (Identified Risks & Remediation)

### 1. 快取同步性漏洞 (Cache Inconsistency)
- **位置**：`EmployeeLogic.js` -> `_upsertEmployee_`
- **目前運作方式 (白話說明)**：
  當管理員修改員工資料（如權限、班表）時，系統雖然更新了資料庫，但**忘記通知**「個人資料快取」也要更新。這就像是改了餐廳菜單，但門口的展示架還放著舊菜單，導致客人（打卡端）看到舊的資訊。
- **風險**：修改權限或班別後，員工在一小時內打卡時仍會被系統判定為舊的狀態（例如明明改了 9 點上班，系統還以為是 10 點），造成考勤記錄錯誤。
- **改善方案 A：快取分層策略 (Layered Cache) [推薦]**
  - **作法**：使用 `CacheService` 儲存 `user_profile` (TTL 10分鐘)。若快取失效才讀取 Sheet。寫入時同時更新 Sheet 與快取 (Write-Through)。
- **改善方案 B：精確清除 (Precise Invalidation)**
  - **作法**：在 `upsert` 成功後，主動呼叫 `CacheService.remove('user_profile_v2_' + userId)` 強制讓快取失效。

> **🛠️ 修復狀態：✅ 已修復**
> **處置**：
> - 實作方案 A (Layered Cache) 與 B (Precise Invalidation)。
> - 在 `EmployeeLogic.js` -> `_upsertEmployee_` 中，寫入資料後立即呼叫 `cache.removeAll` 清除快取，確保下次讀取為最新資料。

### 2. 極低效的試算表寫入 (Inefficient IO)
- **位置**：`EmployeeLogic.js` -> `_upsertEmployee_`
- **目前運作方式 (白話說明)**：
  系統在更新資料時，是採用**「寫一格、存檔一次」**的方式。如果要更新一位員工的 10 個欄位，系統就會打電話給 Google 伺服器 10 次。
- **風險**：這非常浪費時間與資源。當多人同時操作，或資料量大時，Google 會暫時封鎖我們的請求（Quota Exceeded），導致系統變慢甚至當機。
- **改善方案 A：批次寫入 (Batch Operations) [推薦]**
  - **作法**：將要寫入的資料整理成二維陣列，使用 `sheet.getRange(row, col, numRows, numCols).setValues(values)` 一次性寫入。
  - **效益**：API 呼叫次數從 N 次降為 1 次，速度提升顯著。

> **🛠️ 修復狀態：✅ 已修復**
> **處置**：
> - 實作方案 A (Batch Operations)。
> - 在 `EmployeeLogic.js` -> `_upsertEmployee_` 中，將迴圈單筆 `setValue` 改為單次 `setValues`，將 I/O 呼叫降為 1 次。

### 3. 重複讀取大數據量表 (Redundant Data Fetching)
- **位置**：`EmployeeLogic.js` -> `_getUserProfileById_`
- **目前運作方式 (白話說明)**：
  每當要找某位員工資料時，系統會把**整張幾百人的員工名單**全部讀出來傳回伺服器，然後再從這幾百人裡面慢慢找此人。這就像為了找一本書，把整座圖書館的書都搬回家一樣。
- **風險**：隨著員工人數增加，這動作會越來越慢，最終導致執行超時（Google 限制每次腳本只能跑 6 分鐘）。
- **改善方案 A：文字搜尋器 (TextFinder)**
  - **作法**：使用 `sheet.createTextFinder(userId).matchEntireCell(true).findNext()` 直接定位該行，而非讀取全表。
- **改善方案 B：快取分層 (Layered Cache)**
  - **作法**：同 Issue #1，透過快取減少讀取 Sheet 的頻率。

> **🛠️ 修復狀態：✅ 已修復**
> **處置**：
> - 實作方案 A (TextFinder) 與 B (Layered Cache)。
> - 優化 `_getUserProfileById_`，優先讀取快取。若快取失效，改用 `sheet.createTextFinder(userId)` 精準定位該列資料，不再讀取整張工作表。

### 4. 硬編碼標籤擴散 (Hard-coded Sheet Names)
- **位置**：散落在 `CheckinLogic.js`, `EmployeeLogic.js`, `ScheduledTasks.js` 各處。
- **目前運作方式 (白話說明)**：
  程式碼裡面直接寫死了 Excel 的分頁名稱，例如`"員工資料"`、`"打卡紀錄"`。這就像在很多份合約裡直接寫死某人的名字，而不是寫「甲方」。
- **風險**：未來如果有人在 Excel 上想把「員工資料」改成「人員名單」，程式就會因為找不到名字而全部壞掉，且工程師要逐一檢查幾十個檔案來修改，很容易漏掉。
- **改善方案 A：全域配置模組 (Config Module) [推薦]**
  - **作法**：建立 `Config.gs`，集中定義 `const SHEET_NAMES = { EMPLOYEE: '員工資料', ... }`，其他檔案引用此變數。
- **改善方案 B：Script Properties**
  - **作法**：將設定存於 GAS 的專案屬性中，透過 `PropertiesService` 讀取。

> **🛠️ 修復狀態：✅ 已修復**
> **處置**：
> - 實作方案 A (全域配置模組)。
> - 建立 `Const.gs`，定義 `CONST.SHEET.*` (如 `CONST.SHEET.EMPLOYEE`)。
> - 已全面替換 `EmployeeLogic.js`, `CheckinLogic.js`, `ScheduledTasks.js` 中的硬編碼字串。

### 5. 排程效能隱患 (Date Parsing Overhead)
- **位置**：`ScheduledTasks.js` -> `_getMissedCheckinEmployees_`
- **目前運作方式 (白話說明)**：
  在檢查誰忘記打卡時，系統會把那幾千筆打卡紀錄，**每一筆都拿出來重新計算日期格式**，即便那筆資料是幾個月前的。這非常消耗電腦算力。
- **風險**：當累積紀錄破萬筆時，處理速度會慢到超過 6 分鐘限制，導致檢查任務執行失敗，報表跑不出來。
- **改善方案 A：原生日期比較 (Native Date Comparison)**
  - **作法**：利用 `sheet.getValues()` 自動轉型為 Date 物件的特性，直接操作 Date 物件進行 `getTime()` 比對，避免大量的字串格式化操作。
- **改善方案 B：SQL Query (Google Query Language)**
  - **作法**：若資料量極大，可考慮使用 Google Visualization API Query Language 直接查詢符合日期的列 (唯需注意 GAS 支援度)。

> **🛠️ 修復狀態：✅ 已修復**
> **處置**：
> - 實作方案 A (原生日期比較)。
> - 在 `ScheduledTasks.js` 中，移除迴圈內的 `Utilities.formatDate`，改用 `Date` 物件的 `getFullYear/getMonth/getDate` 進行數值比較，大幅提升過濾效能。

### 6. 部署與同步漏洞 (Sync Logic Defect)
- **位置**：`.claspignore` (缺失) 與部署流程。
- **目前運作方式 (白話說明)**：
  我們在上傳程式碼到伺服器時，**沒有過濾掉測試用的檔案或不相關的設定檔**。這就像搬家時把垃圾桶和裝修工具也一起搬進新家客廳。
- **風險**：如果不小心上傳了寫有「測試網址」的檔案，會直接蓋掉正式環境的設定，導致正式系統連不到資料庫，且很難第一時間發現原因。
- **改善方案 A：設定 .claspignore [必要]**
  - **作法**：新增 `.claspignore` 檔案，排除 `**/*.test.js`, `**/*.bat`, `client/**` 等非 GAS 代碼。

> **🛠️ 修復狀態：✅ 已修復**
> **處置**：
> - 實作方案 A (設定 .claspignore)。
> - 已建立 `.claspignore` 檔案，排除測試檔與 client 端程式碼，確保部署安全性。

### 7. API 缺乏身份驗證 (Critical Security Flaw)
- **位置**：`WebApp.js` -> `doGet` & `doPost`
- **目前運作方式 (白話說明)**：
  後端系統的許多功能（如修改員工、新增案場）就像是**沒鎖的大門**。只要知道這個網址，任何人在瀏覽器輸入特定的指令，系統完全不會問「你是誰」就直接執行。
- **風險**：這非常危險。惡意人士（或離職員工）可以輕易刪改所有員工資料，或把案場資訊全部亂改，造成營運嚴重混亂。
> **🛠️ 修復狀態：⏸️ 暫緩處置 (Deferred)**
> **分析**：
> - 雖然此為 P0 風險，但因應專案需求，目前選擇暫時保留現狀。
> - **建議**：未來若開放更多寫入 API，強烈建議補上 `API_SECRET` 驗證以免遭受未經授權的修改。

### 8. Dropbox Token 競爭與刷新風險 (Token Race Condition)
- **位置**：`dropbox_api.js` -> `dbxGetAccessToken_`
- **目前運作方式 (白話說明)**：
  當 Dropbox 的連線金鑰過期時，如果剛好有 10 個人同時上傳照片，這 10 個人的程式**都會同時試圖去申請新金鑰**。
- **風險**：這會造成混亂，可能第 1 個人申請到了，結果第 2 個人又申請一次把第 1 個人的廢掉，導致大家上傳失敗；或者短時間內申請太頻繁被 Dropbox 封鎖。
- **改善方案 A：全域鎖定 (Global Lock) [推薦]**
  - **作法**：在刷新 Token 前，先呼叫 `LockService.getScriptLock().tryLock(10000)`，確保同一時間只有一個執行緒能執行刷新，其他執行緒等待並直接讀取新 Token。

### 9. 背景任務執行超時風險 (Execution Timeout)
- **位置**：`dropbox_api.js` -> `dbxUploadSession_`
- **目前運作方式 (白話說明)**：
  上傳大檔案（如 150MB 以上）時，系統嘗試**一口氣跑完所有流程**。但 Google 規定每個腳本最多只能跑 6 分鐘。
- **風險**：如果網速慢一點，上傳到一半（例如 80%）剛好滿 6 分鐘，系統會被強制卡斷。下次再執行時，又從 0% 開始，永遠傳不完。
- **改善方案 A：狀態保存與續傳 (Resumable Upload via State)**
  - **作法**：將上傳 session_id 與 offset 存入 Cache 或 Sheet。若超時，下次執行時可讀取狀態從中斷處繼續上傳。

### 10. 併發任務鎖定失效 (Race Condition in Queue)
- **位置**：`CheckinLogic.js` -> `processDeferredCheckinTasks`
- **目前運作方式 (白話說明)**：
  系統在處理排隊的打卡任務時，是「先讀取任務」，然後「慢慢標記為處理中」。但在這「讀取」到「標記」的微小空檔中，其他程式可能也剛好讀到了同一筆任務。
- **風險**：導致同一筆打卡**被處理兩次**。這可能造成員工有重複的班表紀錄，或重複觸發通知。
- **改善方案 A：嚴格鎖定 (Strict Locking) [推薦]**
  - **作法**：使用 `LockService` 包裹「讀取任務 -> 標記 Processing」這一段邏輯，確保原子性 (Atomicity)。

> **🛠️ 狀態更新：🟢 已防護 (無需修復)**
> **分析**：經檢視 `CheckinLogic.js` (L115)，該函式已實作 `LockService.getScriptLock()` 包裹整個執行區塊。目前的保護機制已足夠防止此類競爭，判斷為**誤報**或**已實作**。

### 11. 敏感資訊暴露 (Information Leakage)
- **位置**：`WebApp.js` 錯誤處理與日誌系統。
- **目前運作方式 (白話說明)**：
  當系統出錯時，會把**非常詳細的錯誤內容**（包含程式哪一行錯、資料結構是什麼）直接回傳給使用者的瀏覽器。
- **風險**：這就像把家裡的保險箱密碼貼在大門上。駭客可以透過故意讓系統出錯，看回傳的訊息來推測系統內部是怎麼寫的，進而找到攻擊點。
- **改善方案 A：錯誤訊息遮蔽 (Error Masking) [推薦]**
  - **作法**：全域 `try-catch`，發生錯誤時僅回傳通用錯誤代碼 (如 `ERR_INTERNAL_001`)，詳細日誌僅寫入後端 Logs。

> **🛠️ 修復狀態：⏸️ 暫緩處置 (Deferred)**
> **分析**：
> - 因應專案風險考量，為避免更動 `WebApp.js` 核心邏輯導致不可預期的副作用，目前維持現狀。
> - **備註**：已告知相關資安風險。

### 12. 業務邏輯硬編碼 (Hard-coded Business Rules)
- **位置**：`ScheduledTasks.js` -> `_getFinalAttendanceStatusForReport_`
- **目前運作方式 (白話說明)**：
  工時（8小時）、午休時間（1小時）這些規則，是**直接寫死在程式碼裡面**的。
- **風險**：如果之後來了兼職人員只需上 4 小時，或是公司改成冬令時間下班較早，這些規則會全部誤判成「早退」，且無法由管理員在後台調整，必須請工程師改程式。
- **改善方案 A：設定檔工作表 (Settings Sheet) [推薦]**
  - **作法**：在試算表中建立 `Settings` 分頁，欄位如 `Key`, `Value` (e.g., `WORK_HOURS`, `8`)。程式讀取此表作為參數來源。
- **改善方案 B：員工層級覆蓋 (Per-Employee Override)**
  - **作法**：在員工資料表中增加「工時設定」欄位，允許個別設定。

### 13. 後端邏輯與 UI 組件衝突 (Backend-UI Coupling)
- **位置**：`SiteLogic.js` -> `setupSiteSheet`
- **目前運作方式 (白話說明)**：
  後端的程式碼裡，有些地方直接呼叫了「跳出視窗警告」的指令。
- **風險**：這些指令只有在「人操作Excel」時有效。如果是**自動排程**或**網頁呼叫**在後台執行時，電腦沒地方跳出視窗，程式就會嚇到直接當掉（報錯停止）。
- **改善方案 A：環境檢測 (Environment Detection)**
  - **作法**：封裝 `getUi()`，使用 `try-catch` 包裹。若捕捉到錯誤 (表無 UI)，則改用 `console.log` 或略過 UI 互動。
- **改善方案 B：架構分離 (Decoupling)**
  - **作法**：將 UI 互動邏輯移至 `Code.gs` 的選單觸發函式中，`SiteLogic.js` 只負責純資料處理，回傳結果由上層決定是否顯示 Alert。

### 14. 關鍵寫入缺乏並行鎖 (Missing Write Locks)
- **位置**：`SiteLogic.js` -> `_createSite_` & `_updateSite_`
- **目前運作方式 (白話說明)**：
  新增案場時，系統會先檢查「名字有沒有重複」，沒重複就寫入。但如果兩個管理員**同時**按新增，兩人都會看到「沒重複」，然後**同時寫入**。
- **風險**：結果就是同一個案場被建立了兩次，資料庫出現重複的幽靈資料，造成統計錯誤。
- **改善方案 A：導入 LockService [必要]**
  - **作法**：在執行「檢查是否存在」到「寫入資料」這段期間，取得 Script Lock。

> **🛠️ 修復狀態：✅ 已修復**
> **處置**：
> - 實作方案 A (導入 LockService)。
> - 在 `SiteLogic.js` 的 `_createSite_` 與 `_updateSite_` 中加入 `LockService.getScriptLock()`，確保原子性操作。

### 15. API 回傳格式不統一 (Inconsistent API Schema)
- **位置**：全後端模組。
- **目前運作方式 (白話說明)**：
  有些成功的請求，系統回傳 `status: 'success'`，有些卻回傳 `success: true`。這就像每個人點頭的方式都不一樣。
- **風險**：前端程式在判斷「有沒有成功」時會非常頭痛，必須寫很多 `if...else` 來猜後端這次是用哪種方式點頭，容易產生 bug。
- **改善方案 A：統一回應物件 (Unified Response Helper)**
  - **作法**：建立 `createSuccessResponse(data)` 與 `createErrorResponse(msg)` 函式，強制所有 API 透過此 Helper 回傳標準格式 (e.g., `{ success: true, data: ... }`)。

> **🛠️ 修復狀態：⏸️ 暫緩處置 (Deferred)**
> **分析**：
> - 因涉及大量既有 API 與前端 (LIFF) 的相容性，全面重構成本過高。
> - **建議**：僅在新開發的功能中採用標準格式，舊功能維持現狀。

### 16. 低效的資料類型檢查 (Inefficient Type Checking)
- **位置**：`SiteLogic.js` -> `_getAllSites_`
- **目前運作方式 (白話說明)**：
  系統在讀取試算表時，為了確認哪一格是日期，它會**逐一檢查每一格**（幾千格）的資料型態。
- **風險**：這動作非常慢且沒必要。就像是為了確認一箱水果裡有沒有蘋果，不去只看標籤，而是每一顆都拿起來咬一口確認。
- **改善方案 A：表頭判定 (Header-based Type Inference)**
  - **作法**：僅檢查標題列，確定「日期」在哪一欄 (Col Index)，後續迴圈直接針對該 Index 處理，不需對每個 Cell 做型別檢查。

### 17. 缺乏輸入驗證 (Missing Input Validation)
- **位置**：`ScheduledTasks.js` -> `_getCheckinStatus_` 等核心判斷函式。
- **目前運作方式 (白話說明)**：
  系統在計算時間時，假設試算表裡的資料**永遠都是正確**的時間格式（如 "09:00"）。如果有人不小心手殘打成 "9點"，或者留白。
- **風險**：程式因為看不懂這個字串，計算到一半就會直接崩潰（Crash），導致整個報表流程中斷，後面的人的考勤也算不出來。
- **改善方案 A：健壯的解析函式 (Robust Parser)**
  - **作法**：建立 `parseTime(str)` 輔助函式，內含 Regex 驗證 (`/^\d{2}:\d{2}$/`)。若格式錯誤則回傳 `null` 或預設值，避免程式崩潰。

---

## ⚖️ 修復優先級建議 (Priority Suggestions)

根據風險嚴重性與對業務運作的影響，建議的處理順序如下：

| 優先級 | 項目 (Issue) | 風險等級 | 建議行動 |
| :--- | :--- | :--- | :--- |
| **P0** | **API 缺乏身份驗證** (#7) | Critical | 立即為所有 `doGet`/`doPost` 路由加上 API Key 或 Session 驗證。 |
| **P0** | **關鍵寫入缺乏並行鎖** (#10, #14) | Critical | 在 `processDeferredCheckinTasks` 與案場寫入邏輯中實作 `LockService`。 |
| **P1** | **Dropbox Token 競爭與刷新** (#8) | High | 實作全域鎖定機制，避免多執行緒同時刷新 Token。 |
| **P1** | **極低效的 IO 操作** (#2, #3, #5) | High | 改寫為批量讀寫 (Batch Get/Set)，減少 Google API 呼叫次數。 |
| **P1** | **同步與部署邏輯** (#1, #6) | High | 修正快取清除邏輯，並建立 `.claspignore` 避免測試代碼上傳。 |
| **P2** | **業務邏輯與 UI 耦合** (#13) | Medium | 將所有 `SpreadsheetApp.getUi()` 呼叫移至前端觸發的函式中，避免後端自動執行時崩潰。 |
| **P3** | **硬編碼與代碼異味** (#4, #12, #15) | Low | 提取全域常數設定檔 (Config Sheet)，並統一 API 回傳格式規範。 |
