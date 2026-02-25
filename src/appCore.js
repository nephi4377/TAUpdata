// v1.1 - 2026-02-23 15:45 (Asia/Taipei)
// 修改內容: 完善 AppCore，遷移所有業務邏輯、IPC 處理程序與定時排程。
// 使 main.js 成為純粹的啟動殼 (Launcher Shell)。

const { app, BrowserWindow, Notification, ipcMain, shell, dialog } = require('electron');
const path = require('path');
const log = require('electron-log');
const { autoUpdater } = require('electron-updater');

class AppCore {
    constructor(hotReloader, patchUpdater) {
        this.hotReloader = hotReloader;
        this.patchUpdater = patchUpdater;

        this.services = {};
        this.timers = {};
        this.isManualCheck = false;
    }

    /**
     * 啟動核心服務
     */
    async init() {
        console.log('[Core] 核心模組啟動中...');

        try {
            // 1. 動態載入所有模組 (優先使用補丁)
            const ConfigManager = this.hotReloader.loadModuleSafely('config', './src/config').ConfigManager;
            const StorageService = this.hotReloader.loadModuleSafely('storage', './src/storage').StorageService;
            const ClassifierService = this.hotReloader.loadModuleSafely('classifier', './src/classifier').ClassifierService;
            const MonitorService = this.hotReloader.loadModuleSafely('monitor', './src/monitor').MonitorService;
            const TrayManager = this.hotReloader.loadModuleSafely('tray', './src/tray').TrayManager;
            const CheckinService = this.hotReloader.loadModuleSafely('checkinService', './src/checkinService').CheckinService;
            const SetupWindow = this.hotReloader.loadModuleSafely('setupWindow', './src/setupWindow').SetupWindow;
            const ReminderService = this.hotReloader.loadModuleSafely('reminderService', './src/reminderService').ReminderService;
            const ClassificationWindow = this.hotReloader.loadModuleSafely('classificationWindow', './src/classificationWindow').ClassificationWindow;
            const AdminDashboard = this.hotReloader.loadModuleSafely('adminDashboard', './src/adminDashboard').AdminDashboard;
            const { versionService } = this.hotReloader.loadModuleSafely('versionService', './src/versionService');

            // 2. 實例化並儲存服務
            this.services.configManager = new ConfigManager();
            await this.services.configManager.init();

            this.services.storageService = new StorageService();
            await this.services.storageService.init();

            this.services.classifierService = new ClassifierService(this.services.configManager);
            // ClassifierService 在 constructor 已完成加載，無需 init()

            this.services.checkinService = new CheckinService(this.services.configManager);

            this.services.monitorService = new MonitorService(
                this.services.storageService,
                this.services.classifierService
            );

            this.services.setupWindow = new SetupWindow(this.services.configManager, this.services.checkinService);
            this.services.classificationWindow = new ClassificationWindow(this.services.classifierService);

            this.services.reminderService = new ReminderService(this.services.configManager, this.services.monitorService);
            this.services.reminderService.start();

            this.services.adminDashboard = new AdminDashboard(this.services.configManager);

            // 3. 托盤初始化
            const setupWindowFn = (type) => this.services.setupWindow.createWindow(type);
            this.services.trayManager = new TrayManager(
                app,
                this.services.monitorService,
                this.services.storageService,
                this.services.configManager,
                this.services.checkinService,
                setupWindowFn,
                this.services.reminderService,
                this.services.classificationWindow,
                this.services.adminDashboard
            );
            await this.services.trayManager.init();

            // 4. 打卡整合系統啟動 (原本 main.js 的 initializeCheckinIntegration)
            await this.initializeCheckinIntegration();

            // 5. 註冊所有 IPC 與 更新器監聽
            this.setupIpcHandlers();
            this.setupAutoUpdaterListeners();

            // 6. 啟動監測
            this.services.monitorService.start();

            // 7. 最後檢查一次版本通知
            this.checkVersionNotification(versionService);

            // 8. 確保開機啟動設定已註冊
            this.applyAutoStartSettings();

            console.log('[Core] 核心初始化成功');
            return true;
        } catch (err) {
            console.error('[Core] 初始化失敗:', err);
            dialog.showErrorBox('核心錯誤', `添心生產力助手核心模組載入失敗：\n${err.message}`);
            return false;
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
            log.info(`[Core] 開機啟動設定已更新: ${autoStart}`);
        } catch (e) {
            log.error(`[Core] 無法設定開機啟動: ${e.message}`);
        }
    }

