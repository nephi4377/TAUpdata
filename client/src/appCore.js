// v1.1 - 2026-02-23 15:45 (Asia/Taipei)
// 修改內容: 完善 AppCore，遷移所有業務邏輯、IPC 處理程序與定時排程。
// 使 main.js 成為純粹的啟動殼 (Launcher Shell)。

const { app, BrowserWindow, Notification, ipcMain, shell, dialog } = require('electron');
const path = require('path');

// [v2.0.10] 深度防禦性載入：確保在 patches 目錄下也能正確載入母體的依賴
let logger;
try {
    logger = require('electron-log');
    if (!logger.info) throw new Error('stub');
} catch (e) {
    try {
        const electronLogPath = require.resolve('electron-log', { paths: [process.cwd(), __dirname, path.join(process.cwd(), 'resources/app.asar/node_modules')] });
        logger = require(electronLogPath);
    } catch (e2) {
        logger = { info: () => { }, warn: () => { }, error: () => { } };
    }
}

let autoUpdater;
try {
    autoUpdater = require('electron-updater').autoUpdater;
} catch (e) {
    logger.warn('[Core] 無法載入 electron-updater (可能在非打包環境):', e.message);
}

class AppCore {
    constructor(hotReloader, patchUpdater) {
        this.hotReloader = hotReloader;
        this.patchUpdater = patchUpdater;

        // 實作高品質 API 封裝概念
        this.services = {};
        this.timers = {};
        this.versionService = require('./versionService').versionService;
    }

