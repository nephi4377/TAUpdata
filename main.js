// v1.3 - 2026-02-14 15:55 (Asia/Taipei)
// 修改內容: 整合智慧工作提醒服務 (ReminderService)

const { app, BrowserWindow, Tray, Menu, nativeImage, dialog, ipcMain, shell } = require('electron');
const path = require('path');
const os = require('os');

const { autoUpdater } = require('electron-updater');
const log = require('electron-log');

// 設定日誌
log.transports.file.level = 'info';
autoUpdater.logger = log;

// 引入模組
const { MonitorService } = require('./src/monitor');
const { TrayManager } = require('./src/tray');
const { StorageService } = require('./src/storage');
const { ClassifierService } = require('./src/classifier');
const { ConfigManager } = require('./src/config');
const { CheckinService } = require('./src/checkinService');
const { SetupWindow } = require('./src/setupWindow');
const { ReminderService } = require('./src/reminderService');
const { ClassificationWindow } = require('./src/classificationWindow');
const { AdminDashboard } = require('./src/adminDashboard'); // [v2026.1 新增]

// 全域變數
let mainWindow = null;
let tray = null;
let monitorService = null;
let storageService = null;
let classifierService = null;
let trayManager = null;
let configManager = null;
let checkinService = null;
let setupWindow = null;
let classificationWindow = null;
let reminderService = null;
let adminDashboard = null; // [v2026.1 新增]

// 排程計時器
let workInfoRefreshTimer = null;
let reportUploadTimer = null;

// 取得電腦名稱
const PC_NAME = os.hostname();

// 防止多重執行
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
    app.quit();
}

// 設定開機自動啟動
function setupAutoLaunch() {
    // 開發環境下不啟用
    if (!app.isPackaged) return;

    const appFolder = path.dirname(process.execPath);
    const updateExe = path.resolve(appFolder, '..', 'Update.exe');
    const exeName = path.basename(process.execPath);

    app.setLoginItemSettings({
        openAtLogin: true,
        path: process.execPath,
        args: [
            '--process-start-args', `"--hidden"`
        ]
    });
}

// 應用程式準備就緒
app.whenReady().then(async () => {
    console.log(`[Main] 添心生產力助手啟動中... 電腦名稱: ${PC_NAME}`);

    try {
        // 設定開機自啟
        setupAutoLaunch();

        // 檢查更新
        if (app.isPackaged) {
            autoUpdater.checkForUpdatesAndNotify();
        }

        // 初始化設定管理
        configManager = new ConfigManager();
        await configManager.init();

        // 初始化本地儲存
        storageService = new StorageService();
        await storageService.init();

        // 初始化分類引擎
        classifierService = new ClassifierService(configManager);

        // 初始化 CheckinSystem 通訊服務 (提前初始化以供其他服務使用)
        checkinService = new CheckinService(configManager);

        // 初始化監測服務 (注入 checkinService)
        monitorService = new MonitorService(storageService, classifierService, checkinService);

        // 初始化設定視窗
        setupWindow = new SetupWindow(configManager, checkinService);

        // 初始化分類管理視窗
        classificationWindow = new ClassificationWindow(classifierService);

        // 初始化智慧工作提醒服務 (提前啟動)
        reminderService = new ReminderService(configManager, monitorService);
        reminderService.start();

        // [v2026.1 新增] 初始化管理員面板
        adminDashboard = new AdminDashboard(configManager, checkinService);

        // 初始化系統托盤（傳入 checkinService, setupWindow, reminderService, classificationWindow, adminDashboard）
        trayManager = new TrayManager(app, monitorService, storageService, configManager, checkinService, setupWindow, reminderService, classificationWindow, adminDashboard);
        await trayManager.init();

        // 啟動監測
        monitorService.start();
        // [v2026.02 移除] 停止心跳回報以減輕 GAS 後端負擔
        // monitorService.startHeartbeat(); 

        console.log('[Main] 基礎服務啟動完成');

        // ═══ CheckinSystem 整合啟動流程 ═══
        await initializeCheckinIntegration();

    } catch (error) {
        console.error('[Main] 啟動失敗:', error);
        dialog.showErrorBox('啟動錯誤', `添心生產力助手啟動失敗：\n${error.message}`);
        app.quit();
    }
});

