// v1.5 - 2026-02-14 15:30 (Asia/Taipei)
// 修改內容: 新增 getDetailedStats 方法（按分類+應用程式彙總、未分類關鍵字收集）

const path = require('path');
const fs = require('fs');
const { app } = require('electron');

class StorageService {
    constructor() {
        this.db = null;
        this.dbPath = null;
        this.SQL = null;
        this.saveTimeout = null;
    }

    // 初始化資料庫
    async init() {
        // 動態載入 sql.js
        const initSqlJs = require('sql.js');
        this.SQL = await initSqlJs();

        // 資料庫存放路徑 (Portable Mode)
        const DATA_DIR = path.join(__dirname, '..', 'data');
        if (!fs.existsSync(DATA_DIR)) {
            fs.mkdirSync(DATA_DIR, { recursive: true });
        }
        this.dbPath = path.join(DATA_DIR, 'productivity_data.db');

        console.log(`[Storage] 資料庫路徑: ${this.dbPath}`);

        // 檢查是否需要遷移舊資料庫
        if (!fs.existsSync(this.dbPath)) {
            try {
                const oldDbPath = path.join(app.getPath('userData'), 'productivity_data.db');
                if (fs.existsSync(oldDbPath)) {
                    console.log('[Storage] 發現舊資料庫，正在遷移至 Data 目錄...');
                    fs.copyFileSync(oldDbPath, this.dbPath);
                    console.log('[Storage] 資料庫遷移完成');
                }
            } catch (err) {
                console.error('[Storage] 遷移舊資料庫失敗:', err);
            }
        }

        // 如果資料庫檔案存在，載入它
        if (fs.existsSync(this.dbPath)) {
            try {
                const fileBuffer = fs.readFileSync(this.dbPath);
                this.db = new this.SQL.Database(fileBuffer);
                console.log('[Storage] 載入現有資料庫');
            } catch (error) {
                console.error('[Storage] 載入資料庫失敗，建立新資料庫:', error.message);
                this.db = new this.SQL.Database();
            }
        } else {
            this.db = new this.SQL.Database();
            console.log('[Storage] 建立新資料庫');
        }

        // 建立資料表
        this.createTables();

        // 儲存資料庫到檔案
        this.saveToFile();

        console.log('[Storage] 資料庫初始化完成');
    }

    // 建立資料表
    createTables() {
        // 活動記錄表（新增 sub_category 欄位）
        this.db.run(`
      CREATE TABLE IF NOT EXISTS activities (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp TEXT NOT NULL,
        date TEXT NOT NULL,
        hour INTEGER NOT NULL,
        app_name TEXT NOT NULL,
        window_title TEXT,
        duration_seconds INTEGER NOT NULL,
        category TEXT DEFAULT 'other',
        sub_category TEXT,
        synced INTEGER DEFAULT 0,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP
      )
    `);

        // 嘗試新增 sub_category 欄位（如果不存在）
        try {
            this.db.run(`ALTER TABLE activities ADD COLUMN sub_category TEXT`);
        } catch (e) {
            // 欄位已存在，忽略
        }

        // 建立索引
        this.db.run(`CREATE INDEX IF NOT EXISTS idx_activities_date ON activities(date)`);
        this.db.run(`CREATE INDEX IF NOT EXISTS idx_activities_synced ON activities(synced)`);
        this.db.run(`CREATE INDEX IF NOT EXISTS idx_activities_date_hour ON activities(date, hour)`);
        this.db.run(`CREATE INDEX IF NOT EXISTS idx_activities_app ON activities(app_name)`);
        this.db.run(`CREATE INDEX IF NOT EXISTS idx_activities_category ON activities(category)`);

        // 事件記錄表（暫停/恢復等）
        this.db.run(`
      CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp TEXT NOT NULL,
        event_type TEXT NOT NULL,
        details TEXT,
        synced INTEGER DEFAULT 0,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP
      )
    `);

        console.log('[Storage] 資料表建立完成');
    }

    // 延遲儲存資料庫（避免頻繁寫入）
    scheduleSave() {
        if (this.saveTimeout) {
            clearTimeout(this.saveTimeout);
        }
        this.saveTimeout = setTimeout(() => {
            this.saveToFile();
        }, 15 * 1000); // 15 秒後儲存 (減少數據損失風險)
    }

    // 儲存資料庫到檔案
    saveToFile() {
        try {
            const data = this.db.export();
            const buffer = Buffer.from(data);
            fs.writeFileSync(this.dbPath, buffer);
            console.log('[Storage] 資料庫已儲存');
        } catch (error) {
            console.error('[Storage] 儲存資料庫失敗:', error.message);
        }
    }

