# 添心生產力助手 - 程式現況說明
> v1.4 - 2026-02-15 23:05 (Asia/Taipei)

---

## 📋 程式版本資訊

| 項目 | 值 |
|------|---|
| 程式名稱 | TienxinAssistant |
| 版本號 | 1.0.0 |
| 框架 | Electron 28.x |
| 資料庫 | sql.js (SQLite in-memory) |
| 打包工具 | electron-builder 24.x |
| 安裝方式 | NSIS 安裝程式 (.exe) |
| 更新機制 | electron-updater + Generic Provider |
| 更新伺服器 | `https://info.tanxin.space/client_updates/` |

---

## 🏗️ 檔案架構

```
client/
├── main.js                    # v1.3 - 主程序入口
├── package.json               # 專案設定與打包配置
├── data/                      # 本地資料目錄 (Portable Mode)
│   ├── tienxin-productivity-config.json  # 設定檔 (electron-store)
│   └── productivity.db        # SQLite 資料庫
├── src/
│   ├── monitor.js             # v1.7 - 前景視窗監測服務
│   ├── storage.js             # v1.5 - 本地 SQLite 儲存
│   ├── classifier.js          # 應用程式分類引擎
│   ├── tray.js                # v1.6 - 系統托盤管理
│   ├── config.js              # v1.1 - 設定管理 (含員工綁定)
│   ├── checkinService.js      # v1.1 - 打卡系統整合
│   ├── setupWindow.js         # v1.0 - 首次設定/切換使用者視窗
│   ├── reminderService.js     # v1.1 - 智慧工作提醒
│   ├── reporter.js            # v1.1 - 資料回報服務 (⚠️ 目前未被 main.js 引用)
│   └── reminderPreload.js     # 提醒視窗預載腳本
└── assets/
    └── icon.ico               # 應用程式圖示 (⚠️ 預設 Electron 圖示)
```

---

## ✅ 已實作功能

### 1. 前景視窗監測 (`monitor.js`)
- **取樣間隔**：每 30 秒取樣當前前景視窗
- **記錄內容**：應用程式名稱、視窗標題、使用時長
- **閒置偵測**：系統閒置超過 5 分鐘 → 記為「idle」
- **午休偵測**：12:00 ~ 13:00 自動記為「lunch_break」
- **休閒警示**：連續使用休閒類應用超過閾值（預設 15 分鐘）→ 彈出置頂小視窗提醒
- **工作警示**：連續工作超過閾值 → 提醒休息（分三級）
- **暫停/恢復**：支援暫停監測（午休、15 分鐘、30 分鐘、自訂）

### 2. 本地資料儲存 (`storage.js`)
- **資料庫**：sql.js (SQLite in-memory)，定期寫入 `data/productivity.db`
- **記錄表**：`activities` — 存放每筆取樣記錄
- **延遲寫入**：10 秒 debounce 避免頻繁磁碟 I/O
- **統計功能**：
  - `getTodayStats()` — 今日各分類時間彙總
  - `getStatsByDate(dateStr)` — 指定日期統計（用於補傳報告）
  - `getDetailedStats(dateStr)` — 詳細統計（每個程式使用時間 + 未分類關鍵字）
  - `getHourlyStats()` — 每小時統計
  - `getBrowserHistory()` — 今日瀏覽器使用記錄
  - `getRecentTopApps(days)` — 最近 N 天最常用程式排行
- **資料清理**：`cleanOldData(keepDays)` 保留最近 30 天

### 3. 應用程式分類 (`classifier.js`)
- **分類類別**：
  - `work` — 工作類（AutoCAD、Office、Adobe、LINE 等）
  - `leisure` — 休閒類（遊戲、影音、社群媒體）
  - `music` — 音樂類（Spotify、KKBOX、Apple Music）
  - `other` — 未分類
- **判斷方式**：
  1. 視窗標題關鍵字比對（優先）
  2. 應用程式名稱比對
  3. 未匹配時預設為 `other`
- **子分類**：`work` 下細分「設計」「文書」「通訊」；`leisure` 下細分「影音」「社群」「遊戲」「購物」
- ⚠️ **已知問題**：部分明顯的遊戲名稱（如 FINAL FANTASY XIV）未列入黑名單

