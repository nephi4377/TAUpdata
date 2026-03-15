---
description: 知識庫 3.0 全自動化收割工作流 (Turbo Mode)
---

# 🚀 知識庫 Turbo 收割指令表 (v3.0)

本工作流旨在實現資料「採集、清洗、轉化、入庫」的全自動連結。

// turbo-all

1. **啟動環境檢查**
   `cd scripts/knowledge_harvester && npm install`

2. **執行全網收割機 (Harvester)**
   `node scripts/knowledge_harvester/harvester.js --turbo`
   - 目標：從 100室內設計與設計家 抓取前 50 頁專業百科條目。

3. **啟動 AI 轉化引擎 (Processor)**
   `node scripts/knowledge_harvester/processor.js`
   - 功能：自動將抓取到的 HTML/Text 透過 AI 生成問題卡片，產出 `batch_import.json`。

4. **數據預掛載 (Pre-mount)**
   `copy scripts\knowledge_harvester\output\*.json client\KNOWLEDGE\pending_review\`
   - 目的：將產出的結果送入小助手的待審核目錄。

5. **通知總監收成**
   - 小助手會彈出通知，告知總監：「AI 已產出 300 條知識，請進入管理員面板點選確認」。