    // 記錄活動
    async recordActivity({ timestamp, appName, windowTitle, durationSeconds, category, subCategory }) {
        const dateStr = this.formatDate(timestamp);
        const hour = timestamp.getHours();
        const timeStr = timestamp.toISOString();

        this.db.run(`
      INSERT INTO activities (timestamp, date, hour, app_name, window_title, duration_seconds, category, sub_category)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `, [timeStr, dateStr, hour, appName, windowTitle || '', durationSeconds, category, subCategory || null]);

        // 延遲儲存
        this.scheduleSave();
    }

    // 記錄暫停事件
    recordPauseEvent(reason, durationMinutes) {
        const details = JSON.stringify({ reason, durationMinutes });
        this.db.run(`
      INSERT INTO events (timestamp, event_type, details)
      VALUES (?, 'pause', ?)
    `, [new Date().toISOString(), details]);

        this.scheduleSave();
    }

    // 記錄恢復事件
    recordResumeEvent() {
        this.db.run(`
      INSERT INTO events (timestamp, event_type, details)
      VALUES (?, 'resume', NULL)
    `, [new Date().toISOString()]);

        this.scheduleSave();
    }

    // 取得今日統計（支援新分類）
    async getTodayStats() {
        const today = this.formatDate(new Date());

        const results = this.db.exec(`
      SELECT 
        category,
        SUM(duration_seconds) as total_seconds
      FROM activities
      WHERE date = '${today}'
      GROUP BY category
    `);

        const stats = {
            work: 0,
            leisure: 0,
            music: 0,
            idle: 0,
            lunch_break: 0,
            other: 0,
            total: 0,
            activeTotal: 0  // 不含閒置和午休的總時間
        };

        if (results.length > 0) {
            const rows = results[0].values;
            for (const row of rows) {
                const category = row[0];
                const totalSeconds = row[1];
                const minutes = Math.round(totalSeconds / 60);

                switch (category) {
                    case 'work':
                        stats.work = minutes;
                        stats.activeTotal += minutes;
                        break;
                    case 'leisure':
                        stats.leisure = minutes;
                        stats.activeTotal += minutes;
                        break;
                    case 'music':
                        stats.music = minutes;
                        stats.activeTotal += minutes;
                        break;
                    case 'idle':
                        stats.idle = minutes;
                        break;
                    case 'lunch_break':
                        stats.lunch_break = minutes;
                        break;
                    default:
                        stats.other += minutes;
                        stats.activeTotal += minutes;
                }
                stats.total += minutes;
            }
        }

        // [v2.2.8] 生產力指數公式校正
        // 有效工時 = 工作 (Work) + 其他 (Other)
        // 總活躍時間 = 工作 + 其他 + 休閒 (完全排除閒置與午休)
        // 生產力分數 = 有效工時 / 總活躍時間
        const workEfficient = stats.work + stats.other;
        const activeBase = workEfficient + stats.leisure + stats.music; // 音樂視為背景，通常歸入活躍或工作，此處併入基數
        stats.productivityRate = activeBase > 0
            ? Math.round((workEfficient / activeBase) * 100)
            : 0;

        return stats;
    }

    // [v1.6] 取得今日累計秒數 (用於重啟時恢復 MonitorService 內存變數)
    async getTodayTotalSeconds() {
        const today = this.formatDate(new Date());
        const results = this.db.exec(`
            SELECT 
                category,
                SUM(duration_seconds) as total_seconds
            FROM activities
            WHERE date = '${today}'
            GROUP BY category
        `);

        const secondsStats = {
            work: 0,
            leisure: 0,
            other: 0,
            idle: 0
        };

        if (results.length > 0) {
            const rows = results[0].values;
            for (const row of rows) {
                const category = row[0];
                const totalSeconds = row[1];

                if (category === 'work') secondsStats.work = totalSeconds;
                else if (category === 'leisure') secondsStats.leisure = totalSeconds;
                else if (category === 'idle') secondsStats.idle = totalSeconds;
                else if (category !== 'lunch_break') {
                    secondsStats.other += totalSeconds;
                }
            }
        }
        return secondsStats;
    }

