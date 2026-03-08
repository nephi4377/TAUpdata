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
        const initSqlJs = require('sql.js/dist/sql-asm.js');
        this.SQL = await initSqlJs();

        // 資料庫存放路徑：開發模式/Dropbox 執行時使用專案目錄 (Portable)，打包後使用系統 userData
        let DATA_DIR;
        if (app.isPackaged) {
            DATA_DIR = app.getPath('userData');
        } else {
            DATA_DIR = path.join(__dirname, '..', 'data');
            if (!fs.existsSync(DATA_DIR)) {
                fs.mkdirSync(DATA_DIR, { recursive: true });
            }
        }

        this.dbPath = path.join(DATA_DIR, 'productivity_data.db');
        console.log(`[Storage] 資料庫路徑: ${this.dbPath}`);

        // [相容邏輯] 如果是從專案目錄切換到 AppData，或者反之，且目標檔案不存在時，嘗試互相遷移
        if (!fs.existsSync(this.dbPath)) {
            try {
                // 嘗試找尋「另一個可能的位置」
                const otherDir = app.isPackaged
                    ? path.join(__dirname, '..', 'data')
                    : app.getPath('userData');
                const otherDbPath = path.join(otherDir, 'productivity_data.db');

                if (fs.existsSync(otherDbPath)) {
                    console.log(`[Storage] 發現另一個位置的資料庫，正在遷移至: ${this.dbPath}`);
                    fs.copyFileSync(otherDbPath, this.dbPath);
                    console.log('[Storage] 資料庫遷移完成');
                }
            } catch (err) {
                console.error('[Storage] 遷移資料庫失敗 (可能目錄不具備寫入權限):', err);
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

        // 個人待辦事項 (純本地，不上傳)
        this.db.run(`
      CREATE TABLE IF NOT EXISTS local_tasks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        title TEXT NOT NULL,
        status TEXT DEFAULT 'pending',
        due_date TEXT,
        due_time TEXT,
        reminder_sent INTEGER DEFAULT 0,
        category TEXT DEFAULT 'personal',
        created_at TEXT DEFAULT CURRENT_TIMESTAMP
      )
    `);

        // [v1.11.1] 資料表升級：新增進階提醒相關欄位
        const upgradeColumns = [
            { name: 'due_date', type: 'TEXT' },
            { name: 'due_time', type: 'TEXT' },
            { name: 'reminder_sent', type: 'INTEGER DEFAULT 0' },
            { name: 'reminder_lead_minutes', type: 'INTEGER DEFAULT 0' },
            { name: 'repeat_type', type: 'TEXT DEFAULT "none"' },
            { name: 'category', type: 'TEXT DEFAULT "personal"' },
            { name: 'deadline_minutes', type: 'INTEGER DEFAULT 0' },
            { name: 'priority_mode', type: 'TEXT DEFAULT "normal"' },
            { name: 'last_reminder_at', type: 'TEXT' },
            { name: 'block_reason', type: 'TEXT' }, // 困難回報原因 (JSON)
            { name: 'actual_duration', type: 'INTEGER DEFAULT 0' }, // 實際執行分鐘數
            { name: 'response_note', type: 'TEXT' }, // 最後完成/回報的心得內容
            { name: 'is_synced', type: 'INTEGER DEFAULT 0' } // 是否已同步至 GAS
        ];

        for (const col of upgradeColumns) {
            try {
                this.db.run(`ALTER TABLE local_tasks ADD COLUMN ${col.name} ${col.type}`);
                console.log(`[Storage] 成功升級 local_tasks 欄位: ${col.name}`);
            } catch (e) {
                // 欄位已存在，忽略
            }
        }

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

    /**
     * [v1.14.2] 專家級回溯重新分類
     * 當分類規則或 FFXIV 定義更新後，調用此方法修正今日已記錄之錯誤分類。
     */
    async reclassifyTodayData(classifierService) {
        if (!classifierService) return;
        const today = this.formatDate(new Date());
        console.log(`[Storage] 執行今日數據回溯重新分類 (${today})...`);

        try {
            const results = this.db.exec(`SELECT id, app_name, window_title FROM activities WHERE date = '${today}'`);
            if (results.length > 0) {
                const rows = results[0].values;
                for (const row of rows) {
                    const [id, appName, windowTitle] = row;
                    const classification = classifierService.classifyDetailed(appName, windowTitle);
                    this.db.run(`UPDATE activities SET category = ?, sub_category = ? WHERE id = ?`,
                        [classification.category, classification.subCategory, id]);
                }
                this.saveToFile();
                console.log(`[Storage] ✅ 今日數據回溯重新分類完成，共修正 ${rows.length} 筆資料。`);
            }
        } catch (e) {
            console.error('[Storage] 回溯分類失敗:', e.message);
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

    // [v1.15.6] 強制本地 ISO 日期 (YYYY-MM-DD)
    formatDate(date) {
        if (!date) date = new Date();
        const d = new Date(date);
        const year = d.getFullYear();
        const month = String(d.getMonth() + 1).padStart(2, '0');
        const day = String(d.getDate()).padStart(2, '0');
        return `${year}-${month}-${day}`;
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
    // 取得最近使用的應用程式（預設只取今日，防止溢出）
    async getRecentTopApps(days = 1) {
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
        MIN(86400, SUM(duration_seconds)) as total_seconds
      FROM activities
      WHERE date = '${today}'
      GROUP BY app_name, category
      ORDER BY total_seconds DESC
      LIMIT 12
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

    // ==========================================
    // 個人待辦事項 (Local Tasks) CRUD 功能
    // ==========================================

    // [v1.11.1] 新增本地待辦 (支援日期、時間、提前量與重複)
    addLocalTask(title, dueDate = null, due_time = null, leadMinutes = 0, repeatType = 'none', deadlineMinutes = 0, priorityMode = 'normal') {
        this.db.run(`
            INSERT INTO local_tasks (title, status, due_date, due_time, reminder_lead_minutes, repeat_type, deadline_minutes, priority_mode, reminder_sent) 
            VALUES (?, 'pending', ?, ?, ?, ?, ?, ?, 0)
        `, [title, dueDate, due_time, leadMinutes, repeatType, deadlineMinutes, priorityMode]);
        this.scheduleSave();
        return { success: true };
    }

    // [v1.11.1] 重置今日重複任務的提醒狀態
    resetRepeatingTasks(todayDate) {
        // 如果任務是每天重複，且今天不是它的首發日，或者是每週重複且今天是同一天...
        // 簡單邏輯：只要是重複任務，且 reminder_sent 為 1，就重置。
        // 但由於一分鐘掃描一次，我們需要確保不會在「同一分鐘」重複重置導致一直彈窗。
        // 所以在 ReminderService 處理重置邏輯更保險。
        this.db.run(`UPDATE local_tasks SET reminder_sent = 0 WHERE repeat_type != 'none'`);
        this.scheduleSave();
    }

    // [v1.11.0] 取得本地待辦 (按時間排序)
    getLocalTasks() {
        // [v1.11.0] 優先顯示未完成且時間接近的項目
        const results = this.db.exec(`
            SELECT * FROM local_tasks 
            ORDER BY status DESC, (CASE WHEN due_date IS NULL THEN '9999-99-99' ELSE due_date END) ASC, due_time ASC 
            LIMIT 50
        `);
        if (results.length === 0) return [];
        const columns = results[0].columns;
        return results[0].values.map(row => {
            const obj = {};
            columns.forEach((col, idx) => obj[col] = row[idx]);
            return obj;
        });
    }

    // [v1.11.0] 標記提醒已發送
    updateReminderSent(id) {
        this.db.run(`UPDATE local_tasks SET reminder_sent = 1 WHERE id = ?`, [id]);
        this.scheduleSave();
    }

    // 更新待辦事項狀態
    async updateLocalTask(id, status, title = null) {
        if (title !== null) {
            this.db.run(`UPDATE local_tasks SET status = ?, title = ? WHERE id = ?`, [status, title, id]);
        } else {
            this.db.run(`UPDATE local_tasks SET status = ? WHERE id = ?`, [status, id]);
        }
        this.scheduleSave();
    }

    // 刪除待辦事項
    async deleteLocalTask(id) {
        this.db.run(`DELETE FROM local_tasks WHERE id = ?`, [id]);
        this.scheduleSave();
    }
}

module.exports = { StorageService };
