const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const os = require('os');
const fs = require('fs');

const dbPath = path.join('d:', 'Dropbox', 'CodeBackups', '添心生產力助手', 'client', 'data', 'productivity_data.db');
const configPath = path.join('d:', 'Dropbox', 'CodeBackups', '添心生產力助手', 'client', 'data', 'tienxin-productivity-config.json');

console.log('--- 添心統計診斷工具 v1.0 ---');

// 1. 檢查資料庫
if (fs.existsSync(dbPath)) {
    const db = new sqlite3.Database(dbPath);
    const today = new Date().toISOString().split('T')[0];

    db.all("SELECT COUNT(*) as count FROM activity_logs WHERE date(timestamp/1000, 'unixepoch', 'localtime') = ?", [today], (err, rows) => {
        if (err) console.error('DB Error:', err);
        else console.log(`[Database] 今日活動記錄筆數: ${rows[0].count}`);

        db.all("SELECT app_name, duration_seconds FROM activity_logs ORDER BY id DESC LIMIT 5", (err, rows) => {
            if (rows) {
                console.log('[Database] 最近 5 筆記錄:');
                rows.forEach(r => console.log(`  - ${r.app_name} (${r.duration_seconds}s)`));
            }
            db.close();
        });
    });
} else {
    console.error(`[Database] 找不到資料庫: ${dbPath}`);
}

// 2. 檢查設定檔
if (fs.existsSync(configPath)) {
    try {
        const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        console.log(`[Config] iCloud 網址: ${config.icloudCalendarUrl ? '已設定' : '未設定'}`);
        if (config.icloudCalendarUrl) console.log(`[Config] 網址預覽: ${config.icloudCalendarUrl.substring(0, 30)}...`);
        console.log(`[Config] 今日打卡資訊: ${config.todayWorkInfo ? '有 (已打卡: ' + config.todayWorkInfo.checkedIn + ')' : '無'}`);
    } catch (e) {
        console.error('[Config] 讀取失敗:', e.message);
    }
} else {
    console.error(`[Config] 找不到設定檔: ${configPath}`);
}