    // 取得指定日期的統計（用於補傳歷史報告）
    async getStatsByDate(dateStr) {
        const results = this.db.exec(`
            SELECT 
                category,
                SUM(duration_seconds) as total_seconds
            FROM activities
            WHERE date = '${dateStr}'
            GROUP BY category
        `);

        const stats = {
            work: 0,
            leisure: 0,
            music: 0,
            idle: 0,
            lunch_break: 0,
            other: 0,
            total: 0,
            activeTotal: 0
        };

        if (results.length > 0) {
            const rows = results[0].values;
            for (const row of rows) {
                const category = row[0];
                const totalSeconds = row[1];
                const minutes = Math.round(totalSeconds / 60);

                switch (category) {
                    case 'work':
                        stats.work = minutes;
                        stats.activeTotal += minutes;
                        break;
                    case 'leisure':
                        stats.leisure = minutes;
                        stats.activeTotal += minutes;
                        break;
                    case 'music':
                        stats.music = minutes;
                        stats.activeTotal += minutes;
                        break;
                    case 'idle':
                        stats.idle = minutes;
                        break;
                    case 'lunch_break':
                        stats.lunch_break = minutes;
                        break;
                    default:
                        stats.other += minutes;
                        stats.activeTotal += minutes;
                }
                stats.total += minutes;
            }
        }

        // [v2.2.8] 生產力指數公式校正 (歷史資料亦同步公式)
        const workEfficient = stats.work + stats.other;
        const activeBase = workEfficient + stats.leisure + stats.music;
        stats.productivityRate = activeBase > 0
            ? Math.round((workEfficient / activeBase) * 100)
            : 0;

        return stats;
    }

    // 取得詳細統計（按分類+應用程式彙總，用於生產力報告）
    // 回傳: { detailText: 格式化文字, unclassifiedKeywords: 未分類關鍵字陣列 }
    async getDetailedStats(dateStr) {
        const targetDate = dateStr || this.formatDate(new Date());

        // 查詢每個應用程式的分類和使用時間
        const results = this.db.exec(`
            SELECT 
                category,
                sub_category,
                app_name,
                window_title,
                SUM(duration_seconds) as total_seconds
            FROM activities
            WHERE date = '${targetDate}'
            GROUP BY category, sub_category, app_name, window_title
            ORDER BY category, total_seconds DESC
        `);

        if (results.length === 0) {
            return { detailText: '（無資料）', unclassifiedKeywords: [] };
        }

        const rows = results[0].values;

        // 分類彙總結構：{ category: { displayName: { totalSeconds, entries } } }
        const categoryData = {};
        const unclassifiedSet = new Map(); // 網站名稱 → 累計秒數

        // 瀏覽器名稱清單（用於判斷是否為瀏覽器應用）
        const browserApps = ['chrome', 'edge', 'firefox', 'opera', 'brave', 'safari', 'msedge'];

        for (const row of rows) {
            const category = row[0] || 'other';
            const subCategory = row[1] || '';
            const appName = row[2] || '';
            const windowTitle = row[3] || '';
            const totalSeconds = row[4] || 0;

            // 跳過不足 30 秒的紀錄
            if (totalSeconds < 30) continue;

            // 判斷是否為瀏覽器
            const isBrowser = browserApps.some(b => appName.toLowerCase().includes(b));

            // 決定顯示名稱
            let displayName;
            if (isBrowser && windowTitle) {
                // 瀏覽器：提取網站名稱
                displayName = '網頁-' + this.extractSiteNameFromTitle(windowTitle);
            } else {
                // 一般應用程式：直接用應用名稱
                displayName = appName;
            }

            // 彙總到分類中
            if (!categoryData[category]) {
                categoryData[category] = {};
            }
            if (!categoryData[category][displayName]) {
                categoryData[category][displayName] = 0;
            }
            categoryData[category][displayName] += totalSeconds;

            // 收集未分類的網頁關鍵字
            if (subCategory === 'unclassified' && isBrowser) {
                const siteName = this.extractSiteNameFromTitle(windowTitle);
                if (siteName) {
                    const existing = unclassifiedSet.get(siteName) || 0;
                    unclassifiedSet.set(siteName, existing + totalSeconds);
                }
            }
        }

        // 格式化輸出文字
        const categoryLabels = {
            work: '【工作】',
            leisure: '【休閒】',
            music: '【音樂】',
            idle: '【閒置】',
            lunch_break: '【午休】',
            other: '【未分類】'
        };

        // 分類輸出順序
        const categoryOrder = ['work', 'leisure', 'music', 'other', 'idle', 'lunch_break'];
        const lines = [];

        for (const cat of categoryOrder) {
            const apps = categoryData[cat];
            if (!apps) continue;

            const label = categoryLabels[cat] || `【${cat}】`;
            lines.push(label);

            // 按時間降序排列
            const sorted = Object.entries(apps)
                .sort((a, b) => b[1] - a[1]);

            for (const [name, seconds] of sorted) {
                const timeStr = this.formatDuration(seconds);
                lines.push(`  ${name} ${timeStr}`);
            }
        }

        // 未分類關鍵字列表（附帶使用時間）
        const unclassifiedKeywords = [];
        for (const [siteName, seconds] of unclassifiedSet.entries()) {
            const timeStr = this.formatDuration(seconds);
            unclassifiedKeywords.push(`${siteName}(${timeStr})`);
        }

        return {
            detailText: lines.join('\n'),
            unclassifiedKeywords
        };
    }

