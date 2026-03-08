# 添心小助手：INCIDENT_LOG (故障紀錄)

## 🛑 重大事故紀錄 (Lessons Learned)

### 2026-03-07 | Thin Client 引導核心缺失 (v1.18.16)
- **現象**：打包排除 `src/*` 導致啟動報錯 `Cannot find module './src/hotReloader'`。
- **解決**：引導核心 (Loaders) 必須包含在原始 EXE 內。**白名單**：`hotReloader.js`, `updater.js`, `versionManager.js`, `versionService.js`, `healthCheck.js`。
- **關鍵依賴**：`fs-extra` 必須置於 `dependencies` 而非 dev。

### 2026-03-06 | 倉庫數據溢出事故
- **現象**：`git push` 因包含 `versions/` 與 `BAK/` 超時及 LFS 報錯。
- **解決**：強化 `.gitignore`。禁止將大型備份推送至 Git。

### 2026-03-08 | 殼層依賴缺失事故 (fs-extra)
- **現象**：安裝檔啟動崩潰並顯示 `Cannot find module 'fs-extra'`。
- **解決**：實施「殼層去依賴化 (Shell Decoupling)」。將 `versionService.js` 與 `versionManager.js` 遷移至原生 `fs` 與 `fsp`。
- **原則**：啟動引導引擎 (Bootstrapping Engine) 必須達成「零第三方依賴」，以應對 CI/CD 打包過程中的不可預知風險。

### 2026-03-08 | Thin Client 啟動對抗性失效 (v1.18.18-19)
- **現象**：打包排除 `src/appCore.js`，初次安裝且無補丁時啟動報錯 `Cannot find module './src/appCore'`。
- **解決**：將 `appCore.js` 永久列入「不可變殼層 (Immutable Shell)」打包白名單。
- **原則**：啟動引導階段所需的所有模組必須內建於 EXE。

### 2026-03-08 | 唯讀核心災難與 BOOT_STRAP 連環車禍 (v1.18.31)
- **現象**：安裝全新 EXE 後引發 `BOOT_STRAP_FAILED`，且 `versionManager.rollback()` 彈出「核心災難」視窗，系統徹底卡死。
- **原因**：
  1. (主因) `package.json` 強制排除 `!src/*`，導致初次安裝時 `healthCheck.js` 找不到 `monitor.js` 等業務邏輯，判定健康檢查失敗。
  2. (次因) `versionService.js` 中 `this.clientPath` 錯誤指向了唯讀的 `app.asar`。當 `healthCheck` 失敗觸發 `rollback()` 時，系統試圖重命名唯讀的 `app.asar`，導致底層權限崩潰，觸發「核心災難」。
  3. (連環) 崩潰後在 catch 區塊呼叫了已被廢棄的 `reportHealthEvent` 函數，引發 TypeError，將真正的錯誤淹沒。
- **解決**：
  - **路徑修正**：將所有動態存取的路徑 (`this.clientPath`, `this.versionsPath`) 移至 `userData/app_patches`，這也是 `hotReloader` 的合法讀取區。
  - **廢除過度精簡**：移除 `package.json` 中的 `!src/*` 黑名單規則。將原本僅不到 2MB 的 JS 源碼完整打包作為 Base Version，一勞永逸解決初次安裝的依賴問題。未來的補丁依然能覆蓋。

## 🛡️ 穩定性防護機制
- **原子級路徑交換**：新補丁解壓至 temp -> 原子移動 (Rename/Move) 替換 client/。
- **自動回退**：若 `healthCheck.js` 失敗，自動呼叫 `versionManager.rollback()`。
- **死循環防禦**：30 秒內啟動超過 3 次即進入維護模式。
