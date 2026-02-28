# 添心生產力助手 - 提醒系統 API 規格書 (v1.12.0)

> [!IMPORTANT]
> **維護規範 (Maintenance Rules)**
> 1. **禁止修改現有 API 結構**：本文件定義之現有 API 接口（如 `_renderReminderHtml`）已完成穩定化驗證，嚴禁直接修改其實現。
> 2. **擴充優先原則**：若需增加新功能或大幅改版 UI，應開發新的 API 方法（如 `_renderReminderHtml_v2`）並逐步替換舊調用點。
> 3. **模組化開發**：確保資料邏輯、視窗控制、視覺渲染三者解耦，減少連帶影響。

---

## 核心 API 定義

### 1. `_getMascotUrl()` - 秘書頭像定址 API
自動偵測設定並定址當前應使用的穩定線上頭像資源。

*   **功能**: 性別感知與資產定位。
*   **輸入 (Input)**: 無（讀取內部 `config` 設定）。
*   **輸出 (Output)**: `String` (URL) - 回傳穩定的 GitHub 線上圖片路徑。
    *   女版: `.../assets/secretary.png`
    *   男版: `.../assets/secretary_male.png`

### 2. `_renderReminderHtml()` - 渲染引擎 API
提供統一且像素級一致的提醒視窗 HTML/CSS 模板。

*   **功能**: UI 渲染與封裝。
*   **輸入參數 (Arguments)**:
    | 參數名 | 類型 | 描述 |
    | :--- | :--- | :--- |
    | `reminder` | `Object` | 包含 `id`, `icon`, `title`, `message` 的資料物件。 |
    | `mascotUrl` | `String` | 秘書圖片的 URL。 |
    | `snoozeLabel` | `String` | 稍後提醒按鈕的顯示文字。 |
    | `messageHtml` | `String` | 已支援 `<br>` 的訊息內容。 |
*   **輸出 (Output)**: `String` (HTML Source) - 完整的 Electron 視窗原始碼。
*   **視覺規範**:
    *   **動畫**: `slideIn` 左側滑入。
    *   **背景**: 高質感三向深色漸層。
    *   **佈局**: `flex` 結構，包含頭像區塊 (`.avatar-box`) 與文字區塊。

---

## 調用規範範例 (穩定結構)

```javascript
// 範例：如何穩定的觸發一個提醒
const mascotUrl = this._getMascotUrl();
const html = this._renderReminderHtml(reminder, mascotUrl, snoozeLabel, messageHtml);

// 寫入暫存並載入 (流程固定，不可改動)
fs.writeFileSync(tempPath, html);
this.reminderWindow.loadFile(tempPath);
```

---

## 未來擴充建議 (Modularization Strategy)

若未來需要新增「工作彙報提醒」或「系統更新公告」且其樣式與目前的「打卡提醒」差異大：
1. **建立新 API**: 在 `reminderService.js` 中新增 `_renderSystemNoticeHtml()`。
2. **獨立模板**: 在新 API 中定義專屬的 CSS 與 HTML 結構。
3. **分流執行**: 根據 `reminder.type` 決定調用哪一個渲染 API，現有的 `_renderReminderHtml` 則保持不變。

---
*文件生效日期: 2026-02-28*
*負責模組: ReminderService*