    /**
     * 啟動核心服務
     */
    async init() {
        console.log('[Core] 進入 init 階段 (啟動健康檢查)...');
        try {
            const { versionService } = require('./versionService');
            const versionManager = versionService;
            // [v26.03.01] 專家級啟動保護：健康檢查與自動回退
            const healthPassed = await versionManager.validate();
            if (!healthPassed) throw new Error('啟動健康檢查不通過');
            console.log('[Core] 核心模組健康檢查通過。');
        } catch (healthErr) {
            console.error('[Core] ⚠️ 健康檢查失敗，準備回退:', healthErr.message);
            require('fs').writeFileSync('health_crash_dump.txt', healthErr.stack);
            const { versionService } = require('./versionService');
            const versionManager = versionService;
            const success = await versionManager.rollback();
            if (success) {
                console.log('[Core] 回退成功，系統重新啟動...');
                app.relaunch();
                app.exit(0);
            } else {
                logger.error('[Core] 回退徹底失敗，關閉程式。');
                dialog.showErrorBox('核心災難', '系統偵測到毀滅性損毀且無法自動回退，請聯繫管理員。');
                return false;
            }
        }

        console.log('[Core] 核心模組啟動中...');
        try {
            const ConfigManager = this.hotReloader.loadModuleSafely('config', './src/config').ConfigManager;
            const StorageService = this.hotReloader.loadModuleSafely('storage', './src/storage').StorageService;
            const ClassifierService = this.hotReloader.loadModuleSafely('classifier', './src/classifier').ClassifierService;
            const MonitorService = this.hotReloader.loadModuleSafely('monitor', './src/monitor').MonitorService;
            const TrayManager = this.hotReloader.loadModuleSafely('tray', './src/tray').TrayManager;
            const ApiBridge = this.hotReloader.loadModuleSafely('apiBridge', './src/apiBridge').ApiBridge;
            const SetupWindow = this.hotReloader.loadModuleSafely('setupWindow', './src/setupWindow').SetupWindow;
            const ReminderService = this.hotReloader.loadModuleSafely('reminderService', './src/reminderService').ReminderService;

            const ClassificationWindow = this.hotReloader.loadModuleSafely('classificationWindow', './src/classificationWindow').ClassificationWindow;
            const AdminDashboard = this.hotReloader.loadModuleSafely('adminDashboard', './src/adminDashboard').AdminDashboard;
            const { versionService } = this.hotReloader.loadModuleSafely('versionService', './src/versionService');
            const ReporterService = this.hotReloader.loadModuleSafely('reporter', './src/reporter').ReporterService;
            const FirebaseService = this.hotReloader.loadModuleSafely('firebaseService', './src/firebaseService').FirebaseService;

            // 2. 實例化並儲存服務
            this.services.configManager = new ConfigManager();
            await this.services.configManager.init();

            this.services.storageService = new StorageService();
            await this.services.storageService.init();


            this.services.classifierService = new ClassifierService(this.services.configManager);
            this.services.apiBridge = new ApiBridge(this.services.configManager);

            // [v1.14.3] 實例化完畢後執行數據回溯校準
            await this.services.storageService.reclassifyTodayData(this.services.classifierService);

            this.services.monitorService = new MonitorService(
                this.services.storageService,
                this.services.classifierService,
                this.versionService,
                this
            );
            this.services.monitorService.setApiBridge(this.services.apiBridge);
            this.services.apiBridge.setMonitorService(this.services.monitorService);

            // [v1.12.0 API] 原 taskCenter 職責已由 apiBridge 兼任
            this.services.setupWindow = new SetupWindow(this.services.configManager, this.services.apiBridge);
            this.services.classificationWindow = new ClassificationWindow(this.services.classifierService);

            this.services.reporter = new ReporterService(this.services.configManager, this.services.storageService, this.services.configManager.getPcName());
            const bound = this.services.configManager.getBoundEmployee();
            if (bound) {
                this.services.reporter.userId = bound.userId;
                this.services.reporter.userName = bound.userName;
            }

            this.services.reminderService = new ReminderService(
                this.services.configManager,
                this.services.monitorService,
                this.services.apiBridge
            );
            // [v1.17.1] 注入 reminderService 讓 monitorService 可啟動 iCloud 同步
            this.services.monitorService.setReminderService(this.services.reminderService);
            this.services.reminderService.start();
            this.services.monitorService.start();

            this.services.adminDashboard = new AdminDashboard(this.services.configManager);

            // 托盤初始化
            const setupWindowFn = (type) => this.services.setupWindow.createWindow(type);
            this.services.trayManager = new TrayManager(
                app,
                this.services.monitorService,
                this.services.storageService,
                this.services.configManager,
                this.services.apiBridge,
                setupWindowFn,
                this.services.reminderService,
                this.services.classificationWindow,
                this.services.adminDashboard
            );
            await this.services.trayManager.init();

            // [v1.17.3] 實例化 Firebase 服務 (負責即時通訊)
            this.services.firebaseService = new FirebaseService(this.services.configManager, this.services.reminderService, this.services.monitorService);
            await this.services.firebaseService.init(); // [核心修正] 呼叫 init 啟動監聽器

            await this.initializeCheckinIntegration();

            this.setupIpcHandlers();
            if (autoUpdater) this.setupAutoUpdaterListeners();

            // [v1.13.2] 極致自動化：啟動後強制同步
            console.log('[Core] 正在建立啟動首次同步任務 (Delayed 5s)...');
            setTimeout(async () => {
                if (this.services.apiBridge && this.services.reminderService) {
                    console.log('[Core] 執行首次強制同步任務...');
                    await this.services.apiBridge.syncAllIcloudReminders(this.services.reminderService);

                    // [v1.16.2] 同步完畢，立即推播更新至 UI (變更 iCloud 紅綠燈)
                    if (this.services.monitorService && this.services.monitorService.statsWindow) {
                        const data = await this.services.monitorService.getStatsData(this.services.configManager, this.services.reminderService);
                        this.services.monitorService.statsWindow.webContents.send('update-stats-data', data);
                    }
                }
            }, 5000);

            this.checkVersionNotification(versionService);
            this.applyAutoStartSettings();

            // [v1.14.0] 專家級核心定時任務：60s 自動同步全量數據與 UI
            // [v26.03.01] 核心背景同步：每 60 秒抓取雲端數據並重新渲染 UI
            this.timers.statsRefresh = setInterval(async () => {
                console.log('[Core] 執行背景自動同步 (60s)...');
                try {
                    // 1. 從雲端抓取最新打卡與工作資訊 (確保傳入當前 UserID)
                    const bound = this.services.configManager.getBoundEmployee();
                    if (bound && bound.userId) {
                        const newWi = await this.services.apiBridge.getWorkInfo(bound.userId);
                        if (newWi && newWi.success) {
                            this.handleWorkInfoUpdate(newWi.data);
                        }
                    }

                    // 2. 如果統計中心開著，推通新數據
                    if (this.services.monitorService && this.services.monitorService.statsWindow) {
                        const data = await this.services.monitorService.getStatsData(this.services.configManager, this.services.reminderService);
                        this.services.monitorService.statsWindow.webContents.send('update-stats-data', data);
                    }
                } catch (e) {
                    console.error('[Core] 背景同步失敗:', e.message);
                }
            }, 10 * 60 * 1000); // [v26.03.04] 調優：從 1min 改為 10min，降低背景負擔

            console.log('[Core] 核心初始化成功');

            if (this.services.monitorService) {
                this.services.monitorService.showStatsWindow(this.services.configManager, this.services.reminderService, false);
            }
            return true;
        } catch (err) {
            require('fs').writeFileSync('crash_dump.txt', err.stack);
            throw err;
        }
    }