    // 從瀏覽器視窗標題提取顯示名稱
    extractSiteNameFromTitle(windowTitle) {
        if (!windowTitle) return '';

        // 只移除瀏覽器名稱後綴，保留完整標題
        let cleaned = windowTitle
            .replace(/ - Google Chrome$/i, '')
            .replace(/ - Microsoft Edge$/i, '')
            .replace(/ - 個人 - Microsoft Edge$/i, '')
            .replace(/ - 工作 - Microsoft Edge$/i, '')
            .replace(/ - Firefox$/i, '')
            .replace(/ - Opera$/i, '')
            .replace(/ - Brave$/i, '')
            .trim();

        // 截取前 30 字
        if (cleaned.length > 30) {
            cleaned = cleaned.substring(0, 30) + '…';
        }

        return cleaned;
    }

    // 格式化秒數為可讀時間（例如: 3h30m, 45m, 2m）
    formatDuration(totalSeconds) {
        const totalMinutes = Math.round(totalSeconds / 60);
        if (totalMinutes < 1) return '<1m';

        const hours = Math.floor(totalMinutes / 60);
        const minutes = totalMinutes % 60;

        if (hours > 0 && minutes > 0) {
            return `${hours}h${minutes}m`;
        } else if (hours > 0) {
            return `${hours}h`;
        } else {
            return `${minutes}m`;
        }
    }

    // 取得每小時統計
    async getHourlyStats() {
        const today = this.formatDate(new Date());

        const results = this.db.exec(`
      SELECT 
        hour,
        category,
        SUM(duration_seconds) as total_seconds
      FROM activities
      WHERE date = '${today}'
      GROUP BY hour, category
      ORDER BY hour
    `);

        // 整理成每小時資料
        const hourlyData = {};

        if (results.length > 0) {
            const rows = results[0].values;
            for (const row of rows) {
                const hour = row[0];
                const category = row[1];
                const seconds = row[2];
                const minutes = Math.round(seconds / 60);

                if (!hourlyData[hour]) {
                    hourlyData[hour] = { hour, work: 0, leisure: 0, other: 0, total: 0 };
                }

                if (category === 'work') {
                    hourlyData[hour].work = minutes;
                } else if (category === 'leisure') {
                    hourlyData[hour].leisure = minutes;
                } else {
                    hourlyData[hour].other += minutes;
                }
                hourlyData[hour].total += minutes;
            }
        }

        // 轉換為陣列並計算百分比
        const hourlyArray = Object.values(hourlyData).map(h => {
            const total = h.total || 1;
            return {
                ...h,
                work_pct: Math.round((h.work / total) * 100),
                leisure_pct: Math.round((h.leisure / total) * 100),
                other_pct: Math.round((h.other / total) * 100)
            };
        });

        return hourlyArray;
    }

    // 取得瀏覽器記錄（今日）
    async getBrowserHistory() {
        const today = this.formatDate(new Date());

        // 瀏覽器應用程式名稱
        const browsers = ['chrome', 'edge', 'firefox', 'opera', 'brave', 'safari', 'msedge'];
        const browserCondition = browsers.map(b => `LOWER(app_name) LIKE '%${b}%'`).join(' OR ');

        const results = this.db.exec(`
      SELECT 
        timestamp,
        app_name,
        window_title,
        duration_seconds,
        category
      FROM activities
      WHERE date = '${today}'
        AND (${browserCondition})
        AND window_title != ''
      ORDER BY timestamp DESC
      LIMIT 50
    `);

        if (results.length === 0) {
            return [];
        }

        const columns = results[0].columns;
        const rows = results[0].values;

        // 去重並彙總（相同標題合併時間）
        const historyMap = new Map();

        for (const row of rows) {
            const title = row[2]; // window_title
            const seconds = row[3];
            const category = row[4];
            const timestamp = row[0];

            // 提取網頁標題（移除瀏覽器名稱）
            let pageTitle = title
                .replace(/ - Google Chrome$/i, '')
                .replace(/ - Microsoft Edge$/i, '')
                .replace(/ - Firefox$/i, '')
                .replace(/ - Opera$/i, '')
                .replace(/ - Brave$/i, '')
                .replace(/ - 個人 - Microsoft Edge$/i, '')
                .replace(/ - 工作 - Microsoft Edge$/i, '')
                .trim();

            if (!pageTitle) continue;

            if (historyMap.has(pageTitle)) {
                const existing = historyMap.get(pageTitle);
                existing.totalSeconds += seconds;
                existing.count++;
            } else {
                historyMap.set(pageTitle, {
                    title: pageTitle,
                    totalSeconds: seconds,
                    category: category,
                    lastVisit: timestamp,
                    count: 1
                });
            }
        }

        // 轉為陣列並按時間排序
        const history = Array.from(historyMap.values())
            .sort((a, b) => b.totalSeconds - a.totalSeconds)
            .slice(0, 20);

        return history;
    }

