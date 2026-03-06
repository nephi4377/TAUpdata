const fs = require('fs');
const path = require('path');
const initSqlJs = require('sql.js');

// 根據環境定位資料庫
const userDataPath = path.join(process.env.APPDATA, 'tienxin-productivity-assistant');
const dbPath = path.join(userDataPath, 'productivity_data.db');

async function fix() {
    if (!fs.existsSync(dbPath)) {
        console.error(`找不到資料庫: ${dbPath}`);
        return;
    }

    const SQL = await initSqlJs();
    const fileBuffer = fs.readFileSync(dbPath);
    const db = new SQL.Database(fileBuffer);

    console.log('--- 診斷活動數據 ---');
    const today = new Date().toISOString().split('T')[0];

    // 1. 診斷超長數據
    const over24h = db.exec("SELECT count(*) FROM activities WHERE duration_seconds > 86400");
    const futureDate = db.exec("SELECT count(*) FROM activities WHERE date > '2026-12-31'");
    const longIdle = db.exec("SELECT count(*) FROM activities WHERE app_name = '閒置' AND duration_seconds > 3600");

    console.log(`單筆 > 24h 紀錄數: ${over24h[0].values[0][0]}`);
    console.log(`未來日期 紀錄數: ${futureDate[0].values[0][0]}`);
    console.log(`閒置 > 1h 紀錄數: ${longIdle[0].values[0][0]}`);

    console.log(`正在清理異常數據...`);

    // 1. 刪除單筆超過 24 小時的離譜數據
    db.run("DELETE FROM activities WHERE duration_seconds > 86400");

    // 2. 刪除未來日期的異常數據
    db.run("DELETE FROM activities WHERE date > '2026-12-31'");

    // 3. 針對「閒置」超長項目進行合理化 (超過 1 小時的通常是掛機溢出，在 v1.18.4 已修復，此處清理舊帳)
    db.run("DELETE FROM activities WHERE app_name = '閒置' AND duration_seconds > 3600");

    const data = db.export();
    fs.writeFileSync(dbPath, Buffer.from(data));
    console.log('資料庫修正與清理完成');
}

fix().catch(err => console.error(err));