### 4. 系統托盤 (`tray.js`)
- **托盤圖示**：動態產生的綠色/黃色/紅色圓點圖示（程式碼產生，非圖檔）
- **右鍵選單**：
  - 📊 今日統計（彈出詳細統計視窗）
  - ⏸️ 暫停監測（午休 / 15 分 / 30 分 / 1 小時）
  - ▶️ 恢復監測
  - 👤 打卡資訊
  - 📋 智慧提醒狀態
  - 🔔 提醒事項待辦列表
  - 🔄 切換使用者（需管理者密碼）
  - 📁 開啟資料夾
  - ℹ️ 關於
  - ❌ 結束程式
- **詳細統計視窗**：顯示今日統計、每小時時間軸、TOP 10 應用程式、瀏覽器記錄、打卡資訊

### 5. CheckinSystem 整合 (`checkinService.js`)
- **綁定機制**：
  1. 本地查詢已綁定的員工 (`config.getBoundEmployee()`)
  2. 若無本地綁定 → 用電腦名稱查後端 (`getEmployeeByPcName()`)
  3. 若後端也無 → 需要首次設定（`needSetup = true`）
- **打卡資訊**：呼叫後端 `get_work_info` API 讀取今日打卡狀態
  - ⚠️ **注意**：此 API 只讀取打卡紀錄，不會產生打卡行為
  - 回傳資料：`checkedIn`, `checkinTime`, `expectedOffTime`, `remainingMinutes`
- **定時刷新**：每 60 分鐘刷新打卡資訊
- **生產力報告上傳**：
  - 每日 18:00 自動上傳今日報告
  - 隔天啟動時自動補傳昨日報告
  - **[v1.4 核心修復 - 數據完整性]**：
    - 實作 **UPSERT (Update or Insert) 邏輯**：解決了相同電腦/人員/日期重複上傳導致列溢出的問題。
    - **時區標準化**：強制使用 `Utilities.formatDate` 配合 `Asia/Taipei` (GMT+8) 進行日期格式化後比對，排除 GAS 預設時區造成的日期偏差。
    - **強健標頭偵測**：實作寬鬆比對演算法，自動 `trim()` 並忽略大小寫，確保在表格結構微調（如插入空行、改欄位名）時仍能精準寫入。
  - 報告內容：各分類使用時間、生產力指數、詳細記錄、未完成提醒事項

### 6. 首次設定 / 切換使用者 (`setupWindow.js`)
- **首次設定**：
  - 從後端取得在職員工列表
  - 顯示視窗讓使用者選擇「我是誰」
  - 選擇後綁定電腦名稱到該員工，同時通知後端
- **切換使用者**：
  - 需先輸入管理者密碼（`Tx2649819`）
  - 驗證通過後顯示員工選擇視窗
- ⚠️ **已知問題**：首次啟動可能未正確觸發設定視窗（見下方 BUG 清單）

### 7. 智慧工作提醒 (`reminderService.js`)
- **預設提醒事項**：
  - 打卡提醒 — 上班後 15 分鐘觸發
  - 回報進度 — 距下班 90 分鐘觸發
  - 填寫日報 — 距下班 30 分鐘觸發
  - 檢查工地照片 — 距下班 60 分鐘觸發
  - 確認明日行程 — 距下班 45 分鐘觸發
- **觸發條件**：
  - 根據員工班表時間動態計算觸發時刻
  - 打卡提醒：若已打卡則自動標記完成
  - 非連續型提醒不在同一天重複觸發
- **互動功能**：
  - 提醒彈出視窗含「✅ 完成」和「⏰ 稍後提醒」按鈕
  - 稍後提醒 → 15 分鐘後再次觸發
- **報告整合**：未完成的提醒會附加在每日生產力報告中

### 8. 開機自動啟動 (`main.js`)
- 使用 `app.setLoginItemSettings({ openAtLogin: true })` 設定
- 僅在打包後（`app.isPackaged`）生效
- 防止多重執行（`app.requestSingleInstanceLock()`）

