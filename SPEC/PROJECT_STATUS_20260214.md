23-=012# 添心生產力助手 - 專案交接狀態 (2026-02-14)

這份文件是給在新電腦上的您 (或 AI 助手) 參考的，它包含了目前的專案狀態、最新的修改內容以及如何在新環境啟動的說明。

## 📍 專案狀態總覽

- **版本**: v1.6 (穩定版)
- **主要功能**: 生產力監測、打卡系統整合、智慧提醒、詳細報告
- **資料儲存**: 已遷移至 `client/data/` (可透過 Dropbox 同步)
- **環境需求**: Windows, Node.js (LTS), Dropbox

## ✅ 最新修復與優化 (2026-02-14)

1.  **資料可攜性 (Portable Data)**
    - 修改 `ConfigManager` 與 `StorageService`，將設定檔與資料庫移至專案目錄下的 `client/data/`。
    - 加入自動遷移邏輯：第一次執行時會自動從舊位置 (`%APPDATA%`) 複製資料。
    - **效益**: 換電腦時，歷史數據與設定會自動同步。

2.  **啟動流程強化 (Resilience)**
    - 將 `ReminderService` 初始化提前至主流程，不依賴 `CheckinSystem` 連線狀態。
    - 將 `startScheduledTasks` (定時排程) 移至 `finally` 區塊，確保即使啟動時網路斷線，也能自動重試連線。
    - **效益**: 解決了「提醒事項消失」與「網路不穩導致定時任務失效」的問題。

3.- [ ] **3.1: 生產力助手客戶端修復** (#3-#10)
  - [ ] **#3-A**: `monitor.js` 視窗資源洩漏修復 (Singleton)
  - [ ] **#4-A**: `reporter.js` 資料同步強化 (Persistent Queue)
  - [ ] **#5-B**: `config.js` 敏感資料加密 (AES)
  - [ ] **#6-A**: `monitor.js` 動態分類規則 (Remote Config)
  - [ ] **#7-A**: `classifier.js` 關鍵字匹配優化 (Aho-Corasick)
  - [ ] **#8-A**: `classifier.js` 標題抓取優化 (Accessibility API/Fallback)
  - [ ] **#9-A**: `reporter.js` 連線重試機制 (Exponential Backoff)
  - [ ] **#10-A**: `reminderService.js` 崩潰修復 (const -> let)
- [ ] **3.2: 新功能開發**
  - [ ] Feature: 啟動後持續檢測與未打卡提醒
  - [ ] Feature: 管理員監控面板 (Dashboard)
  - [ ] Feature: 關鍵字分類管理視窗
- [ ] **3.3: 整合測試**
    - 移除不安全的「設定」選單，保留密碼保護的「切換使用者」。
    - 修正托盤右鍵選單的「開啟整合主控台」連結，現在指向 `https://info.tanxin.space/index.html`。
    - 新增 `一鍵啟動(自動安裝).bat`，簡化新環境部署。

## 💻 新電腦啟用指南

1.  **安裝 Node.js**: 請至 [Node.js 官網](https://nodejs.org/) 下載並安裝 **LTS 版本**。
2.  **等待同步**: 確保 Dropbox 圖示顯示綠色勾勾，代表檔案已同步完成。
3.  **一鍵啟動**: 在專案根目錄下，雙擊 `一鍵啟動(自動安裝).bat`。
    - 腳本會自動檢查並安裝缺少的 `node_modules`。
    - 自動啟動應用程式。

## ⚠️ 注意事項

- **對話紀錄 (Chat History)**: 
  - IDE (如 Cursor) 的對話紀錄通常儲存在本地快取，**不會**隨 Dropbox 同步。
  - **解決方案**: 請依賴檔案內容與本文件 (`PROJECT_STATUS_20260214.md`) 作為最新的專案記憶。程式碼本身就是最準確的真相。
- **Node Modules**: 
  - `node_modules` 資料夾通常不建議同步 (檔案太多且依賴環境)。建議在新電腦重新執行 `npm install` (或使用一鍵啟動腳本)。

---
**最後更新時間**: 2026-02-14 17:55
**紀錄者**: Antigravity
