# 添心生產力助手 - 部署指南
> v1.0 - 2026-02-01 17:31 (Asia/Taipei)

## 一、後端部署 (Google Apps Script)

### 步驟 1：建立 Google Sheets

1. 前往 [Google Sheets](https://sheets.google.com)
2. 建立新的試算表，命名為「添心生產力監測資料」
3. 複製試算表 ID（網址中 `/d/` 後面那一串）
   ```
   https://docs.google.com/spreadsheets/d/【這一串就是 ID】/edit
   ```

### 步驟 2：建立 Apps Script 專案

1. 前往 [Google Apps Script](https://script.google.com)
2. 點擊「新專案」
3. 將專案命名為「添心生產力助手-後端」
4. 刪除預設的 `myFunction` 程式碼
5. 複製 `backend/Code.gs` 的全部內容貼上
6. 修改第 19 行的 `SPREADSHEET_ID`：
   ```javascript
   const SPREADSHEET_ID = '你的試算表ID';
   ```
7. （選用）修改第 22 行的 `API_KEY` 為你自訂的金鑰

### 步驟 3：初始化資料表

1. 在 Apps Script 編輯器中，選擇函式選單為 `initializeSheets`
2. 點擊「▶ 執行」
3. 首次執行會要求授權，請允許
4. 執行完成後，回到 Google Sheets 確認已建立以下資料表：
   - Raw_Logs
   - Daily_Summary
   - PC_Mapping
   - App_Categories
   - Settings

### 步驟 4：部署為網路應用程式

1. 點擊「部署」→「新增部署作業」
2. 選擇類型：「網頁應用程式」
3. 設定：
   - 說明：v1.0
   - 執行身分：我
   - 誰可以存取：**任何人**
4. 點擊「部署」
5. 複製「網頁應用程式網址」，格式類似：
   ```
   https://script.google.com/macros/s/xxxxxx/exec
   ```

---

## 二、客戶端設定

### 設定 API URL

1. 開啟客戶端設定檔：
   ```
   C:\Users\{使用者}\AppData\Roaming\tienxin-productivity-assistant\config.json
   ```

2. 修改或新增以下設定：
   ```json
   {
     "apiUrl": "https://script.google.com/macros/s/xxxxxx/exec",
     "apiKey": "tienxin-productivity-2026"
   }
   ```

3. 重新啟動客戶端程式

### 驗證連線

設定完成後，客戶端會在每小時第 5 分鐘自動上傳資料。
你可以在 Google Sheets 的 `Raw_Logs` 頁面查看是否有資料進來。

---

## 三、員工電腦安裝

### 步驟 1：複製程式

將 `client` 資料夾複製到員工電腦上。

### 步驟 2：安裝相依套件

在 `client` 資料夾中執行：
```bash
npm install
```

### 步驟 3：設定 API URL

編輯 `config.json` 或首次啟動後手動設定。

### 步驟 4：啟動程式

```bash
npm start
```

### 步驟 5：設定開機自動啟動（選用）

1. 按 `Win + R`，輸入 `shell:startup`
2. 在開啟的資料夾中，建立捷徑指向：
   ```
   C:\path\to\client\node_modules\.bin\electron.cmd C:\path\to\client
   ```

---

## 四、打包為安裝檔（進階）

如需打包成 `.exe` 安裝檔：

```bash
cd client
npm run build:win
```

打包完成後，安裝檔會在 `client/dist` 資料夾中。

---

## 五、常見問題

### Q: 資料沒有上傳？
A: 檢查以下項目：
1. `config.json` 中的 `apiUrl` 是否正確
2. Apps Script 是否已部署並設定為「任何人可存取」
3. 網路是否正常

### Q: 如何查看上傳狀態？
A: 在系統托盤圖示右鍵選單中可查看最後回報時間。

### Q: 如何手動觸發上傳？
A: 目前僅支援自動上傳（每小時）。可在程式碼中呼叫 `reporterService.reportNow()`。

---

## 六、資料說明

### Raw_Logs（原始資料）
每次上傳的詳細記錄，包含：
- 電腦名稱
- 日期/小時
- 應用程式名稱
- 視窗標題
- 使用時間（分鐘）
- 分類

### Daily_Summary（每日彙總）
每台電腦每天的彙總統計：
- 工作時間
- 休閒時間
- 其他時間
- 生產力比率

### PC_Mapping（電腦對照）
電腦名稱與員工的對照表，可手動編輯。

### App_Categories（應用程式分類）
自訂的應用程式分類規則，會同步到客戶端。
