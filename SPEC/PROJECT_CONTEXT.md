# 專案技術上下文 (Project Technical Context)
版本：v1.11.24 (2026-02-26)

> [!IMPORTANT]
> **本文件定義之規範優先級最高。標註為「不可變動」之核心機制涉及系統穩定性與安全性，未經徹底測試嚴禁修改原有邏輯。**

## 🏗️ 系統架構與模組地圖 (Architecture)

本系統採 **Micro-Service at Edge** 架構，由 `AppCore` 集中調度，確保各服務解耦。

### 核心服務與職責 (Services)
- **`appCore.js` (核心大腦)**: 
  - 負責模組載入、IPC 註冊、定時任務。
  - **!!! 不可變動 !!!**: `restartServices` 必須採 **強制全程序重啟 (Relaunch)** 模式，嚴禁使用軟重載以防 IPC 殘留。
- **`tray.js` (UI 門面)**: 負責圓形圖示繪製、報表生成、小秘書影像快取載入。
- **`monitor.js` (行為引擎)**: 前景視窗取樣（15秒）。Toast 提醒採用暫存 HTML 以防渲染衝突。
- **`config.js` (設定管理)**: 
  - **!!! 不可變動 !!!**: `isAdmin` 方法之判定條件（黃俊豪/BOSS/PermissionLevel >= 5）為系統權限核心，嚴禁刪除或降級。
- **`storage.js` (持久化層)**: SQLite 驅動，今日數據每 15 秒保存一次。
- **`checkinService.js` (後端對口)**: 處理 GAS 打卡 API 與通訊。

---

## 🎯 核心機制與功能定義

### 1. 靜默熱更新與自動對齊 (Modern Hot-Update)
- **原理**: 為了不干擾工作，更新過程必須是背景無感的。
- **實作**: 補丁 (`patch`) 背景下載完成後，觸發 `appCore.restartServices()`。
- **!!! 不可變動規範 !!!**: 
  - 為防止「Attempted to register a second handler」及內存溢出，**熱更新後必須執行 `app.relaunch()` 進行完整重啟**。
  - `setupIpcHandlers` 在註冊前必須對所有 `channels` 執行 `try { ipcMain.removeHandler(ch); }`。

### 2. 影像本地快取 (Mascot Local Caching)
- **原理**: 解決 GitHub 延遲，實現秒開。
- **實作**: 影像首開下載至 `userData/mascot_cache`，後續由 `file://` 載入。支援 Default, Blizzard, Thunder, Boulder, Sacred, Prism 六種裝束隨機切換。

### 3. 行事曆與提醒整合 (Calendar & Interaction)
- **機制**: 定時同步 iCloud 行事曆與本地待辦。
- **顯示**: 統計報表中行事曆行程 (📅) 必須置頂顯示。

---

## 🔄 系統更新機制 (Update Mechanism)

### 1. 更新頻率與觸發
- **背景巡檢**: 系統每 **15 分鐘** 會自動在背景檢查一次是否有新補丁 (Patch) 或新版本。
- **手動檢查**: 使用者可透過右鍵點擊工具列圖示，選擇 **「� 檢查更新」** 立即觸發檢查。

### 2. 更新執行流程
- **檢測與下載**: 系統偵測到版本差異後，會動態下載增量補丁。
- **強制生效**: 下載完成後，為了確保 100% 穩定，系統會執行「全程序自動重啟 (Relaunch)」。
- **版本驗證**: 重啟後，使用者可在「詳細統計報表」標題下方看到最新的版本號（如 `v1.11.24`）。

---

## �🚀 核心 UI 連結與操作流程 (UI & Workflow)

### 1. 詳細統計報表 (Stats Window)
報表視窗 (Stats Window) 是使用者與系統互動的核心區域。

#### **A. 打卡發送系統 (Check-in System)**
*   **按鈕位置**: 使用者資訊卡片下方。
*   **連結路徑**: `onclick="doCheckin()"` → 調用 `window.reminderAPI.directCheckin()`。
*   **後端對接**: 透過 `CheckinService` 發送 `action: 'direct_checkin'` 至 GAS 後端。
- **流程**: 點擊按鈕 → 鎖定按鈕防止連點 → 調用 IPC → 接收後端完成訊息 → 自動刷新統計數據。
  1. 點擊「✅ 打卡發送」按鈕。
  2. 視窗調用 `doCheckin()` 腳本。
  3. 透過橋接器發送 `direct-checkin` 請求至 `AppCore`。
  4. `CheckinService` 向 GAS 後端發送 `action: 'direct_checkin'`。
  5. 成功後，前端自動觸發 `refreshStats` 更新今日打卡時間顯示。

#### **B. 整合主控台 (Admin / Info Console)**
*   **按鈕位置**: 使用者資訊卡片右下方。
*   **連結路徑**: `onclick="window.reminderAPI.openDashboardWindow()"`。
*   **目標網址**: `https://info.tanxin.space/index.html`。
*   **行為**: 系統將透過預設瀏覽器開啟整合儀表板，提供更全面的數據視圖。

#### **C. 帳號綁定連結 (Account Binding)**
*   **觸發條件**: 當 `ConfigManager` 偵測到尚未綁定員工時自動顯示。
*   **按鈕位置**: 報表置頂卡片（取代使用者資訊）。
*   **連結路徑**: `onclick="window.reminderAPI.openLinkWindow()"`。
- **功能**: 當系統偵測到未綁定員工時，導引使用者進行身份對齊。
- **流程**:   
  1. 報表頂部顯示「⚠️ 未連結打卡帳號」警告卡片。
  2. 點擊「📲 前往綁定 (LINE)」按鈕。
  3. 系統開啟 [LINE LIFF 綁定頁面](https://liff.line.me/2007974938-jVxn6y37?source=hub)。
  4. 使用者在頁面確認員工身份。
  5. 綁定完成後，小助手將在下一次定時刷新（10分鐘）或手動「檢查更新」後自動對齊。
---

## 🛡️ 安全、隱私與權限 (Security & Privacy)

### 1. 管理員權限系統 (ACL)
- **!!! 不可變動判定基準 !!!**:
  - `PermissionLevel >= 5`：管理員等級。
  - `Group === 'BOSS'`：老闆組別。
  - `userName === '黃俊豪'`：系統擁有者。
- **行為**: 權限不足時，管理、歷史、分類等選單應完全隱藏，不得僅透過 UI 遮蓋。

### 2. 小秘書專業人格 (Professional Persona)
- **規範**: 定位為「職場秘書/PM」。嚴禁使用「主人」稱呼，台詞應隨機、專業且具備職場關懷。

### 3. 隱私紅線
- **原則**: 生產力輔助而非監控。
- **禁令**: 嚴禁截圖、按鍵記錄、內容側錄。僅記錄 App 名稱與視窗標題。

---

## 🚀 開發與部署工作流 (Workflow)

1. **版本號對齊**: `package.json` 更新後，手動更新此文件版本。
2. **自動化發布**: 推送 `v*` 標籤觸發 GitHub Actions。下載補丁後系統應自動重啟對齊。
3. **不可變動註記**: 任何涉及上述核心機制的修改，必須在 `指令記錄.md` 與 `部署記錄.md` 中詳細說明測試過程。

---
*本文件為系統最高指導原則，所有開發代理 (Agents) 必須嚴格遵守。*
