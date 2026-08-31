# 專案技術上下文 (Project Technical Context)
版本：**v2.6.403**（對齊 `client/package.json`）

> [!IMPORTANT]
> **本文件定義之規範優先級最高。標註為「不可變動」之核心機制涉及系統穩定性與安全性，未經徹底測試嚴禁修改原有邏輯。**

## 🏗️ 系統架構與模組地圖 (Architecture)

本系統採 **Micro-Service at Edge** 架構，由 `AppCore` 集中調度，確保各服務解耦。

### 核心服務與職責 (Services)
- **`appCore.js` (核心大腦)**:
  - 負責模組載入、IPC 註冊、定時任務。
  - **!!! 不可變動 !!!**: `restartServices` 必須採 **強制全程序重啟 (Relaunch)** 模式，嚴禁使用軟重載以防 IPC 殘留。
- **`tray.js` (UI 門面)**: 負責圓形圖示繪製、報表生成、小秘書影像快取載入。
- **`monitor.js` (行為引擎)**: 前景視窗取樣（15 秒）。Toast 提醒採用暫存 HTML 以防渲染衝突。
- **`config.js` (設定管理)**:
  - **!!! 不可變動 !!!**: `isAdmin` 方法之判定條件（黃俊豪/BOSS/PermissionLevel >= 5）為系統權限核心，嚴禁刪除或降級。
- **`storage.js` (持久化層)**: SQLite（sql.js）驅動，變更後 **15 秒** 寫入磁碟。
- **`apiBridge.js` (後端對口，原 checkinService.js)**: 系統 **唯一 GAS 通訊出口**；打卡、報表、心跳、iCloud、知識庫同步皆經此模組。
- **`kbService.js` (知識庫)**: Phase 1 已上線——Google Sheets CSV 拉取 + 本地快照 + 統計中心搜尋（見 `08_KNOWLEDGE_BASE_SPEC.md`）。

### 與 CODING 出勤模組的關係
- 共用後端：`backend/CheckinSystem`（GAS WebApp `/exec`）。
- 前端分工：CODING `modules/attendance/*` 為 LIFF／HUB 網頁；添心為 Electron 桌面端。
- 整合路線圖：見 **`10_CODING_ATTENDANCE_INTEGRATION.md`**。

---

## 🎯 核心機制與功能定義

### 1. 靜默熱更新與自動對齊 (Modern Hot-Update)
- **原理**: 補丁背景下載完成後觸發 `appCore.restartServices()` → `app.relaunch()`。
- **!!! 不可變動 !!!**: 熱更新殼層為 `main.js`、`hotReloader.js`、`updater.js`、`versionService.js`——業務邏輯透過 patch 替換，不直接改殼層。

### 2. 影像本地快取 (Mascot Local Caching)
- 影像首開下載至 `userData/mascot_cache`，後續 `file://` 載入。

### 3. 行事曆與提醒整合 (Calendar & Interaction)
- **iCloud**: `apiBridge.syncAllIcloudReminders` 啟動 5 秒首刷 + 每 **30 分鐘** 定時同步；預設 URL 由 `AppCore` 自動套用（使用者不可點燈號修改）。
- **顯示**: 統計報表中行事曆行程 (📅) 可點擊；**iCloud 燈號僅狀態顯示，不可點擊**。

---

## 🔄 系統更新機制 (Update Mechanism)

- **背景巡檢**: 每 **15 分鐘** 檢查補丁（殼層 `updater.js`，非本文件業務模組）。
- **手動檢查**: 托盤右鍵「檢查更新」。
- **版本驗證**: 統計報表標題下方顯示 `package.json` 版本（目前 **v1.18.31**）。

---

## 🚀 核心 UI 連結與操作流程 (UI & Workflow)

### A. 打卡發送系統 (Check-in System)
- **按鈕**: 統計中心「✅ 打卡」→ `window.reminderAPI.directCheckin()`。
- **IPC**: `direct-checkin` → `AppCore` → `apiBridge.directCheckin()`。
- **GAS 路由**: GET **不帶** `page`/`action`（`skipPage=true`），參數含 `userId`、`userName`、`lat`、`lon`、`source=assistant`；對齊 `checkin.html` 預設打卡路由。
- **本地優先 (v26.03.15)**: 打卡成功後樂觀寫入本地；背景 `get_work_info` 僅在 **未打卡** 時執行；雲端空值不得覆寫本地已打卡狀態。

### B. 整合主控台 (Admin / Info Console)
- `window.reminderAPI.openDashboardWindow()` → `https://info.tanxin.space/index.html`（外部瀏覽器）。

### C. 帳號綁定 (Account Binding)
- 未綁定時顯示警告卡片 → LIFF `?source=hub` 綁定頁。
- 綁定 API：`get_employee_by_pc`、`bind_pc_to_employee`（`page=attendance_api`）。

### D. 裝修百科 (Knowledge Base)
- 統計中心「🔍」→ `reminderAPI.searchKB` → `kbService.search()`。
- 資料源：Google Sheets `KB_Suggestions`（Approved 列）+ `client/KNOWLEDGE/kb_snapshot.json` 離線快照。

---

## 🔌 CheckinSystem API 速查（添心常用）

| 用途 | 方法 | action / 路由 | 備註 |
| :--- | :--- | :--- | :--- |
| 桌機打卡 | GET | （無 action，skipPage） | `source=assistant` |
| 今日打卡狀態 | GET | `get_work_info` | `page=attendance_api` |
| PC 綁定查詢 | GET | `get_employee_by_pc` | |
| PC 綁定寫入 | POST | `bind_pc_to_employee` | |
| 員工名單快取 | GET | `get_employees` | `filter=active` |
| 生產力上報 | POST | `submit_productivity_report` | |
| 在線心跳 | POST | `update_status` | 每 5 分鐘 |
| 分類規則 | GET | `get_rules` | |

完整出勤／假勤／排班 action 對照見 `10_CODING_ATTENDANCE_INTEGRATION.md`。

---

## 🛡️ 安全、隱私與權限 (Security & Privacy)

### ACL（不可變）
- `PermissionLevel >= 5`、`Group === 'BOSS'`、`userName === '黃俊豪'` → 管理員。
- 權限不足時管理選單 **完全隱藏**（非僅遮罩）。

### 隱私紅線
- 僅記錄 App 名稱與視窗標題；嚴禁截圖、按鍵記錄、內容側錄。

### 已知待辦（需產品決策或後端配合）
- GAS API 全站 Token／Session 驗證（P0，後端）。
- API Key 遷移系統 Keychain（P1）。
- SQLite WAL 原生模組（P1，架構變更）。

---

## 🚀 開發與部署工作流 (Workflow)

1. **版本三位一體**: `package.json`、Git Tag、本文件版本欄同步更新。
2. **部署記錄**: 變更寫入 `部署記錄_添心生產力助手.md`。
3. **不可變註記**: 核心機制修改須附測試說明。

---
*本文件為系統最高指導原則，所有開發代理 (Agents) 必須嚴格遵守。*
