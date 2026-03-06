const fs = require('fs');
const path = require('path');

/**
 * [v1.14.0] 專家級啟動健康檢查 (Safe-to-Run Checker)
 */
async function runHealthCheck() {
    console.log('[Health] 啟動核心模組完整性檢查...');
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
        if (!fs.existsSync(p)) {
            throw new Error(`關鍵檔案缺失: ${f}`);
        }
        // 嘗試載入模組 (不執行，僅確認語法正確)
        try {
            require(p);
        } catch (e) {
            throw new Error(`模組 ${f} 載入失敗: ${e.message}`);
        }
    }

    console.log('[Health] ✅ 核心模組健康檢查通過。');
    return true;
}

module.exports = {
    run: runHealthCheck,
    runHealthCheck
};
