/**
 * v2.0.12 預檢腳本: test_dependencies.js
 * 模擬熱更新環境載入，確保關鍵模組依賴無誤
 */
const path = require('path');
const fs = require('fs');

console.log('--- [預檢] 開始依賴環境模擬測試 ---');

const modulesToTest = [
    './src/healthCheck',
    './src/apiBridge',
    './src/monitor',
    './src/appCore'
];

let allPassed = true;

modulesToTest.forEach(modPath => {
    try {
        console.log(`[測試] 嘗試載入 ${modPath}...`);
        const mod = require(modPath);
        console.log(`[成功] ${modPath} 載入完成。`);
    } catch (err) {
        console.error(`[失敗] ${modPath} 崩潰:`, err.message);
        console.error(err.stack);
        allPassed = false;
    }
});

if (allPassed) {
    console.log('--- [預檢] ✅ 所有關鍵模組通過依賴檢查 ---');
    process.exit(0);
} else {
    console.error('--- [預檢] ❌ 偵測到依賴缺失，請修正後再部署 ---');
    process.exit(1);
}