    /**
     * [v1.1.2 新增] 確保 Electron 程式在開機時自動啟動
     */
    applyAutoStartSettings() {
        if (!app.isPackaged) return; // 開發環境不註冊

        const { configManager } = this.services;
        const autoStart = configManager.get('autoStart');

        try {
            app.setLoginItemSettings({
                openAtLogin: autoStart,
                path: app.getPath('exe'),
                args: ['--hidden'] // 靜默啟動
            });
            logger.info(`[Core] 開機啟動設定已更新: ${autoStart} `);
        } catch (e) {
            logger.error(`[Core] 無法設定開機啟動: ${e.message} `);
        }
    }

    /**
     * 合併原本 main.js 的打卡整合邏輯
     */
    async initializeCheckinIntegration() {
        const { apiBridge, setupWindow, configManager, storageService } = this.services;
        try {
            const initResult = await apiBridge.initializeOnStartup();

            if (initResult.needSetup) {
                const isHidden = process.argv.includes('--hidden');
                if (!isHidden) await setupWindow.show('setup');
            } else {
                this.handleWorkInfoUpdate(initResult.workInfo);
            }

            apiBridge.syncClassificationRules().then(() => {
                this.services.classifierService.loadCustomRules();
            }).catch(e => console.error(e));
            await apiBridge.checkAndSubmitYesterdayReport(storageService);

            // [v1.17.3] 啟動 Firebase 監聽
            if (this.services.firebaseService) {
                await this.services.firebaseService.init();
            }

            this.startScheduledTasks();
        } catch (e) {
            console.error('[Core] 打卡系統整合失敗:', e.message);
        }
    }

    /**
     * 處理打卡資訊更新與自動化提醒
     */
    handleWorkInfoUpdate(workInfo) {
        if (!workInfo) return;
        const today = this._getTodayStr();

        // [v26.03.04 數據防禦] 保護機制：若本地已打卡，但雲端回傳未打卡，不應直接覆寫（防止網路延遲造成空值蓋過實值）
        const configManager = this.services.configManager;
        const reminderService = this.services.reminderService;

        const currentWi = configManager.getTodayWorkInfo();
        if (currentWi && currentWi.checkedIn && !workInfo.checkedIn && currentWi.date === today) {
            console.log('[Core] 偵測到雲端打卡資訊異常為空，保留本地打卡數據以防遺失。');
            return;
        }

        const updatedInfo = { ...workInfo, date: today };
        configManager.updateWorkInfo(updatedInfo);

        // 同步 reporter 的使用者資訊（若存在）
        try {
            const bound = configManager.getBoundEmployee();
            if (bound && this.services.reporter) {
                this.services.reporter.userId = bound.userId;
                this.services.reporter.userName = bound.userName;
            }
        } catch (e) { }

        // [v26.03.04 智慧連動] 只要有打卡時間，就自動標記「打卡提醒」為完成
        const hasCheckinRecord = workInfo.checkedIn || (workInfo.checkinTime && workInfo.checkinTime !== '--:--');

        if (hasCheckinRecord && reminderService) {
            // 使用服務提供的 API 以確保觸發 UI 廣播與存檔
            reminderService.completeReminder('checkin_reminder').catch(e => { });
        }
    }

