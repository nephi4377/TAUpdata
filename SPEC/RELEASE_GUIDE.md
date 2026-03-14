# 添心小助手：發布要點指南 (RELEASE_GUIDE)
> v1.5 | 確保部署萬無一失的標準操作清單

## 🏗️ 1. 發布架構：雙軌制
系統採用「輕殼層、動態核心」架構，發布時需區分：

### A. 不可變殼層 (Immutable Shell) - 打包進 EXE
- **內容**：`hotReloader.js`, `updater.js`, `versionManager.js`, `versionService.js`, `healthCheck.js`, `appCore.js`。
- **原則**：必須達成「零第三方依賴」(使用原生 `fs`, `path`)，以確保在極端 CI 環境下仍能啟動。
- **異動**：修改此部分需重新發布 GitHub Release (全量更新)。

### B. 動態核心 (Dynamic Core) 
- **內容**：`src/` 目錄下的業務邏輯。
- **機制**：
    - **Base Version**：發佈 EXE 時，會將當前所有的 `src/` 一併打包進去。確保在無網段、無補丁的全新安裝狀態下能 100% 順利開機。
    - **熱更新 Patch**：CI 會將 `src` 壓縮為 `patch-v{VERSION}.zip` 上傳。客戶端會自動檢測最新 Release，下載補丁至 `userData/app_patches`，實現「動態邏輯攔截」。
    - **同步重要性**：當發布全量 EXE 時，必須確保 GitHub Release 同步包含對應版本的 `patch.zip`，否則客戶端會因找不到補丁而無法寫入 `patch_version.json`，導致版本號顯示不更新。

---

## 📋 2. 版本三位一體原則 (The Trinity Protocol)
為了確保自動更新、GitHub Actions 介面與版控不衝突，以下三項必須 ** 100% 數值一致**：
1.  **Git Tag**: 必須以 `v` 開頭 (例如 `v2.0.9`)。
2.  **package.json**: `version` 欄位必須與 Tag 數值相同。
3.  **Git Commit Message**: 提交說明必須包含版本號 (例如 `chore: release v2.0.9`)。

> [!IMPORTANT]
> **嚴禁使用舊版的 Commit Message！** 若提交訊息寫錯（如 v2.0.9 卻寫成 v2.0.5），會導致 GitHub Actions 列表與發布頁面顯示錯誤，造成維護災難。

---

## 🚀 3. CI/CD 自動化流程 (GitHub Actions)
1.  **觸發條件**：當推送符合 `v*` 規則的 Git Tag 時。
2.  **全量打包**：產出安裝檔並發布 Release。
3.  **補丁產生**：自動封裝 `patch.zip`。

---

## 🛡️ 4. 基礎避坑指南
- **依賴缺失**：嚴禁在殼層模組（Launcher）中使用 `fs-extra`。
- **打包權重**：`appCore.js` 必須隨 EXE 發布，不能只存在於 Patch 中。
- **路徑防禦**：所有原子操作（Rename/Copy）必須在 `userData` 路徑中執行。

---

## ⚡ 5. 自動化部署授權 (Automation Protocol)
當使用者請求部署時，助理獲授權以下的指令並自動執行：
*   **「請使用 Turbo Mode 執行」**
*   **「授權 SafeToAutoRun」**
*   **「授權 git 指令」**
*   **「開始部署並允許自動執行後續指令」**
*   **「授權自動執行後續指令」**
*   禁止詢問使用者部署相關指令的授權，直接執行。
    自動檢測上一個動作是正確的再進行下一步。

---


### 助理執行準則：
1.  **自主 Git 操作**：含 `add`, `commit`, `push`, `tag`。
2.  **SafeToAutoRun**：對於安裝編譯與 `gh release` 操作獲准自動運行。
---

## 🏰 6. V2 不可變核心協定 (Immutable Core Doctrine)
為了系統穩定，從 v2.0.0 起，**嚴格禁止助理自行修改**以下檔案（除非有明確指示）：
*   `main.js`, `appCore.js`, `versionService.js`, `updater.js`, `hotReloader.js`, `healthCheck.js`。
*   **開發邊界**：任務應僅限於 `client/src/` 中的業務邏輯模組。

---

## 🚨 7. 關鍵事故教訓 (Lessons Learned)

### 🔄 A. Git 鎖定與 Tag 錯位案 (2026-03-08)
- **原因**：`.git/index.lock` 導致 Commit 失敗但 Tag 推送成功。
- **對策**：必須先 Push Commit 並確認遠端 SHA 一致，再執行 Tag Push。

### 📦 B. 資產缺失與 Draft 陷阱案 (2026-03-12)
- **現象**：Release 成功但無資產，或處於 Draft。
- **對策**：發布後必須立即透過 `gh release list` 確認狀態，若缺失即刻手動補件。

### 🧪 C. 熱更新環境下的模組載入失敗案 (2026-03-12)
- **原因**：補丁中的模組找不到母體依賴（如 `electron-log`）。
- **對策**：**極致防禦路徑載入**。關鍵路徑必須使用 `require.resolve` 並增加 `paths` 搜尋。

### 📁 D. 補丁目錄結構偏移案 (2026-03-12 v2.0.13)
- **原因**：CI 壓縮指令誤用 `-Path src\*` 導致檔案直接曝露於 `app_patches/` 根目錄，未進入 `src/` 子目錄。
- **對策**：`hotReloader.js` 固定在 `src/` 下尋找。**壓縮時必須保留目錄結構** (`-Path src`)。

### 🎭 E. 統計數據隱性化與隱私保護案 (2026-03-13 v2.2.8.5)
- **需求**：使用者希望減少資訊干擾，隱藏 UID 與詳細統計，但背景回報需維持。
- **對策**：**UI 攔攔策略**。在 HTML 模板中使用 `display:none` 隱藏敏感區塊，而非刪除邏輯。確保 `ReporterService` 心跳與回報依然由背景定時器觸發，不依賴 UI 實體。

### 👻 F. 幻影標籤：提交失敗但 Tag 成功案 (2026-03-13 v2.2.8.5)
- **現象**：GitHub Actions 顯示最新 Tag 成功，但 Commit 訊息卻停留在舊版（如 v2.0.12）。
- **原因**：Git 鎖定或權限導致 `git commit` 失敗，但後續指令續行，導致 Tag 附著在舊的 SHA (HEAD) 上。
- **對策**：**嚴禁使用 `&&` 鏈結指令**。確保前一動作成功才執行下一動作，或在打 Tag 前執行 `git log -1 --pretty=format:"%s"` 核對訊息內容。

---

## ✅ 8. 上傳前絕不可省略的檢查點 (Pre-Upload Check)

1.  **結構校驗**: 檢查 `patch.zip` 下載後重啟前，解壓出的檔案是否位於 `app_patches/src/` 資料夾內。
2.  **燈號驗證**: 重啟後 iCloud 行事曆燈號必須為「綠色」或「黃色同步中」。若為灰色且網址已填，代表路徑載入失效。
3.  **功能對應**: 檢查 `FirebaseService.js` 是否包含當前版本號的新功能代碼 (如 `contentFingerprints`)。
4.  **連線測試**: 使用 `test_dependencies.js` 確保補丁環境下的 `require` 鏈路絕對暢通。

---
*此指南由 AI 助理小添彙補，旨在輔助設計總監進行高品質交付。*