### 9. 自動更新 (`main.js`)
- 使用 `electron-updater` 搭配 Generic Provider
- 更新伺服器：`https://info.tanxin.space/client_updates/`
- 啟動時自動檢查更新
- 下載完成後提示使用者重啟安裝

### 10. 設定管理 (`config.js`)
- **儲存位置**：`client/data/tienxin-productivity-config.json`（Portable Mode）
- **儲存方式**：electron-store（JSON 檔案）
- **支援舊設定遷移**：從 AppData 路徑自動遷移到專案目錄
- **管理者密碼**：`Tx2649819`（寫在程式碼中）
- **後端 API URL**：硬編碼在 config.js 中

---

## ⚠️ 已知問題 / BUG

### 🔴 P0 — 重大問題

| # | 問題 | 說明 |
|---|------|------|
| 1 | **首次設定視窗未觸發** | 安裝後首次啟動時，`initializeOnStartup()` 回傳 `needSetup: true` 後應彈出設定視窗，但使用者回報未看到。可能原因：(a) 後端 `getEmployeeByPcName()` 意外回傳了資料（電腦名稱已被其他員工綁定）；(b) 設定視窗被其他錯誤攔截在 catch 區塊中。 |
| 2 | **顯示了不應存在的打卡資訊** | 使用者今天沒打卡但看到打卡資訊。可能原因：`getEmployeeByPcName()` 回傳另一位員工的資料，導致程式綁定到錯誤的 userId，顯示該員工的打卡紀錄。 |

### 🟡 P1 — 功能缺失

| # | 問題 | 說明 |
|---|------|------|
| 3 | **`reporter.js` (每小時回報機制)** | **需實作**：每小時回報，但邏輯需改為「累加模式」（若當日資料已存在則 Update，否則 Insert）。 |
| 4 | **無自訂應用程式圖示** | 打包時使用預設 Electron 圖示，因 `assets/icon.ico` 未設定或缺失。 |
| 5 | **遊戲應用未完整分類** | 缺乏遊戲名稱資料庫。建議實作「後端規則同步」機制解決此問題。 |
| 6 | **隱私視窗 (Privacy Window)** | **已取消**：依需求確認，所有視窗標題皆需完整記錄，不需隱藏。 |

### 🟢 P2 — 改進建議

| # | 問題 | 說明 |
|---|------|------|
| 7 | **管理者密碼硬編碼** | 密碼 `Tx2649819` 直接寫在 `config.js` 原始碼中，無法遠端變更。 |
| 8 | **API URL 硬編碼** | `CHECKIN_API_URL` 寫死在程式碼中，若後端更新部署則需重新打包。 |
| 9 | **後端規則同步 (Rule Sync)** | **建議實作**：為了不需每次更新軟體名單都要重新打包 EXE，建議讓程式啟動時從 Google Sheet 讀取最新的分類規則 (例如新遊戲名稱)。 |
| 10 | **無管理儀表板** | 原 SPEC 計畫的 Web 管理儀表板未實作，目前從 Google Sheets 直接查看。 |

---

## 📊 與原 SPEC 對照

| 原計畫功能 | 實作狀態 | 備註 |
|-----------|---------|------|
| 前景視窗監測 | ✅ 完成 | 每 30 秒取樣 |
| 使用時間累計 | ✅ 完成 | SQLite in-memory + 定期存檔 |
| 定時回報 (每小時) | ❌ 未啟用 | `reporter.js` 存在但未被 `main.js` 引用 |
| 系統托盤 | ✅ 完成 | 功能遠超原計畫 |
| 開機自動啟動 | ✅ 完成 | `app.setLoginItemSettings` |
| 離線快取 | ✅ 完成 | 本地 SQLite + 隔日補傳 |
| 暫停功能 | ✅ 完成 | 多種預設時段 + 自訂 |
| 隱私視窗 | ❌ 未實作 | 原計畫的隱私模式功能 |
| 應用程式分類引擎 | ✅ 完成 | 本地關鍵字比對 |
| 從後端同步分類規則 | ❌ 未實作 | 分類規則寫死在客戶端 |
| 管理儀表板 (Web) | ❌ 未實作 | |
| 打包成 exe | ✅ 完成 | NSIS 安裝程式 |
| **[新增] CheckinSystem 整合** | ✅ 完成 | 員工綁定、打卡資訊、報告上傳 |
| **[新增] 智慧工作提醒** | ✅ 完成 | 打卡/日報/進度等提醒 |
| **[新增] 自動更新** | ✅ 完成 | electron-updater + GitHub Pages |
| **[新增] 休閒/工作警示** | ✅ 完成 | 置頂小視窗通知 |
| **[新增] 每日報告上傳** | ✅ 完成 | 18:00 自動 + 隔日補傳 |