    /**
     * 合併原本 main.js 的打卡整合邏輯
     */
    async initializeCheckinIntegration() {
        const { checkinService, setupWindow, configManager, storageService } = this.services;
        try {
            const initResult = await checkinService.initializeOnStartup();
            if (initResult.needSetup) {
                const isHidden = process.argv.includes('--hidden');
                if (!isHidden) await setupWindow.show('setup');
            } else {
                this.handleWorkInfoUpdate(initResult.workInfo);
            }
            checkinService.syncClassificationRules().catch(e => console.error(e));
            await checkinService.checkAndSubmitYesterdayReport(storageService);
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
        const { configManager, reminderService } = this.services;
        const today = new Date().toISOString().split('T')[0];
        const updatedInfo = { ...workInfo, date: today };
        configManager.updateWorkInfo(updatedInfo);

        if (workInfo.checkedIn && reminderService?.todayStatus) {
            const tr = reminderService.todayStatus['checkin_reminder'];
            if (!tr || tr.status !== 'completed') {
                reminderService.todayStatus['checkin_reminder'] = {
                    status: 'completed',
                    completedAt: new Date().toISOString(),
                    autoCompleted: true
                };
                reminderService._saveTodayStatus();
                if (reminderService.reminderWindow && !reminderService.reminderWindow.isDestroyed()) {
                    reminderService.reminderWindow.close();
                }
            }
        }
    }

    /**
     * 排程工作
     */
    startScheduledTasks() {
        const { checkinService, configManager, storageService, reminderService } = this.services;

        // 打卡資訊刷新邏輯 (v1.8.9 優化)
        // 未打卡時每 10 分鐘檢查一次，一旦打卡成功則停止今日輪詢
        this.timers.refresh = setInterval(async () => {
            const wi = configManager.getTodayWorkInfo();
            const now = new Date();
            const hour = now.getHours();

            // 如果本地已經記錄「今日已打卡」，或者還沒到早上 7 點 (跨日加班期)，不發送請求
            if ((wi && wi.checkedIn) || hour < 7) {
                return;
            }

            try {
                // console.log('[Core] 尚未偵測到打卡，進行 10 分鐘例行檢查...');
                const newWi = await checkinService.refreshWorkInfo();
                this.handleWorkInfoUpdate(newWi);
            } catch (e) { }
        }, 10 * 60 * 1000); // 10 分鐘一次

        // 每 15 分鐘檢查一次打卡提示與【跨天重置】
        this.timers.checkinCheck = setInterval(() => {
            const now = new Date();
            const todayStr = now.toISOString().split('T')[0];
            const wi = configManager.getTodayWorkInfo();

            // [跨天重置邏輯] v1.8.9b: 僅在日期更換且時間已過早上 7 點時重置
            if (wi && wi.date && wi.date !== todayStr && now.getHours() >= 7) {
                console.log(`[Core] 檢測到新工作日 (${todayStr})，執行打卡記錄重置...`);
                configManager.setTodayWorkInfo(null);
                return;
            }

            const hour = now.getHours();
            if (hour >= 8 && hour <= 18 && (!wi || !wi.checkedIn)) {
                const r = reminderService.reminders.find(x => x.id === 'checkin_reminder');
                if (r) reminderService.fireReminder(r, reminderService._formatDate(now));
            }
        }, 15 * 60 * 1000);

        // 每天 18 點後自動檢查上傳報告
        this.timers.report = setInterval(() => {
            const now = new Date();
            if (now.getMinutes() === 0) {
                checkinService.submitTodayReport(storageService, reminderService).catch(e => console.error(e));
            }
        }, 60 * 1000);
    }

    /**
     * 註冊 IPC 處理 (將原本 main.js 的 handlers 移入)
     */
    setupIpcHandlers() {
        // 清除舊的才能重新註冊 (熱更新必備)
        const channels = [
            'get-status', 'pause-monitor', 'resume-monitor', 'get-hourly-stats',
            'get-top-apps', 'open-data-folder', 'admin-login-verify',
            'fetch-team-status', 'fetch-history-data'
        ];
        channels.forEach(ch => ipcMain.removeHandler(ch));
        ipcMain.removeAllListeners('admin-login-verify');
        ipcMain.removeAllListeners('fetch-team-status');
        ipcMain.removeAllListeners('fetch-history-data');

        const { monitorService, storageService, configManager, checkinService } = this.services;

        ipcMain.handle('get-status', () => monitorService?.getStatus());
        ipcMain.handle('pause-monitor', (e, d) => monitorService?.pause(d));
        ipcMain.handle('resume-monitor', () => monitorService?.resume());
        ipcMain.handle('get-hourly-stats', () => storageService?.getHourlyStats());
        ipcMain.handle('get-top-apps', (e, d) => storageService?.getRecentTopApps(d || 7));
        ipcMain.handle('open-data-folder', () => shell.openPath(app.getPath('userData')));

        ipcMain.on('admin-login-verify', (e, p) => e.reply('admin-login-result', configManager.verifyAdminPassword(p)));
        ipcMain.on('fetch-team-status', async (e) => {
            const res = await checkinService._get({ action: 'get_team_status' }).catch(err => ({ success: false, message: err.message }));
            e.reply('team-status-data', res);
        });
        ipcMain.on('fetch-history-data', async (e, a) => {
            console.log('[Core] 管理員請求歷史數據:', JSON.stringify(a));
            try {
                const res = await checkinService._get({ action: 'get_productivity_history', ...a });
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
        autoUpdater.removeAllListeners('update-available');
        autoUpdater.removeAllListeners('update-not-available');
        autoUpdater.removeAllListeners('update-downloaded');

        autoUpdater.on('update-available', (info) => {
            dialog.showMessageBox({
                type: 'info',
                title: '發現新版本',
                message: `發現新版本 v${info.version}，正在背景下載中...\n更新內容：\n${info.releaseNotes || '無版本說明'}`,
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
            log.info(`[Updater] v${info.version} 下載完成`);
        });

        // 監聽手動更新請求
        app.removeAllListeners('check-for-updates-manual');
        app.on('check-for-updates-manual', async () => {
            this.isManualCheck = true;
            const patched = await this.patchUpdater.checkForUpdates(true);
            if (!patched && app.isPackaged) autoUpdater.checkForUpdates();
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
     * 熱重啟
     */
    async restartServices() {
        log.info('[Core] 準備執行熱重啟...');

        // [v1.8.9b Safety] 防自殺補丁：暫時攔截退出指令，防止舊版 destroy() 時誤殺進程
        const originalProcessExit = process.exit;
        const originalAppExit = app.exit;
        const originalAppQuit = app.quit;
        process.exit = () => { log.warn('[Core] 攔截到熱重啟期間的 process.exit() 請求'); };
        app.exit = () => { log.warn('[Core] 攔截到熱重啟期間的 app.exit() 請求'); };
        app.quit = () => { log.warn('[Core] 攔截到熱重啟期間的 app.quit() 請求'); };

        try {
            // 1. 停止服務
            if (this.services.monitorService) this.services.monitorService.stop();
            if (this.services.reminderService) this.services.reminderService.stop();
            if (this.services.storageService) await this.services.storageService.close();

            // 2. 清除計時器
            for (const k in this.timers) clearInterval(this.timers[k]);
            this.timers = {};

            // 3. 銷毀 UI
            if (this.services.trayManager) {
                try {
                    this.services.trayManager.destroy();
                } catch (e) {
                    log.error('[Core] 托盤銷毀出錯 (不影響重啟):', e);
                }
            }

            // 4. 重啟初始化
            const success = await this.init();

            // [v1.8.9b Safety] 恢復原始退出指令
            process.exit = originalProcessExit;
            app.exit = originalAppExit;
            app.quit = originalAppQuit;

            return success;
        } catch (err) {
            log.error('[Core] 熱重啟失敗:', err);
            // 失敗時還是要恢復，否則程式會無法關閉
            process.exit = originalProcessExit;
            app.exit = originalAppExit;
            app.quit = originalAppQuit;
            return false;
        }
    }

    /**
     * 徹底重啟程式 (用於重大更新或修復)
     */
    fullRestart() {
        log.info('[Core] 執行全程序重啟 (Relaunch)...');
        app.relaunch();
        app.exit(0);
    }
}

module.exports = { AppCore };
