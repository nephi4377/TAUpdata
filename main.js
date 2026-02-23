// v2.0 - 2026-02-23 15:50 (Asia/Taipei)
// 修改內容: 徹底簡化主程式，轉型為 Launcher Shell 架構。
// 現在 main.js 僅負責啟動生命週期與熱加載引導，業務邏輯已移至 src/appCore.js，實現 100% 業務熱更新。

const { app, dialog } = require('electron');
const log = require('electron-log');
const { hotReloader } = require('./src/hotReloader');
const { patchUpdater } = require('./src/updater');

// 1. 防止多重執行
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
    app.quit();
}

// 2. 日誌設定
log.transports.file.level = 'info';

// 3. 全域核心對象
let appCore = null;

// 4. 啟動引導
app.whenReady().then(async () => {
    console.log('[Launcher] 添心生產力助手啟動引導中...');

    try {
        // 安全載入核心模組
        const { AppCore } = hotReloader.loadModuleSafely('appCore', './src/appCore');
        appCore = new AppCore(hotReloader, patchUpdater);

        // 初始化核心業務
        const success = await appCore.init();

        if (success) {
            console.log('[Launcher] 核心業務已成功啟動');
            // 啟動定時檢查補丁 (每 15 分鐘)
            setInterval(() => {
                if (app.isPackaged) patchUpdater.checkForUpdates(false);
            }, 15 * 60 * 1000);
        }
    } catch (err) {
        console.error('[Launcher] 啟動失敗:', err);
        dialog.showErrorBox('啟動錯誤', `系統初始化崩潰：\n${err.message}`);
        app.quit();
    }
});

// 5. 監聽補丁下載完成事件 (實施軟重啟)
app.on('patch-downloaded', async () => {
    log.info('[Launcher] 檢測到新補丁，通知核心執行軟重啟...');
    if (appCore) {
        try {
            await appCore.restartServices();
        } catch (e) {
            log.error('[Launcher] 核心重啟失敗:', e);
        }
    }
});

// 6. 生命周期管理
app.on('window-all-closed', () => {
    // 常駐程式不退出
});

app.on('before-quit', async (e) => {
    console.log('[Launcher] 程式即將退出，執行資源回收...');
    if (appCore && appCore.services.storageService) {
        // 等待資料庫安全關閉
        await appCore.services.storageService.close();
    }
});
