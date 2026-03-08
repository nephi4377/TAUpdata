# 添心小助手：MODULE_MAP (技術邏輯)

## 🔄 核心邏輯流程 (SOP)

### 1. 打卡流程 (據點優先、異步強一致性)
- **定位**：組別含「台南/高雄」套用固定座標；其餘採 IP 定位 (`ipapi.co`)。
- **同步**：發送 POST 後 **延遲 2.5 秒** 才執行 `refreshWorkInfo`，防止 Google Sheets 寫入延遲。
- **防禦**：若本地已有打卡紀錄，雲端回傳空值時 **不允許覆寫**。

### 2. 訊息路由 (三階反查機制)
- **L1 (專案)**：比對 `顧客列表` UID -> 獲取專案號 (如 #730) -> 轉發至該案負責人。
- **L2 (在線)**：查無專案時，執行「在線隨機分配」(權限 >= 2、10min 內有心跳、排除主管)。
- **L3 (保底)**：若無人在線，強制路由至 **Admin**。

### 3. 取樣與統計 (15s 取樣、樂觀累加)
- **Spike Protection**：取樣間隔若 > 60s (如休眠喚醒)，該次 duration 強制校準為 **15s**。
- **數據牆**：所有統計查詢執行 **1440 分鐘/24h 物理封頂**，防止異常數據溢出。

## 📁 檔案職責與 API
- **apiBridge.js**：全系統 **唯一通訊出口**。負責 GAS (/api/report)、iCloud (ICS 每 30min)、Firebase RTDB。
- **monitor.js**：前景監測 (15s)、閒置偵測、**統計視窗前端渲染**。
- **storage.js**：SQLite 事務處理，每小時自動備份。
- **firebaseService.js**：即時訊息監聽。下載訊息後立即執行 `remove()` 確保雲端 **零 Pending**。
- **hotReloader.js**：開發模式下 (`!app.isPackaged`) 強制禁用補丁載入，確保 Dropbox 修改即時生效。

## 📊 重要資料結構
- **Raw_Logs**：`timestamp`, `pc_name`, `app_name`, `window_title`, `duration_minutes`, `category`。
- **Firebase Status**：監聽 `userStatus/{UID}` 獲取秒級在線名單。
