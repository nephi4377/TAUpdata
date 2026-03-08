# 添心小助手：AI 助理 (Agent) 自主開發指南 (v1.5)

本指南定義了設計總監與 AI 助理之間的溝通協議，旨在實現**最高效率**的代碼維護與自動化部署。

---

## ⚡ 終極授權：Turbo Mode (免審核自動執行)

為了解除系統安全鎖並實現「一鍵自動修復至部署」，請在對話框包含以下任一關鍵字：

*   **「請使用 Turbo Mode 執行」**
*   **「授權 SafeToAutoRun」**
*   **「授權 git指令」**
*   **「開始部署並允許自動執行後續指令」**

---

## 📋 標準作業流程 (Execute Loop)

當收到任何開發任務時，AI 將嚴格遵守以下循環，**無需每步向您確認**：

1.  **分析 (Analyze)**: 使用 `grep` 與 `view_file` 主動診斷問題點，拒絕黑箱。
2.  **測試 (Test)**: 建立重現點，確認問題存在。
3.  **修復 (Fix)**: 根據分析直接修改程式碼，遵循「高品質代碼規範」。
4.  **驗證 (Verify)**: 再次測試確保功能正常且無連動風險。

---

## 🏰 V2 不可變核心協定 (Immutable Core Doctrine)

從版本 **v2.0.0** 開始，專案進入「引導殼層去依賴化」與「全自動熱更新」的穩定時代。為了保證發布的絕對安全性，**嚴格禁止 Agent 自行修改以下不可變動層 (Immutable Layer) 檔案：**

*   `client/main.js` (Launcher Shell)
*   `client/src/appCore.js` (Bootstrap Engine)
*   `client/src/versionService.js` (Version Manager)
*   `client/src/updater.js` (Patch Downloader)
*   `client/src/hotReloader.js` (Module Loader)
*   `client/src/healthCheck.js` (Safety Net)
*   `client/package.json` (若無明確指示，禁止修改依賴項目)

**開發邊界**：未來的開發與修復，**僅限於**在 `client/src/` 中新增/修改具體業務邏輯模組（如 `apiBridge.js`, `monitor.js`, `tray.js`, UI 元件等）。

---

## 🚫 核心禁令 (Crucial Restrictions)

1.  **重啟許可**: 許可 Agent 執行重啟指令以驗證開發結果，但執行前需明確說明目的。
2.  **禁止 PowerShell 寫日誌**: 嚴禁使用 PowerShell 往 `.md` 寫錄（避免亂碼）。必須使用 AI 編輯工具維護日誌。
3.  **單一紀錄出口**: 所有修改必須精確記錄於 `d:/Dropbox/CodeBackups/添心生產力助手/部署記錄_添心生產力助手.md`。

---

## 🛠️ 推薦觸發令 (Recommended Triggers)

您只需一段描述 + 指向計畫書即可觸發全自動流：

> **範例指令：**
> "請依照計畫書 `@添心小助手計劃書.md` 修復：統計中心數據溢出問題。
> **請使用 Turbo Mode 執行** 並遵循 SOP。"

---
*本指南由設計總監核定，Agent 讀取後需即刻以此邏輯運作。*
