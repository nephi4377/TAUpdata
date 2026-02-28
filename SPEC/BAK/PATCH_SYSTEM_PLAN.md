# 添心生產力助手：熱更新熔斷保護與增量補丁實作計畫 (v1.7.0)

## 1. 核心目標
為了解決更新導致程式無法啟動的問題，並達成「像遊戲一樣」的增量更新體驗，本計畫將實作一套具備**熔斷機制**、**熱抽換 (Hot Swap)**、與**內部軟重啟**的架構。確保代碼錯誤時程式仍能啟動，且更新過程僅針對異動檔案，甚至能達成免重啟自動修復。

---

## 2. 技術架構方案

### A. 增量補丁與雙重加載 (Incremental Patching)
*   **機制**：程式啟動時，會同時檢查「出廠預裝版本 (Standard)」與「下載補丁版本 (Patches)」。
*   **作法**：更新不再下載全量 `.exe`，而是下載 `patch.zip`。解壓至使用者數據目錄 (`userData/app_patches`)。
*   **優先權**：若補丁目錄存在有效代碼，則優先加載補丁；否則回退至原廠代碼。

### B. 熔斷保護與自動回滾 (Circuit Breaker & Fallback)
*   **沙盒驗證**：加載新代碼前，先由「安全加載器 (SafeLoader)」執行 `try-catch`。
*   **異常捕捉**：如果代碼存在語法錯誤 (SyntaxError) 或啟動異常，加載器會捕捉異常，不讓 `main.js` 崩潰。
*   **自動熔斷**：若加載失敗，自動標記該補丁為「損壞 (Corrupted)」，立即回退至最後一個穩定版本 (Last Known Good)。

### C. 活體修復與熱抽換 (Hot Swapping - 免重啟)
*   **模組重載**：利用清理 `require.cache` 方式，在補丁下載完成後，強制程式重新讀取磁碟上的新 js 檔案。
*   **無感替換**：主進程透過 Proxy 模式加載功能模組。當檢測到新補丁，直接將內部指針轉向新物件，**現有視窗不需重啟即可獲得新功能**。

### D. 內建軟重啟 (Soft Restart)
*   **機制**：當更新涉及全域狀態（如 IPC 事件變更）無法熱抽換時，執行內部軟重啟。
*   **執行流程**：
    1.  儲存當前暫存數據。
    2.  銷毀所有現有 BrowserWindow 視窗。
    3.  即時重新初始化所有運算 Service 實例。
    4.  重新開啟視窗並恢復狀態。
*   **效益**：程式不會從工作列消失，使用者體感僅為「介面刷新」。

---

## 3. 具體修改內容

### 1. 新增安全加載與熱管理 (`src/hotReloader.js`)
負責模組的動態引入、快取清理與熔斷驗證。
```javascript
function loadModuleSafely(name) {
    try {
        const patchPath = getPatchPath(name);
        if (isValidPatch(patchPath)) {
            delete require.cache[require.resolve(patchPath)];
            return require(patchPath);
        }
    } catch (err) {
        log.error("補丁故障，熔斷回退:", err);
    }
    return require(`./src/${name}`); // 回退內建穩定版
}
```

### 2. 優化自動更新邏輯 (`updater.js`)
*   支援下載特定檔案的 Patch 包。
*   實作活體檢測，下載完畢立即通知 `hotReloader` 嘗試套用。

### 3. CI/CD 流程調整 (`build.yml`)
*   支援產生 `patch-vX.X.X.zip`。

### 4. 突破依賴解析盲區 (v1.7.2 新增)
*   **Module._compile 沙盒**：不依賴傳統的 `require()` 加載外部補丁，而是將補丁檔案轉為純字串，透過 Node.js 底層的 `Module._compile` 動態編譯。以此賦予補丁一個等同於原始 `app.asar` 內部的偽裝路徑 (`absoluteLocalPath`)。
*   **效益**：這確保了從 `AppData` 下載的補丁也能順利解析並引入打包在安裝檔內的巨大第三方套件 (如 `sql.js`, `active-win`)，徹底解決增量更新的脫節死機問題。

---

## 4. 預期效益
1.  **零崩潰啟動**：不管更新檔寫得多爛，程式永遠打得開。
2.  **免重啟修復**：修復檔推送後，程式在運行中自動替換損壞模組。
3.  **極速下載**：更新從 60MB 縮小到 100KB。
4.  **穩定性保證**：出錯時能自動退回舊版，並等待下一個正確的更新檔。

---

## 5. 存檔資訊
*   **檔案路徑**: `.../添心生產力助手/SPEC/PATCH_SYSTEM_PLAN.md`
*   **建立日期**: 2026-02-22
*   **狀態**: 已實作 (Implemented in v1.7.0 ~ v1.7.5)