---

## 🔧 啟動流程（main.js）

```
app.whenReady()
  ├── setupAutoLaunch()           — 設定開機自啟
  ├── autoUpdater.checkForUpdatesAndNotify()  — 檢查更新
  ├── configManager.init()        — 初始化設定
  ├── storageService.init()       — 初始化 SQLite
  ├── classifierService           — 初始化分類引擎
  ├── monitorService              — 初始化監測（尚未啟動）
  ├── checkinService              — 初始化打卡服務
  ├── setupWindow                 — 初始化設定視窗
  ├── reminderService.start()     — 啟動提醒排程 ⚡
  ├── trayManager.init()          — 建立系統托盤
  ├── monitorService.start()      — 啟動監測 ⚡
  └── initializeCheckinIntegration()
       ├── checkinService.initializeOnStartup()
       │    ├── 本地有綁定? → 取得打卡資訊
       │    ├── 用電腦名稱查後端? → 自動同步綁定
       │    └── 都沒有? → needSetup = true
       ├── needSetup? → setupWindow.show('setup')
       ├── handleWorkInfoUpdate()  — 更新打卡資訊到 config
       ├── checkAndSubmitYesterdayReport()  — 補傳昨日報告
       └── startScheduledTasks()   — 啟動定時排程
            ├── 每 60 分鐘刷新打卡資訊
            └── 每日 18:00 上傳今日報告
```

---

## 📝 更新記錄

| 版本 | 日期 | 內容 |
|------|------|------|
| v1.0 | 2026-02-01 | 初版計畫制定（IMPLEMENTATION_PLAN） |
| v1.0 | 2026-02-01 | 部署指南（DEPLOY_GUIDE） |
| v1.3 | 2026-02-15 | 本文件：程式現況 + BUG 清單 + 功能對照 |
| v1.4 | 2026-02-15 | **後端架構大修與生產力修復**：<br>1. **數據同步機制**：實作生產力報告 UPSERT 邏輯，徹底解決數據重複冗餘問題。<br>2. **全域時區標準化**：統一所有日期比對邏輯至台北時區 (GMT+8)。<br>3. **後端路由重構 (v400)**：將 `WebApp.gs` 路由邏輯從原始 `switch` 遷移至「處理器對應表 (Handler Mapper)」，大幅提升穩定性並解決 Hub (儀表板) 路由衝突報錯。<br>4. **部署環境排難**：引導克服 GAS 200 版本限制、鎖定並清除雲端「幽靈檔案」導致的 SyntaxError 衝突。<br>5. **代碼清理**：刪除所有開發期測試腳本，恢復專案極簡與高效狀態，成功部署 Version 207。 |

以下是我個人的筆記
提醒事項關不掉, 先按完成不會不見 但會記錄完成
再按稍後提醒才會不見 但會記錄變為稍後 整個不合理
目前還是沒有能夠在安裝後選擇使用者..

讓我可以「自動導航」更久的指令技巧：
列出具體清單 (Batch Tasks)：
「請幫我完成以下三件事：1. 重構 A 檔案、2. 撰寫 B 測試、3. 更新 C 文件。請一口氣做完再叫我。」 這樣子我就會將這些步驟建立在 
task.md
 中，並依序執行，直到全部完成才通知您。

授權自動決策 (Auto-Proceed)：
「如果遇到小的 Lint 錯誤或缺漏，由於我不在，授權你直接修正，不需要每次都停下來問我。」 這樣可以減少我因為小問題而中斷任務，卡在 notify_user 等您回來。

定義「完成的樣子」 (Definition of Done)：
「請重構這整個模組，直到所有測試都通過為止。」 這樣我就會進入「修改 -> 跑測試 -> 修改」的循環，直到目標達成。