    // 取得最近活動記錄
    async getRecentActivities(limit = 20) {
        const today = this.formatDate(new Date());

        const results = this.db.exec(`
      SELECT 
        timestamp,
        app_name,
        window_title,
        duration_seconds,
        category
      FROM activities
      WHERE date = '${today}'
      ORDER BY timestamp DESC
      LIMIT ${limit}
    `);

        if (results.length === 0) {
            return [];
        }

        const columns = results[0].columns;
        const rows = results[0].values;

        return rows.map(row => ({
            timestamp: row[0],
            appName: row[1],
            windowTitle: row[2],
            durationSeconds: row[3],
            category: row[4]
        }));
    }

    // 取得待同步的資料（按日期小時彙總）
    async getUnsyncedData() {
        const results = this.db.exec(`
      SELECT 
        date,
        hour,
        app_name,
        window_title,
        category,
        SUM(duration_seconds) as total_seconds,
        MIN(id) as min_id,
        MAX(id) as max_id
      FROM activities
      WHERE synced = 0
      GROUP BY date, hour, app_name, category
      ORDER BY date, hour
    `);

        if (results.length === 0) {
            return [];
        }

        const columns = results[0].columns;
        const rows = results[0].values;

        return rows.map(row => {
            const obj = {};
            columns.forEach((col, idx) => {
                obj[col] = row[idx];
            });
            return obj;
        });
    }

    // 標記資料為已同步
    async markAsSynced(minId, maxId) {
        this.db.run(`UPDATE activities SET synced = 1 WHERE id >= ? AND id <= ?`, [minId, maxId]);
        this.scheduleSave();
    }

    // 取得最近使用的應用程式（前 10 名）
    async getRecentTopApps(days = 7) {
        const today = this.formatDate(new Date());

        // 如果 days = 1，只取今天
        let dateCondition = `date = '${today}'`;
        if (days > 1) {
            const startDate = new Date();
            startDate.setDate(startDate.getDate() - days);
            const startDateStr = this.formatDate(startDate);
            dateCondition = `date >= '${startDateStr}'`;
        }

        const results = this.db.exec(`
      SELECT 
        app_name,
        category,
        SUM(duration_seconds) as total_seconds
      FROM activities
      WHERE ${dateCondition}
      GROUP BY app_name
      ORDER BY total_seconds DESC
      LIMIT 10
    `);

        if (results.length === 0) {
            return [];
        }

        const columns = results[0].columns;
        const rows = results[0].values;

        return rows.map(row => {
            const obj = {};
            columns.forEach((col, idx) => {
                obj[col] = row[idx];
            });
            return obj;
        });
    }

    // 清理舊資料（保留最近 N 天）
    async cleanOldData(keepDays = 30) {
        const cutoffDate = new Date();
        cutoffDate.setDate(cutoffDate.getDate() - keepDays);
        const cutoffDateStr = this.formatDate(cutoffDate);

        this.db.run(`
      DELETE FROM activities 
      WHERE date < '${cutoffDateStr}'
      AND synced = 1
    `);

        this.saveToFile();
        console.log(`[Storage] 舊資料清理完成`);
    }

    // 格式化日期為 YYYY-MM-DD
    formatDate(date) {
        const year = date.getFullYear();
        const month = String(date.getMonth() + 1).padStart(2, '0');
        const day = String(date.getDate()).padStart(2, '0');
        return `${year}-${month}-${day}`;
    }

    // 關閉資料庫
    async close() {
        if (this.saveTimeout) {
            clearTimeout(this.saveTimeout);
        }
        if (this.db) {
            this.saveToFile();
            this.db.close();
            console.log('[Storage] 資料庫已關閉');
        }
    }
}

module.exports = { StorageService };
