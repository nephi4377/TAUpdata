### 🚀 懶人包指令 (Simple Triggers)

您不需要知道檔案在哪，也不用提醒我紀錄。只要您的指令包含 **「SOP」** 或 **「自主維護」** 關鍵字，我就會自動啟動全套防護流程。

這套流程**自動包含**：
1.  🕵️ **自動偵探**：我自己去查哪裡出錯 (您不用告訴我檔案)。
2.  📝 **自動筆記**：執行指令與結果會自動寫入 `COMMAND_LOG`。
3.  🧪 **自動測試**：我會自己寫測試來驗證，FAILED 會自動重試。
4.  🚀 **自動部署**：修好並驗證後，我會自己判斷是否需要部署。

#### 範例 1：只知道現象，不知道原因 (General Bug)
> **@backend**
> 
> 請依照 **SOP** 修復：
> **現象**: 管理員面板的「平均生產力」顯示為 0%，但我看明明有打卡紀錄。
> **要求**: 請找出原因並修復。

*(說明：您只需描述現象，我會自己去 grep 程式碼、分析邏輯、寫測試、修復、直到部署完成)*

#### 範例 2：想要加新功能 (New Feature)
> **@backend**
>
> 請依照 **SOP** 新增功能：
> **目標**: 我想要一個 API 可以回傳伺服器現在的時間。
>
> *(說明：我會自動建立檔案、寫入程式、新增路由、測試連線、然後部署)*

#### 範例 3：指定具體行動 (Specific Action)
> **@backend**
>
> 請依照 **SOP** 把 `WebApp.js` 裡面的 `_getTeamStatus` 函式優化一下，加上快取。

---

## �🔄 自主維護循環 (Autonomous Maintenance SOP)
(以下為 Agent 內部的執行規範，您無需操作)

### 📌 核心原則
1.  **自動記錄**：所有關鍵指令 (測試、修復、部署) 必須寫入 `SPEC/COMMAND_LOG_202602.md`。
2.  **部署留痕**：所有後端部署必須寫入 `SPEC/DEPLOYMENT_LOG.md`。
3.  **安全部署**：部署前必須確保沒有 Node.js 腳本混入 GAS 專案 (使用 `.claspignore` 或清理腳本)。

### 🛠️ 自動化工具 (DevOps Tools)
即位於 `backend/CheckinSystem_DevOps/` 目錄下的輔助腳本：

1.  **執行並記錄** (`run_and_log.js`)
    *   用途：執行任意指令並自動記錄結果。
    *   指令：`node backend/CheckinSystem_DevOps/run_and_log.js "<command>" "<description>"`
    *   範例：`node backend/CheckinSystem_DevOps/run_and_log.js "npm test" "驗證修復結果"`

2.  **智慧部署** (`smart_deploy.js`)
    *   用途：一鍵完成 Push -> Deploy -> Update Config -> Log。
    *   指令：`node backend/CheckinSystem_DevOps/smart_deploy.js "<Deployment Description>"`
    *   範例：`node000000000 backend/CheckinSystem_DevOps/smart_deploy.js "Fix reporting bug v2.3"`

### 📋 標準作業流程 (Execute Loop)

當收到「修復 Bug」或「開發功能」指令時，請依此循環操作：

1.  **分析 (Analyze)**
    *   使用 `grep`, `view_file` 找出問題。
    *   記錄發現於 `COMMAND_LOG` (可手動記錄或使用工具)。

2.  **測試 (Test)**
    *   建立或執行重現腳本。
    *   使用 `run_and_log.js` 執行測試，留下失敗紀錄。

3.  **修復 (Fix)**
    *   修改程式碼。

4.  **驗證 (Verify)**
    *   再次使用 `run_and_log.js` 執行測試，直到成功。

5.  **部署 (Deploy)**
    *   確認驗證通過後，使用 `smart_deploy.js` 進行部署。
    *   此腳本會自動更新 Client Config 並記錄 Deployment Log。

---

## 🛠️ 情境一：修復錯誤 (Fix & Debug)
當您遇到報錯，希望 AI 自動查修直到通過為止。

**複製以下指令：**
> **@backend** (或指定相關資料夾)
>
> 任務目標：修復 `[描述錯誤現象或貼上錯誤訊息]`
>
> 請依照以下步驟自動執行：
> 1. **分析**：檢視 `[相關檔案路徑]`，找出錯誤根源。
> 2. **修復**：直接修改程式碼，不需要詢問我。
> 3. **驗證**：建立或執行測試腳本 `[測試腳本路徑]`。
> 4. **循環**：若測試失敗，請自動分析原因並修正，直到測試通過或失敗超過 3 次為止。
>
如果是小助手最終完成後記得重啟.
> **(Permission: Auto-fix enabled. Proceed autonomously until verification passes.)**

---

## 🧹 情境二：重構程式碼 (Refactor)
當您覺得某個檔案太亂，希望 AI 整理代碼結構。

**複製以下指令：**
> **@backend** (或指定相關資料夾)
>
> 任務目標：重構 `[目標檔案路徑]`
>
> 重構要求：
> 1. **拆解函式**：將過長的函式拆分為多個小函式。
> 2. **優化命名**：確保變數與函式名稱符合 `[您的命名規範，如 CamelCase]`。
> 3. **保持相容**：確保輸入/輸出介面不變，不影響外部呼叫。
> 4. **驗證**：每完成一個階段，請執行測試確保功能正常。
>
> **(Permission: Proceed autonomously. Stop only if you encounter critical logic conflicts.)**

---

## ✨ 情境三：開發新功能 (New Feature)
當您希望 AI 從零開始實作一個功能。

**複製以下指令：**
> **@backend** (或指定相關資料夾)
>
> 任務目標：新增功能 `[功能名稱]`
>
> 需求規格：
> 1. **輸入**：`[描述輸入參數]`
> 2. **處理**：`[描述業務邏輯]`
> 3. **輸出**：`[描述預期結果]`
> 4. **檔案位置**：請在 `[目標資料夾]` 建立新檔案。
>
> 執行步驟：
> 1. 先建立測試腳本定義預期行為。
> 2. 實作功能代碼。
> 3. 執行測試並修正，直到通過。
> 4. 最後回報「已完成」並提供檔案路徑。
>
> **(Permission: Auto-proceed until verification is complete.)**

---

## ⚡ 情境四：效能優化 (Optimization)
當某個功能跑太慢，希望 AI 優化。

**複製以下指令：**
> **@backend** (或指定相關資料夾)
>
> 任務目標：優化 `[目標檔案或函式]` 的效能
>
> 優化方向：
> 1. **減少 I/O**：使用 Batch 讀寫或 Cache 機制。
> 2. **演算法優化**：減少迴圈複雜度。
> 3. **限制**：優化後的行為必須與原本一致，不能改變業務邏輯。
>
> **(Permission: Optimize autonomously. Verify with benchmarks.)**

---

## 🛑 自動化煞車機制 (Stop Conditions)
即便下達了上述指令，AI 若遇到以下狀況會**自動停止並回報**，請放心：

1.  **破壞性操作**：需要刪除大量檔案或關鍵目錄。
2.  **死循環**：同一錯誤連續修正失敗超過 3 次。
3.  **敏感資訊**：偵測到金鑰或密碼外洩風險。
4.  **範圍蔓延**：發現問題根源超出原定檔案範圍。
