# 添心小助手：MASTER_PLAN (核心憲法)
> v2.6 | 里程碑：DevOps 聯席與 [全量系統圖 v3.0](file:///c:/Users/a9999/Dropbox/CodeBackups/CODING/SPEC/07_SYSTEM_FLOW_MAP.md) 整合

## 📋 專案概述
建立一個透明、非侵入式的生產力監測系統。
- **透明性**：員工清楚知道系統在監測什麼。
- **非侵入**：追蹤視窗標題，不截圖、不記錄鍵盤。
- **輕量化**：最小化資源佔用。
- **隱私保護**：不追蹤網頁內容或聊天訊息。

## 🏗️ 系統架構 (指揮塔 + 專家特遣隊)
系統採用 **「輕殼層、動態核心」** 架構：
- **不可變殼層 (Immutable Shell)**：`main.js`, `hotReloader.js`, `updater.js`, `versionManager.js`。負責啟動、補丁下載與原子化替換。此部分為「核心承重牆」，嚴禁頻繁修改。
- **動態核心 (Dynamic Core)**：`monitor.js`, `apiBridge.js`, `storage.js`, `classifier.js` 等業務邏輯模組。透過 `patch.zip` 進行熱更新。

## 🛡️ Agent 核心維護與自動化規範 (軍規)
- **維護模式**：30 秒內啟動超過 3 次即進入維護模式，停止自動重啟。
- **禁止 PowerShell 寫日誌**：必須使用編輯工具 (`replace_file_content`) 更新 md。
- **唯一出口**：所有修改必須記錄於「部署記錄_添心生產力助手.md」。
- **Turbo Mode**：授權在收到「授權 SafeToAutoRun」或「開始部署」時自主執行 Git 與部署。

## 🚨 發布與倉庫防護
- **GitHub Release**：單檔限制 100MB。
- **倉庫防火牆**：嚴格排除 `versions/`, `BAK/`, `node_modules/`。
- **版本三位一體**：Tag、Release 標題、`package.json` 必須 100% 一致。
- **CI 容錯**：`build.yml` 必須設定 `HUSKY: 0` 並使用 `npm ci --no-scripts`。
