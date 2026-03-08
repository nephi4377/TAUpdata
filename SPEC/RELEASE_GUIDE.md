# 添心小助手：發布要點指南 (RELEASE_GUIDE)
> v1.0 | 確保部署萬無一失的標準操作清單

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
    - **熱更新 Patch**：CI 會將 `src` 壓縮為 `patch-v{VERSION}.zip` 上傳。發布後新版本客戶端將把補丁下載至 `userData/app_patches`，讓 `hotReloader` 優先攔截並載入最新修復，實現無感更新。

---

## 📋 2. 版本三位一體原則
為了確保自動更新與版控不衝突，以下三項必須 ** 100% 一致**：
1.  **Git Tag**: 必須以 `v` 開頭 (例如 `v1.18.20`)。
2.  **package.json**: `version` 欄位必須與 Tag 數值相同。
3.  **GitHub Release Title**: 建議與 Tag 保持一致。

> [!IMPORTANT]
> 若三者不一致，`hotReloader` 可能無法正確識別版本，導致反覆下載或更新失敗。

---

## 🚀 3. CI/CD 自動化流程 (GitHub Actions)
目前的 `build.yml` 邏輯如下：
1.  **觸發條件**：當推送符合 `v*` 規則的 Git Tag 時。
2.  **全量打包**：執行 `npm run build -- --publish always` 生產安裝檔並發布 Release。
3.  **補丁產生**：自動將 `src` 封裝成 `patch.zip` 並掛載到同一個 Release 下。

### 操作建議：
- 推送前確認 `.gitignore` 排除 `BAK/` 與 `versions/`，避免倉庫體積過大導致 CI 超時。

---

## 🛡️ 4. 歷史避坑指南 (Lessons Learned)
根據 `04_INCIDENT_LOG.md` 彙整：
- **依賴缺失**：不要在殼層模組中使用 `fs-extra`，CI 環境安裝依賴時常因網路問題缺失。
- **啟動對抗**：引導核心模組 (Whitelist) 必須包含在 `files` 欄位 (package.json) 中，否則安裝後會遺失文件。
- **打包權重**：`appCore.js` 是核心承重牆，必須隨 EXE 發布，不能只存在於 Patch 中。

---

## ✅ 5. 發布前最後檢查清單
- [ ] `package.json` 版本號已更新？
- [ ] 已執行本地測試確認啟動無誤？
- [ ] `.github/workflows/build.yml` 版本註解已更新？
- [ ] 準備好 Git Tag 命令：`git tag v1.x.x && git push origin v1.x.x`？

---

## 🚨 5. 關鍵事故教訓 (Lessons Learned)

### 🗂️ A. 啟動依賴與唯讀路徑案 (2026-03-08)
- **現象**：安裝後出現「核心災難」視窗，報錯為 `AppCore 初始化失敗`。
- **原因**：
    1. 打包時於 `package.json` 強行排除 `!src/*`，導致安裝後 `healthCheck.js` 無法找到業務模組觸發報錯。
    2. `versionService.js` 中的工作目錄設定到了 `app.asar` (唯讀區塊)，當 `healthCheck` 啟動自動回退，對這區域作 Rename 操作時引爆系統級權限錯誤。
- **對策**：
    - 嚴禁透過 `package.json` 黑名單排除任何 `src/` 下的核心 .js。
    - 原子更新與回退的沙盒必須被約束在可讀寫的 `userData` 路徑中 (`app_patches`)。

### 🔄 B. Git 鎖定與偽同步案 (2026-03-08)
- **現象**：GitHub Actions 列表顯示的 Commit 標題與標籤版本對不齊（例如 Tag 是 .27，標題卻是 .24）。
- **原因**：
    1. 本地 `.git/index.lock` 被系統進程鎖定，導致 Commit 失敗但 Tag 卻成功推播。
    2. Tag 指向了錯誤的舊提交 (SHA)。
- **對策**：
    - **強行檢查 SHA**：確保 GitHub 上的提交哈希值 (SHA) 與本地最新 Commit 一致。
    - **跳號策略**：若發布過程中出現標籤混亂，應立即**跳號發布** (例如從 .25 直接跳到 .29) 來徹底區隔乾淨的版本與錯誤的資產。
    - **順序檢查**：必須先 Push Commit 到遠端並確認顯示正確，再打上對應版本的 Tag。

---
*此指南由 AI 助理小添彙整，旨在輔助設計總監進行高品質交付。*