// 自動更新事件監聽與處理
function setupAutoUpdater() {
    autoUpdater.on('error', (err) => {
        log.error('[Updater] 更新出錯:', err);
    });

    autoUpdater.on('checking-for-update', () => {
        log.info('[Updater] 正在檢查更新...');
    });

    autoUpdater.on('update-available', (info) => {
        log.info('[Updater] 發現新版本:', info.version);
        dialog.showMessageBox({
            type: 'info',
            title: '發現新版本',
            message: `發現新版本 v${info.version}，正在背景下載中...\n更新內容：\n${info.releaseNotes || '無版本說明'}`,
            buttons: ['確定']
        });
    });

    let isManualCheck = false;

    autoUpdater.on('update-not-available', () => {
        log.info('[Updater] 當前為最新版本');
        if (isManualCheck) {
            dialog.showMessageBox({
                type: 'info',
                title: '檢查更新',
                message: '目前已是最新版本！',
                buttons: ['確定']
            });
            isManualCheck = false;
        }
    });

    autoUpdater.on('update-downloaded', (info) => {
        log.info('[Updater] 更新下載完成');
        dialog.showMessageBox({
            type: 'question',
            title: '更新準備就緒',
            message: `新版本 v${info.version} 已下載完成。為了套用更新，建議立即重啟程式。\n\n是否現在更新？`,
            buttons: ['立即重啟並安裝', '下次啟動時再說'],
            defaultId: 0
        }).then((result) => {
            if (result.response === 0) {
                autoUpdater.quitAndInstall();
            }
        });
    });

    // 支援手動檢查更新
    app.on('check-for-updates-manual', () => {
        if (app.isPackaged) {
            isManualCheck = true;
            autoUpdater.checkForUpdates();
        } else {
            dialog.showMessageBox({
                type: 'info',
                title: '開發模式通知',
                message: '目前處於開發環境 (npm start)，不支援自動更新測試。請打包成安裝檔後再測試此功能。',
                buttons: ['確定']
            });
        }
    });

    // [v1.3.2] 每 15 分鐘 (0.25 小時) 背景自動檢查一次
    setInterval(() => {
        if (app.isPackaged) {
            log.info('[Updater] 執行定時計劃更新檢查...');
            autoUpdater.checkForUpdates();
        }
    }, 15 * 60 * 1000);
}

// 初始化更新器
setupAutoUpdater();

// ═══════════════════════════════════════════════════════════════
// CheckinSystem 整合初始化
// ═══════════════════════════════════════════════════════════════
async function initializeCheckinIntegration() {
    console.log('[Main] 開始 CheckinSystem 整合初始化...');

    try {
        // 步驟 1：啟動初始化（檢查綁定狀態、取得打卡資訊）
        const initResult = await checkinService.initializeOnStartup();

        if (initResult.needSetup) {
            // 需要首次設定 → 彈出設定視窗
            console.log('[Main] 需要首次設定，彈出設定視窗');
            const selectedEmployee = await setupWindow.show('setup');

            if (selectedEmployee) {
                console.log(`[Main] 首次設定完成: ${selectedEmployee.userName}`);
                // 設定完成後，重新取得打卡資訊
                const workInfo = await checkinService.refreshWorkInfo();
                handleWorkInfoUpdate(workInfo);
            } else {
                console.log('[Main] 使用者取消首次設定，將在無綁定模式下運行');
            }
        } else {
            // 已有綁定 → 處理打卡資訊
            console.log(`[Main] 已綁定員工: ${initResult.employee.userName}`);
            handleWorkInfoUpdate(initResult.workInfo);
        }

        // 步驟 1.5：同步分類規則 (非阻塞，失敗不影響後續)
        checkinService.syncClassificationRules().catch(err => console.error('[Main] 規則同步失敗:', err));

        // 步驟 2：檢查並補傳昨日報告
        await checkinService.checkAndSubmitYesterdayReport(storageService);

        console.log('[Main] CheckinSystem 整合初始化完成');

    } catch (error) {
        console.error('[Main] CheckinSystem 整合初始化失敗（不影響基本功能）:', error.message);
    } finally {
        // 步驟 3：即使初始化失敗，也要啟動定時排程 (自動恢復連線)
        startScheduledTasks();
    }
}

// 處理打卡資訊更新
function handleWorkInfoUpdate(workInfo) {
    if (!workInfo) return;
    configManager.updateWorkInfo(workInfo);
}

