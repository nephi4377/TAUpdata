const fs = require('fs');
const path = require('path');
const { app } = require('electron');

/**
 * =============================================================================
 * 檔案名稱: kbService.js
 * 功能: 裝修法規百科服務 - 雲端化版本 (Google Sheets 整合)
 * [v26.03.15] 實作 Google Sheets 雲端拉取與本地快照邏輯
 * [v26.03.15.1] 修復搜尋報錯問題，優化模組載入
 * =============================================================================
 */
class KnowledgeBaseService {
    constructor() {
        this.kbDir = path.join(__dirname, '..', 'KNOWLEDGE');
        this.snapshotPath = path.join(this.kbDir, 'kb_snapshot.json');
        this.articles = [];
        this.sheetUrl = 'https://docs.google.com/spreadsheets/d/1JCkkoW2F0mmZjADeYe1f1jISzWL9vrArCKZB9bn-yOQ/export?format=csv&gid=1333523823';
        
        // [v26.03.15.1] 提早載入 axios 避免在異步調用中發生路徑問題
        try {
            this.axios = require('axios');
        } catch (e) {
            console.error('[KB] Axios 載入失敗:', e.message);
        }
    }

    /**
     * 加載知識庫：優先從雲端拉取，失敗則使用本地快照
     */
    async loadKnowledgeBase() {
        try {
            console.log('[KB] 正在嘗試從雲端 (Google Sheets) 拉取最新數據...');
            if (!this.axios) this.axios = require('axios');
            
            const response = await this.axios.get(this.sheetUrl, { timeout: 10000 });
            
            if (response.data) {
                const newData = this._parseCSV(response.data);
                if (newData && newData.length > 0) {
                    this.articles = newData;
                    this._saveSnapshot();
                    console.log(`[KB] 雲端同步成功，共載入 ${this.articles.length} 條 Approved 條目。`);
                    return;
                }
            }
        } catch (error) {
            console.warn('[KB] 雲端拉取失敗，切換至本地快照模式:', error.message);
        }

        this._loadFromSnapshot();
    }

    /**
     * 解析 Google Sheets 導出的 CSV 格式 (KB_Suggestions)
     * 欄位: Status, Suggested_Keyword, Suggested_Question, Suggested_Answer
     */
    _parseCSV(csvData) {
        const lines = csvData.split(/\r?\n/);
        const results = [];
        
        // 跳過標題行
        for (let i = 1; i < lines.length; i++) {
            const line = lines[i].trim();
            if (!line) continue;

            // 簡易 CSV 解析 (考慮到引號內的逗號)
            const parts = this._splitCSV(line);
            if (parts.length < 4) continue;

            const status = parts[0].trim();
            if (status !== 'Approved') continue;

            const keywords = parts[1].replace(/"/g, '').split(/[,，]/).map(k => k.trim());
            const title = parts[2].replace(/"/g, '').trim();
            const body = parts[3].replace(/"/g, '').trim();

            results.push({ title, body, keywords });
        }
        return results;
    }

    /**
     * 處理帶引號的 CSV 分隔邏輯
     */
    _splitCSV(line) {
        const result = [];
        let cur = '';
        let inQuotes = false;
        for (let i = 0; i < line.length; i++) {
            const char = line[i];
            if (char === '"') inQuotes = !inQuotes;
            else if (char === ',' && !inQuotes) {
                result.push(cur);
                cur = '';
            } else {
                cur += char;
            }
        }
        result.push(cur);
        return result;
    }

    _saveSnapshot() {
        try {
            if (!fs.existsSync(this.kbDir)) fs.mkdirSync(this.kbDir, { recursive: true });
            fs.writeFileSync(this.snapshotPath, JSON.stringify(this.articles, null, 2), 'utf8');
        } catch (e) {
            console.error('[KB] 儲存快照失敗:', e.message);
        }
    }

    _loadFromSnapshot() {
        try {
            if (fs.existsSync(this.snapshotPath)) {
                this.articles = JSON.parse(fs.readFileSync(this.snapshotPath, 'utf8'));
                console.log(`[KB] 已從本地快照載入 ${this.articles.length} 個條目。`);
            } else {
                console.warn('[KB] 找不到本地快照，百科功能將暫時無法使用。');
            }
        } catch (e) {
            console.error('[KB] 載入快照失敗:', e.message);
        }
    }

    /**
     * 執行內容搜尋
     */
    search(query) {
        if (!query) return [];
        const q = query.toLowerCase().trim();
        return this.articles.filter(art => {
            const inTitle = art.title.toLowerCase().includes(q);
            const inBody = art.body.toLowerCase().includes(q);
            const inKeywords = art.keywords.some(k => k.toLowerCase().includes(q));
            return inTitle || inBody || inKeywords;
        }).map(art => ({
            title: art.title,
            content: art.body
        }));
    }
}

module.exports = { KnowledgeBaseService };
