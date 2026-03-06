const { StorageService } = require('./client/src/storage.js');
const storage = new StorageService();

async function check() {
    await storage.init();
    const res = storage.db.exec("SELECT date, SUM(duration_seconds)/60 as mins FROM activities GROUP BY date ORDER BY date DESC LIMIT 5");
    console.log('--- DB DATE DISTRIBUTION ---');
    console.log(JSON.stringify(res, null, 2));
    process.exit(0);
}

check();
