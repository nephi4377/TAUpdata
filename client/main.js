// v2.1 [IMMUTABLE_SHELL] - 2026-03-04 19:20 (Asia/Taipei)
// =============================================================================
// 【核心承重牆 - 指揮塔】此檔案屬於「不可變殼層 (Immutable Shell)」。
// 職責: 啟動生命週期、熱加載引擎引導、災難自動回退。
// 警告: 熱更新 (Hot-Update) 嚴禁修改或覆蓋此檔案，以確保更新機制與回退引擎的絕對穩定。
// =============================================================================

const { app, dialog } = require('electron');
const log = require('electron-log');
const path = require('path');
const fs = require('fs');

// [v2.2 Emergency Auto-Clean] -------------------------------------------------
// 針對 Thin Client 打包環境的自癒機制：若發現運行環境缺少 fs-extra (標配已移除項目)
// 則強制清理 app_patches 以免載入到引用該模組的舊版補丁導致啟動崩潰。
try {
    require.resolve('fs-extra');
} catch (e) {
    try {
        const userData = app.getPath('userData');
        const patchPath = path.join(userData, 'app_patches');
        const verPath = path.join(userData, 'patch_version.json');
        if (fs.existsSync(patchPath)) {
            // 使用原生 fs 同步刪除防止後續 require 命中舊補丁
            fs.rmSync(patchPath, { recursive: true, force: true });
            if (fs.existsSync(verPath)) fs.unlinkSync(verPath);
            log.warn('[Emergency] 偵測到環境缺少 fs-extra，已自動清理衝突補丁。');
        }
    } catch (err) {
        log.error('[Emergency] 清理補丁失敗:', err.message);
    }
}
// -----------------------------------------------------------------------------

const { hotReloader } = require('./src/hotReloader');
const { patchUpdater } = require('./src/updater');
const { versionService } = require('./src/versionService');

// [v1.17.7 Stability] 防死循環機制 --------------------------------------------
let launchCount = 0;
const LAUNCH_MARKER = path.join(app.getPath('userData'), '.launch_marker');

function checkLaunchStability() {
    try {
        const now = Date.now();
        if (fs.existsSync(LAUNCH_MARKER)) {
            const lastData = JSON.parse(fs.readFileSync(LAUNCH_MARKER, 'utf8'));
            // 如果 30 秒內啟動超過 3 次，判定為死循環
            if (now - lastData.time < 30000 && lastData.count >= 3) {
                return false;
            }
            launchCount = (now - lastData.time < 30000) ? lastData.count + 1 : 1;
        } else {
            launchCount = 1;
        }
        fs.writeFileSync(LAUNCH_MARKER, JSON.stringify({ time: now, count: launchCount }));
        return true;
    } catch (e) { return true; } // 若權限問題，預設放行
}
// -----------------------------------------------------------------------------

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
        // [v1.17.7 Stability] 死循環檢測
        if (!checkLaunchStability()) {
            dialog.showErrorBox('維護模式', '偵測到系統連續啟動失敗。為保護您的電腦，已暫停自動修復。請聯繫管理員進行手動重置。');
            app.quit();
            return;
        }

        // [v1.17.6] 引入版本管理與紀錄
        const versionManager = versionService;

        // 安全載入核心模組
        const coreModule = hotReloader.loadModuleSafely('appCore', './src/appCore');
        if (!coreModule || !coreModule.AppCore) {
            throw new Error("無法從本地或補丁載入 AppCore 模組，請檢查安裝完整性。");
        }
        appCore = new coreModule.AppCore(hotReloader, patchUpdater);
        // 初始化核心業務
        const success = await appCore.init();

        if (success) {
            console.log('[Launcher] 核心業務已成功啟動');

            // [v1.16.1] 暫停熱更新功能：若為本地測試或 Debug 模式，停用自動檢查
            const isDebug = appCore.services.configManager ? appCore.services.configManager.getDebugMode() : false;

            // 【偵錯】強制在啟動後彈出統計中心，確保使用者看到
            if (!app.isPackaged || isDebug) {
                console.log('[Launcher] 偵測模式：正在強制彈出統計中心...');
                setTimeout(() => {
                    if (appCore.services.monitorService) {
                        appCore.services.monitorService.showStatsWindow(appCore.services.configManager, appCore.services.reminderService, true);
                    }
                }, 2000);
            }

            if (app.isPackaged && !isDebug) {
                console.log('[Launcher] 自動更新已啟動');
                // [v2.6.403] 啟動防震：延遲 5 秒後執行首次檢查，避免與 UI 初始渲染衝突
                setTimeout(() => {
                    patchUpdater.checkForUpdates(false);
                }, 5000);

                setInterval(() => {
                    patchUpdater.checkForUpdates(false);
                }, 15 * 60 * 1000);
            } else {
                console.log('[Launcher] Debug 模式或未打包，已停用自動 Patch 檢查');
            }
        } else {
            throw new Error("AppCore 初始化返回失敗");
        }
    } catch (err) {
        console.error('[Launcher] 啟動崩潰，啟動自動回退系統...', err);

        // [v1.17.6 核心對抗] 偵測到崩潰，立即嘗試自動回退
        try {
            const versionManager = versionService;

            // [v1.17.8] 回報雲端
            await versionManager.reportHealthEvent('STARTUP_CRASH', { message: err.message, stack: err.stack });

            const rollbackSuccess = await versionManager.rollback();

            if (rollbackSuccess) {
                dialog.showMessageBoxSync({
                    type: 'warning',
                    title: '系統自動修復',
                    message: '偵測到更新版本啟動異常，已自動恢復至上一個穩定版本並重新啟動。',
                    buttons: ['確定']
                });
                app.relaunch();
            } else {
                dialog.showErrorBox('致命錯誤', `系統連環崩潰且無法回退：\n${err.message}`);
            }
        } catch (rollbackErr) {
            dialog.showErrorBox('嚴重錯誤', `啟動失敗且自動修復系統故障。\n\n錯誤代碼：BOOT_STRAP_FAILED\n詳情：${err.message}\n\n建議：請至官網下載最新安裝檔重新安裝。`);
        }
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
