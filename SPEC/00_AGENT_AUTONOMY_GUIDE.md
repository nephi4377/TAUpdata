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

當收到開發任務時，AI 將採取「設計先導、原子化開發」策略，嚴格遵守以下高度自主的開發循環：

1.  **分析與計畫 (Analyze & Plan)**: 
    - **分析並回報**: **收到命令時，AI 必須第一時間分析請求意圖並向使用者回報，待確認需求後方可執行。**
    - **全域合規**: 讀取並遵守 `.../SPEC/PROJECT_CONTEXT.md` 中關於靜默更新與 CI/CD 的規範。
    - **程式走訪**: 調用工具閱讀相關段落，確保新方案與既有架構「高內聚、低耦合」。
2.  **原子化開發 (Atomic Fix)**: 
    - **單一職責原則**: 每次修改僅針對一個核心病灶。嚴禁混雜無關的重構，確保「一版本一目的」。
    - **最小影響面積**: 追求「非侵入式」修改，變更應具備 **「低耦合、易回退」** 特性，將系統震盪降至最低。
    - **規範落實**: 嚴格執行「高品質代碼規範」與「版本註解 (vYY.MM.DD)」，不留任何未說明的斷碼。
3.  **自我驗證與閉環自癒 (Self-Verify & Heal)**: 
    - **三位一體檢測**: 主動執行「環境語法檢查 (Lint) -> 邏輯鏈驗證 -> 連動模組掃描」，確保功能閉環。
    - **閉環自癒 (Self-Healing)**: 遇報錯即刻觸發「自動複盤」，自主修正錯誤直至達成目標。此過程落實「背景消化、不干擾使用者專注」之原則。
4.  **交付與同步 (Deliver & Sync)**: 
    - **文檔即事實 (Doc-as-Truth)**: 修改代碼必同步更新對應的 `SPEC/` 文件。
    - **透明記錄**: 自動更新部署記錄並產出 `walkthrough.md`，實現高品質的技術交付。

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


撰寫程式時，請加上註解說明更新用途,並且記錄版本號。


---

## 🛠️ 推薦觸發令 (Recommended Triggers)

您只需一段描述 + 指向計畫書即可觸發全自動流：

> **範例指令：**
> "請依照計畫書 `@添心小助手計劃書.md` 修復：統計中心數據溢出問題。
> **請使用 Turbo Mode 執行** 並遵循 SOP。"

---
*本指南由設計總監核定，Agent 讀取後需即刻以此邏輯運作。*