    /**
     * 排程工作
     */
    startScheduledTasks() {
        const { configManager, storageService, reminderService } = this.services;

        // 打卡資訊刷新邏輯 (v1.8.9 優化)
        // 未打卡時每 10 分鐘檢查一次，一旦打卡成功則停止今日輪詢
        // [v26.03.01] 此處邏輯已整合至 statsRefresh 定時器，故移除此重複 10min 輪詢

        // 每 15 分鐘檢查一次打卡提示與【跨天重置】
        this.timers.checkinCheck = setInterval(() => {
            const now = new Date();
            const todayStr = this._getTodayStr(); // 改用本地日期
            const wi = configManager.getTodayWorkInfo();

            // [跨天重置邏輯] v1.8.9b: 僅在日期更換且時間已過早上 7 點時重置
            if (wi && wi.date && wi.date !== todayStr && now.getHours() >= 7) {
                console.log(`[Core] 檢測到新工作日(${todayStr})，執行打卡記錄重置...`);
                configManager.setTodayWorkInfo(null);
                return;
            }

            const hour = now.getHours();
            // 如果還沒打卡，且在工作時間內 (08~18)，才發送提醒
            if (hour >= 8 && hour <= 18 && (!wi || !wi.checkedIn)) {
                const r = reminderService.reminders.find(x => x.id === 'checkin_reminder');
                // 確保 fireReminder 內有 completed 檢查
                if (r) reminderService.fireReminder(r, reminderService._formatDate(now));
            }
        }, 15 * 60 * 1000);

        // 每天 18 點後自動檢查上傳報告
        this.timers.report = setInterval(() => {
            const now = new Date();
            if (now.getMinutes() === 0) {
                this.services.apiBridge.submitTodayReport(storageService, reminderService).catch(e => console.error(e));
            }
        }, 60 * 1000);

        // 每 15 分鐘背景自動檢查一次更新 (v1.11.8+ 新增)
        this.timers.autoUpdateCheck = setInterval(() => {
            logger.info('[Core] 執行背景定時更新巡檢 (15min)...');
            this.patchUpdater.checkForUpdates(false).then(res => {
                if (!res && app.isPackaged && autoUpdater) autoUpdater.checkForUpdates();
            });
        }, 15 * 60 * 1000);

        // [v1.13.0] 專家特遣隊：iCloud 全量同步定時器 (30 分鐘)
        this.timers.icloudSync = setInterval(() => {
            console.log('[Core] 執行 30 分鐘 iCloud 雲端同步專家任務...');
            this.services.apiBridge.syncAllIcloudReminders(this.services.reminderService);
        }, 30 * 60 * 1000);

        // 初始啟動時立即同步一次 (iCloud 優先)
        setTimeout(() => {
            console.log('[Core] 初始啟動同步數據庫與雲端行程...');
            this.services.apiBridge.syncAllIcloudReminders(this.services.reminderService);
        }, 10000);

        // [v1.16.8] 專家級主動推波：每 60 秒強行刷新所有視窗數據，即使視窗在背景也能更新
        this.timers.statBroadcast = setInterval(async () => {
            try {
                const { monitorService, configManager, reminderService } = this.services;
                if (monitorService && monitorService.statsWindow && !monitorService.statsWindow.isDestroyed()) {
                    console.log('[Core] 執行每分鐘全量數據推波 (Stats Broadcast)...');
                    const data = await monitorService.getStatsData(configManager, reminderService);
                    monitorService.statsWindow.webContents.send('update-stats-data', data);
                }
            } catch (e) {
                console.error('[Core] 數據推波異常:', e.message);
            }
        }, 60000);
    }

