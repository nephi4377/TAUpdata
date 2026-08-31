# 添心生產力助手：添心知識庫 (KMS) 技術規格
> 版本 v1.1 | 2026-07-04 | **Phase 1 已實作**

## 1. 核心願景
讓裝修現場的經驗（法規、施工要點）能在小助手內「秒查、秒看」。

## 2. 現況（Phase 1 — 已上線）

### 實作模組
| 元件 | 路徑 | 職責 |
| :--- | :--- | :--- |
| 服務層 | `client/src/kbService.js` | 雲端 CSV 拉取、解析、本地快照、搜尋 |
| 啟動載入 | `client/src/appCore.js` | 初始化 `KnowledgeBaseService`，背景 `loadKnowledgeBase()` |
| UI 入口 | `client/src/monitor.js` | 統計中心「🔍 裝修百科」overlay + `doKBSearch()` |
| IPC | `client/src/reminderPreload.js` | `searchKB` → `appCore` handler |
| 離線快照 | `client/KNOWLEDGE/kb_snapshot.json` | 雲端失敗時 fallback |

### 資料來源
- **Google Sheets**（公開 CSV export）
  - 試算表 ID：`1JCkkoW2F0mmZjADeYe1f1jISzWL9vrArCKZB9bn-yOQ`
  - 分頁 gid：`1333523823`（`KB_Suggestions`）
  - 欄位：`Status`, `Suggested_Keyword`, `Suggested_Question`, `Suggested_Answer`
  - 僅 `Status === 'Approved'` 進入搜尋索引

### 搜尋行為
- 關鍵字比對：標題、內文、關鍵字陣列（不分大小寫）
- 結果渲染：**HTML escape**（防 XSS）
- 逾時：雲端拉取 10 秒

## 3. 未來階段（Phase 2 / 3）

### Phase 2: 社群化編輯
- 管理員面板或 Level 3+ 撰寫介面
- 圖文上傳 → Firebase Storage / Drive
- 審核流程：`Pending` → `Approved`（沿用 Sheets 狀態欄）

### Phase 3: AI 深度整合
- 視窗標題關鍵字觸發（如「防火門」「輕隔間」）主動提示
- Gemini 檢索摘要（需後端配額與隱私審查）

## 4. 驗收標準（Phase 1 — 已達）
- [x] 啟動後背景載入知識庫，失敗不阻斷主程式
- [x] 統計中心可搜尋並展開條目
- [x] 離線時可讀上次快照
- [x] 搜尋結果經 escape，不執行 HTML 注入

---
*關聯：`PROJECT_CONTEXT.md` §D、`02_MODULE_MAP.md` apiBridge／monitor 條目*
