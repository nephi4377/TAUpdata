# 添心系統人員權限分級定義 (2026-02-21)

本文件詳述系統中各項功能所對應的權限等級需求，供開發與維護參考。

## 權限等級定義

| 權限等級 | 身份標籤 | 生產力小助手 | 假勤審核 (後端) | 排班確認 (後端) | 管理功能 (前端) | 備註 |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **0** | 離職 | ❌ 禁止登入 | ❌ 無權限 | ❌ 無權限 | ❌ 隱藏 | 資料保留供歷史報表回溯 |
| **1** | 廠商/臨時 | ❌ 列表隱藏 | ❌ 無權限 | ❌ 無權限 | ❌ 隱藏 | 僅用於 Web 端基本紀錄 |
| **2** | 員工 | ✅ 可選取/綁定 | ❌ 無權限 | ❌ 無權限 | ❌ 隱藏 | 標準使用者 |
| **3** | 資深員工 | ✅ 可選取/綁定 | ❌ 無權限 | ❌ 無權限 | ❌ 隱藏 | 同權限 2，保留未來擴充 |
| **4** | 主管 | ✅ 可選取/綁定 | ✅ 可審核假單 | ✅ 提交即確認 | ❌ 隱藏 | 在後端 `WebApp.gs` 具備審核跳轉權限 |
| **5** | 管理者/BOSS | ✅ 可選取/綁定 | ✅ 可審核假單 | ✅ 提交即確認 | ✅ 顯示完整選單 | 唯一可進入「分類管理」等級 |

## 代碼實作位置參考 (Traceability)

### 後端 (Google Apps Script)
1. **`WebApp.gs`**:
   - `save_schedule_version` (Line 438): `parseInt(editorPermission, 10) < 4` 判定是否進入「待審核」狀態。
   - `get_my_leave_requests`: 接收 `permission` 參數過濾假單。
2. **`EmployeeLogic.gs`**:
   - `_upsertEmployee_`: 權限變更時同步清理快取。
   - `_getEmployeeByPcName_`: 負責設備自動識別，需回傳 `permission` 供前端判定。

### 前端 (Electron Client)
1. **`tray.js`**:
   - `isAdmin` 變數：現行應修正為 `parseInt(permission) === 5`。
2. **`setupWindow.js`**:
   - `selectEmployee`: 負責將 API 傳回的權限存入本地 `config.json`。
   - **[待實作]** HTML 渲染過濾：`emp.permission >= 2` 方可顯示。