    /**
     * 註冊 IPC 處理 (將原本 main.js 的 handlers 移入)
     */
    setupIpcHandlers() {
        // [v1.11.23] 統一清理舊的管線，防止 Attempted to register a second handler
        const channels = [
            'get-status', 'pause-monitor', 'resume-monitor', 'get-hourly-stats',
            'get-top-apps', 'open-data-folder', 'admin-login-verify',
            'fetch-team-status', 'fetch-history-data', 'open-link-window', 'open-dashboard-window',
            'get-local-tasks', 'add-local-task', 'update-local-task', 'delete-local-task',
            'get-icloud-events', 'direct-checkin', 'reminder-complete', 'reminder-undo', 'reminder-snooze'
        ];
        channels.forEach(ch => {
            try { ipcMain.removeHandler(ch); } catch (e) { }
        });

        ipcMain.removeAllListeners('admin-login-verify');
        ipcMain.removeAllListeners('fetch-team-status');
        ipcMain.removeAllListeners('fetch-history-data');
        ipcMain.removeAllListeners('refresh-stats');

        const { monitorService, storageService, configManager, apiBridge, reminderService } = this.services;

        ipcMain.handle('get-status', () => monitorService?.getStatus());
        ipcMain.handle('pause-monitor', (e, d) => monitorService?.pause(d));
        ipcMain.handle('resume-monitor', () => monitorService?.resume());
        ipcMain.handle('get-hourly-stats', () => storageService?.getHourlyStats());
        ipcMain.handle('get-top-apps', (e, d) => storageService?.getRecentTopApps(d || 7));
        ipcMain.handle('get-report-status', () => this.services.reporter?.getStatus());
        ipcMain.handle('open-data-folder', () => shell.openPath(app.getPath('userData')));
        ipcMain.handle('open-link-window', async () => {
            if (!configManager.getAutoOpenBrowser()) {
                logger.info('[Core] Auto open browser disabled for link window.');
                return { success: false, error: 'Auto open disabled' };
            }
            logger.info('[Core] 正在開啟帳號綁定頁面 (LINE LIFF)...');
            return await shell.openExternal('https://liff.line.me/2007974938-jVxn6y37?source=hub');
        });
        ipcMain.handle('open-dashboard-window', async () => {
            if (!configManager.getAutoOpenBrowser()) {
                logger.info('[Core] Auto open browser disabled for dashboard.');
                return { success: false, error: 'Auto open disabled' };
            }
            const url = 'https://info.tanxin.space/index.html';
            console.log(`[Core] 開啟整合主控台: ${url} `);
            try {
                await shell.openExternal(url);
                return { success: true };
            } catch (err) {
                console.error('[Core] 開啟外部網頁失敗:', err);
                return { success: false, error: err.message };
            }
        });

        // 個人待辦事項 IPC
        ipcMain.handle('get-local-tasks', () => storageService?.getLocalTasks());
        ipcMain.handle('add-local-task', async (e, { title, dueDate, dueTime, leadMinutes, repeatType, deadlineMinutes, priorityMode }) => {
            const res = await storageService?.addLocalTask(title, dueDate, dueTime, leadMinutes, repeatType, deadlineMinutes, priorityMode);
            if (reminderService) {
                reminderService.triggerLocalCheck();
            }
            return res;
        });
        ipcMain.handle('update-local-task', (e, { id, status, title }) => storageService?.updateLocalTask(id, status, title));

        // [v5.0] 專業交辦回饋 API 封裝實作 (由 apiBridge 兼任)
        ipcMain.handle('report-block-reason', async (e, { id, reason, duration }) => {
            if (!this.services.apiBridge) return { success: false, message: '服務未啟動' };
            return await this.services.apiBridge.reportBlocked(id, reason, duration || 0);
        });

        ipcMain.handle('update-task-response', async (e, { id, note, duration }) => {
            if (!this.services.apiBridge) return { success: false, message: '服務未啟動' };
            return await this.services.apiBridge.completeTask(id, note, duration || 0);
        });

        ipcMain.handle('delete-local-task', (e, id) => storageService?.deleteLocalTask(id));

        // [v1.16.7] 提醒控制 IPC
        ipcMain.handle('reminder-complete', (e, id) => reminderService?.completeReminder(id));
        ipcMain.handle('reminder-undo', (e, id) => reminderService?.undoReminder(id));
        ipcMain.handle('reminder-snooze', (e, id) => reminderService?.snoozeReminder(id));
        ipcMain.handle('test-reminder-fire', () => {
            if (reminderService) {
                reminderService.fireReminder({
                    id: 'test_item',
                    icon: '🧪',
                    title: '環境穩定測試',
                    message: '您好！這是自動更新後的 UI 穩定性測試。\n計時條跑完後視窗將自動消失，代表小助手守護神運作正常。'
                }, reminderService._formatDate(new Date()));
                return { success: true };
            }
            return { success: false };
        });

        // [v1.17.4] 小助手對話推送橋樑
        ipcMain.handle('mascot-msg-push', (event, { text, priority }) => {
            if (this.services.monitor && this.services.monitor.statsWindow && !this.services.monitor.statsWindow.isDestroyed()) {
                this.services.monitor.statsWindow.webContents.send('push-mascot-msg', { text, priority });
                return true;
            }
            return false;
        });

        ipcMain.handle('get-icloud-events', async () => {
            if (!reminderService) return [];
            return reminderService.reminders.filter(r => r.isIcloud);
        });

        // 打卡與統計
        ipcMain.handle('direct-checkin', async () => {
            console.log('[Core] 收到來自前端的打卡請求...');
            if (!apiBridge) return { success: false, message: '打卡服務未啟動' };
            const bound = configManager.getBoundEmployee();
            if (!bound) {
                console.warn('[Core] 打卡失敗：尚未綁定員工');
                return { success: false, message: '尚未綁定員工' };
            }
            try {
                const res = await apiBridge.directCheckin(bound.userId, bound.userName);
                console.log('[Core] 後端打卡結果:', JSON.stringify(res));
                if (res && res.success) {
                    const info = await apiBridge.getWorkInfo(bound.userId);
                    if (info.success) configManager.setTodayWorkInfo(info.data);
                }
                return res;
            } catch (err) {
                console.error('[Core] 打卡過程發生異常:', err.message);
                return { success: false, message: err.message };
            }
        });

        ipcMain.on('refresh-stats', async (event, options = {}) => {
            if (this.services.monitorService) {
                this.services.monitorService.showStatsWindow(configManager, reminderService, options && options.isManual === true);
            }
        });

        ipcMain.on('admin-login-verify', (e, p) => e.reply('admin-login-result', configManager.verifyAdminPassword(p)));
        ipcMain.on('fetch-team-status', async (e) => {
            const res = await apiBridge.get({ action: 'get_team_status' }).catch(err => ({ success: false, message: err.message }));
            e.reply('team-status-data', res);
        });
        ipcMain.on('fetch-history-data', async (e, a) => {
            console.log('[Core] 管理員請求歷史數據:', JSON.stringify(a));
            try {
                const res = await apiBridge.get({ action: 'get_productivity_history', ...a });
                if (res && res.success) {
                    const count = res.data?.daily?.length || 0;
                    console.log(`[Core] 歷史數據獲取成功, 共 ${count} 筆紀錄`);
                } else {
                    console.warn('[Core] 歷史數據獲取失敗:', res?.message);
                }
                e.reply('history-data-result', res);
            } catch (err) {
                console.error('[Core] 歷史數據請求崩潰:', err.message);
                e.reply('history-data-result', { success: false, message: err.message });
            }
        });
    }