// 啟動定時排程任務
function startScheduledTasks() {
    // 1. 每 60 分鐘刷新打卡資訊
    if (workInfoRefreshTimer) clearInterval(workInfoRefreshTimer);
    workInfoRefreshTimer = setInterval(async () => {
        try {
            const workInfo = await checkinService.refreshWorkInfo();
            handleWorkInfoUpdate(workInfo);
        } catch (err) {
            console.error('[Main] 定時刷新打卡資訊失敗:', err.message);
        }
    }, 60 * 60 * 1000);

    // 2. [修改] 每小時 00 分自動上傳生產力報告 (支援累加模式)
    if (reportUploadTimer) clearInterval(reportUploadTimer);
    reportUploadTimer = setInterval(() => {
        const now = new Date();
        // 每小時的 00 分觸發 (允許 1 分鐘誤差)
        if (now.getMinutes() === 0) {
            console.log(`[Main] ${now.getHours()}:00 觸發每小時生產力報告上傳...`);
            checkinService.submitTodayReport(storageService, reminderService).catch(console.error);
        }
    }, 60 * 1000); // 每分鐘檢查一次

    // 3. [v2.2.8] 每 15 分鐘持續檢測打卡狀態，未打卡則提醒
    setInterval(() => {
        const workInfo = configManager.getTodayWorkInfo();
        const now = new Date();
        const hour = now.getHours();

        // 僅在工作時間 (08-18) 且未打卡時提醒
        if (hour >= 8 && hour <= 18 && (!workInfo || !workInfo.checkedIn)) {
            console.log('[Main] 持續檢測：使用者尚未打卡，觸發提醒');
            const checkinReminder = reminderService.reminders.find(r => r.id === 'checkin_reminder');
            if (checkinReminder) {
                reminderService.fireReminder(checkinReminder, reminderService._formatDate(now));
            }
        }
    }, 15 * 60 * 1000);
}

// ═══════════════════════════════════════════════════════════════
// [v2.2 Refactor] Admin IPC 處理 (集中管理)
// ═══════════════════════════════════════════════════════════════
function setupAdminIpc() {
    // 1. 管理員登入驗證
    ipcMain.on('admin-login-verify', (event, password) => {
        const isValid = configManager.verifyAdminPassword(password);
        event.reply('admin-login-result', isValid);
    });

    // 2. 取得團隊狀態 (即時監控)
    ipcMain.on('fetch-team-status', async (event) => {
        try {
            const result = await checkinService._get({ action: 'get_team_status' });
            event.reply('team-status-data', result);
        } catch (e) {
            event.reply('team-status-data', { success: false, message: e.message });
        }
    });

    // 3. 取得歷史報表
    ipcMain.on('fetch-history-data', async (event, args) => {
        try {
            const result = await checkinService._get({
                action: 'get_productivity_history',
                startDate: args.startDate,
                endDate: args.endDate,
                userId: args.userId
            });
            event.reply('history-data-result', result);
        } catch (e) {
            event.reply('history-data-result', { success: false, message: e.message });
        }
    });
}
// 在 init 後呼叫此函式
setupAdminIpc();

// ═══════════════════════════════════════════════════════════════
// IPC 通訊處理
// ═══════════════════════════════════════════════════════════════

// 取得當前狀態
ipcMain.handle('get-status', () => {
    if (monitorService) {
        return monitorService.getStatus();
    }
    return { isRunning: false, isPaused: false };
});

ipcMain.handle('pause-monitor', (event, duration) => {
    if (monitorService) {
        monitorService.pause(duration);
        return true;
    }
    return false;
});

ipcMain.handle('resume-monitor', () => {
    if (monitorService) {
        monitorService.resume();
        return true;
    }
    return false;
});

ipcMain.handle('get-hourly-stats', async () => {
    if (storageService) {
        return await storageService.getHourlyStats();
    }
    return [];
});

ipcMain.handle('get-top-apps', async (event, days) => {
    if (storageService) {
        return await storageService.getRecentTopApps(days || 7);
    }
    return [];
});

ipcMain.handle('open-data-folder', () => {
    const userDataPath = app.getPath('userData');
    shell.openPath(userDataPath);
});

// 監聽所有視窗關閉事件
// 重要：對於系統列常駐程式，必須攔截此事件以防止程式自動退出
app.on('window-all-closed', () => {
    console.log('[Main] 所有視窗已關閉，程式繼續在背景執行...');
});

// [v1.6] 程式準備退出時，確保資料存檔
app.on('before-quit', async () => {
    console.log('[Main] 程式即將退出，正在儲存數據...');

    if (monitorService) monitorService.stop();
    if (reminderService) reminderService.stop();
    if (storageService) await storageService.close();

    console.log('[Main] 數據儲存完成，安全退出');
});
