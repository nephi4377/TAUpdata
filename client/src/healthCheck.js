const fs = require('fs');
const path = require('path');

// [v1.18.37] 深度防禦性載入：確保在 patches 目錄下也能正確載入母體的依賴
let log;
try {
    log = require('electron-log');
    if (!log.info) throw new Error('stub');
} catch (e) {
    try {
        const electronLogPath = require.resolve('electron-log', { paths: [process.cwd(), __dirname, path.join(process.cwd(), 'resources/app.asar/node_modules')] });
        log = require(electronLogPath);
    } catch (e2) {
        // 最低限度 Stub，避免崩潰
        log = { info: () => { }, warn: () => { }, error: () => { } };
    }
}

/**
 * [v1.14.0] 專家級啟動健康檢查 (Safe-to-Run Checker)
 */
async function runHealthCheck() {
    log.info('[Health] 啟動核心模組完整性檢查...');
    const criticalFiles = [
        'appCore.js',
        'monitor.js',
        'storage.js',
        'apiBridge.js',
        'versionService.js',
        'healthCheck.js'
    ];

    for (const f of criticalFiles) {
        const p = path.join(__dirname, f);
        log.info(`[Health] 正在檢查: ${f} (${p})`);
        if (!fs.existsSync(p)) {
            log.error(`[Health] ❌ 缺失關鍵檔案: ${f}`);
            throw new Error(`關鍵檔案缺失: ${f}`);
        }
        // 嘗試載入模組 (不執行，僅確認語法正確)
        try {
            require(p);
            log.info(`[Health] ✅ 模組 ${f} 載入成功`);
        } catch (e) {
            log.error(`[Health] ❌ 模組 ${f} 載入失敗: ${e.message}`, e.stack);
            throw new Error(`模組 ${f} 載入失敗: ${e.message}`);
        }
    }

    log.info('[Health] ✅ 所有核心模組檢查通過。');
    return true;
}

module.exports = {
    run: runHealthCheck,
    runHealthCheck
};