    /**
     * 更新器監聽
     */
    setupAutoUpdaterListeners() {
        if (!autoUpdater) return;
        autoUpdater.removeAllListeners('update-available');
        autoUpdater.removeAllListeners('update-not-available');
        autoUpdater.removeAllListeners('update-downloaded');

        autoUpdater.on('update-available', (info) => {
            dialog.showMessageBox({
                type: 'info',
                title: '發現新版本',
                message: `發現新版本 v${info.version}，正在背景下載中...\n更新內容：\n${info.releaseNotes || '無版本說明'} `,
                buttons: ['確定']
            });
        });

        autoUpdater.on('update-not-available', () => {
            if (this.isManualCheck) {
                dialog.showMessageBox({ type: 'info', title: '檢查更新', message: '目前已是最新版本！', buttons: ['確定'] });
                this.isManualCheck = false;
            }
        });

        autoUpdater.on('update-downloaded', (info) => {
            logger.info(`[Updater] v${info.version} 下載完成`);
        });

        // 監聽手動更新請求
        app.removeAllListeners('check-for-updates-manual');
        app.on('check-for-updates-manual', async () => {
            this.isManualCheck = true;
            const patched = await this.patchUpdater.checkForUpdates(true);
            if (!patched && app.isPackaged && autoUpdater) autoUpdater.checkForUpdates();
        });
    }

    /**
     * 檢查是否顯示版本更新通知
     */
    checkVersionNotification(versionService) {
        const { configManager } = this.services;
        const ev = versionService.getEffectiveVersion();
        const bv = versionService.getBaseVersion();
        const last = configManager.get('lastNotifiedPatch') || '';

        if (versionService.compareVersions(ev, bv) > 0 && versionService.compareVersions(ev, last) > 0) {
            if (Notification.isSupported()) {
                new Notification({ title: '生產力助手更新完成', body: `增量補丁 v${ev} 已生效` }).show();
            }
            configManager.set('lastNotifiedPatch', ev);
        }
    }

    /**
     * 熱重啟 (v1.11.23 改為強制重啟以確保穩定性)
     */
    async restartServices() {
        logger.info('[Core] 檢測到新補丁，執行全程序重啟以套用更新...');
        this.fullRestart();
    }

    /**
     * 徹底重啟程式 (用於重大更新或修復)
     */
    fullRestart() {
        logger.info('[Core] 執行全程序重啟 (Relaunch)...');
        app.relaunch();
        app.exit(0);
    }

    /**
     * 取得本地日期字串 (YYYY-MM-DD)
     */
    _getTodayStr() {
        const now = new Date();
        const y = now.getFullYear();
        const m = String(now.getMonth() + 1).padStart(2, '0');
        const d = String(now.getDate()).padStart(2, '0');
        return `${y}-${m}-${d}`;
    }
}

module.exports = { AppCore };
