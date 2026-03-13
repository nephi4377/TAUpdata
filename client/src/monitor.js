const { app, BrowserWindow, screen, ipcMain, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const https = require('https');
const activeWin = require('active-win');
const versionService = require('./versionService');
const log = require('electron-log');

/**
 * [v2.2.8.7] 核心監控服務 - 深度修正版
 * 負責取樣、分類、統計、以及 UI 呈現
 */
class MonitorService {
    constructor() {
        this.statsWindow = null;
        this.sampleInterval = 15000; // 15秒取樣一次
        this.lastSampleTime = null;
        this.storageService = null;
        this.classifierService = null;
        this.apiBridge = null;
        
        // 核心狀態
        this.lastAppName = null;
        this.lastWindowTitle = null;
        this.lastCategory = null;
        this.lastSubCategory = null;
        this.sampleCount = 0;
        
        // 即時統計 (用於 UI 高速反應)
        this.currentWorkSeconds = 0;
        this.currentLeisureSeconds = 0;
        this.todayLeisureAlertCount = 0;
        
        // 閒置檢測
        this.idleThresholdLeisure = 10 * 60; // 休閒類 10 分鐘閒置
        this.idleThresholdOther = 2 * 60;    // 其他類 2 分鐘閒置
    }

    init(storage, classifier, api) {
        this.storageService = storage;
        this.classifierService = classifier;
        this.apiBridge = api;
        this.startSampling();
        log.info('[Monitor] 服務初始化完成');
    }

    startSampling() {
        setInterval(() => this.sample(), this.sampleInterval);
    }

    // 取得當前狀態摘要
    getStatus() {
        return {
            lastAppName: this.lastAppName,
            lastWindowTitle: this.lastWindowTitle,
            lastSampleTime: this.lastSampleTime,
            lastCategory: this.lastCategory,
            lastSubCategory: this.lastSubCategory,
            sampleCount: this.sampleCount,
            currentLeisureSeconds: this.currentLeisureSeconds,
            currentWorkSeconds: this.currentWorkSeconds,
            isLunchBreak: this.isLunchBreak(),
            idleTime: this.getIdleTime()
        };
    }

    // 判斷是否為午休 (12:00-13:30)
    isLunchBreak() {
        const now = new Date();
        const hours = now.getHours();
        const minutes = now.getMinutes();
        const timeVal = hours * 100 + minutes;
        return timeVal >= 1200 && timeVal <= 1330;
    }

    // 取得閒置時間 (Electron 原生支援)
    getIdleTime() {
        try {
            return screen.getIdleTime();
        } catch (e) {
            return 0;
        }
    }

    // 執行取樣
    async sample() {
        try {
            const nowTs = Date.now();
            const now = new Date(nowTs);
            let durationSeconds;

            if (!this.lastSampleTime) {
                durationSeconds = this.sampleInterval / 1000;
            } else {
                durationSeconds = Math.round((nowTs - this.lastSampleTime.getTime()) / 1000);
                // [v2.2.8.5 BUGFIX] 排除異常大的時間差 (例如休眠後喚醒)
                if (durationSeconds > 60 || durationSeconds < 0) {
                    durationSeconds = 15;
                }
            }
            this.lastSampleTime = now;

            if (this.isLunchBreak()) {
                await this.storageService.recordActivity({
                    timestamp: now,
                    appName: '午休時間',
                    windowTitle: '',
                    durationSeconds: durationSeconds,
                    category: 'lunch_break'
                });
                this.lastAppName = '午休時間';
                this.lastCategory = 'lunch_break';
                return;
            }

            const result = await activeWin.default();
            if (!result) return;

            const appName = result.owner?.name || 'Unknown';
            const windowTitle = result.title || '';
            const classification = this.classifierService.classifyDetailed(appName, windowTitle);
            const category = classification.category;
            
            const idleTime = this.getIdleTime();
            const idleThreshold = (category === 'leisure') ? this.idleThresholdLeisure : this.idleThresholdOther;

            if (idleTime >= idleThreshold) {
                await this.storageService.recordActivity({
                    timestamp: now,
                    appName: '閒置',
                    windowTitle: `閒置 ${Math.floor(idleTime / 60)} 分鐘`,
                    durationSeconds: durationSeconds,
                    category: 'idle'
                });
                this.lastAppName = '閒置';
                this.lastCategory = 'idle';
            } else {
                await this.storageService.recordActivity({
                    timestamp: now,
                    appName: appName,
                    windowTitle: windowTitle,
                    durationSeconds: durationSeconds,
                    category: category,
                    subCategory: classification.subCategory
                });
                this.lastAppName = appName;
                this.lastWindowTitle = windowTitle;
                this.lastCategory = category;
                this.lastSubCategory = classification.subCategory;
                
                if (category === 'work') this.currentWorkSeconds += durationSeconds;
                if (category === 'leisure') this.currentLeisureSeconds += durationSeconds;
            }
            this.sampleCount++;
        } catch (err) {
            log.error('[Monitor] 取樣錯誤:', err.message);
        }
    }

    async getStatsData(configManager, reminderService) {
        const stats = await this.storageService.getTodayStats();
        const topApps = await this.storageService.getTopApps(20);
        const mascotUrl = await this.ensureMascotCached('assistant_v1.png');
        const boundEmployee = configManager.getBoundEmployee();
        const cfg = configManager;
        const workInfo = await this.apiBridge.getWorkStatus();

        return {
            version: versionService.getEffectiveVersion(),
            debugMode: cfg.get('debugMode', false),
            workTime: this.formatMinutes(stats.work / 60),
            leisureTime: this.formatMinutes(stats.leisure / 60),
            otherTime: this.formatMinutes(stats.other / 60),
            productivityRate: stats.productivityRate,
            icloudConnected: this.apiBridge ? this.apiBridge.icloudConnected : false,
            icloudUrl: cfg ? cfg.getIcloudCalendarUrl() : null,
            todayReminders: (await (reminderService ? reminderService.getTodayReminderStatus() : [])),
            localTasks: (await this.storageService.getLocalTasks()) || [],
            topApps: topApps.slice(0, 10).map(a => ({
                ...a,
                duration_formatted: this.formatMinutes(Math.round(a.duration_seconds / 60))
            })),
            mascotUrl: mascotUrl,
            boundEmployee,
            workInfo
        };
    }

    async ensureMascotCached(fname) {
        const cacheDir = path.join(app.getPath('userData'), 'mascot_cache');
        if (!fs.existsSync(cacheDir)) fs.mkdirSync(cacheDir, { recursive: true });
        const localPath = path.join(cacheDir, fname);
        if (fs.existsSync(localPath)) return localPath;
        return localPath; // Fallback
    }

    async showStatsWindow(configManager, reminderService, isManual = true) {
        try {
            if (this.statsWindow && !this.statsWindow.isDestroyed()) {
                const data = await this.getStatsData(configManager, reminderService);
                this.statsWindow.webContents.send('update-stats-data', data);
                if (isManual) { this.statsWindow.show(); this.statsWindow.focus(); }
                return;
            }

            this.statsWindow = new BrowserWindow({
                width: 720, height: 880, title: `添心統計中心 (v${versionService.getEffectiveVersion()})`,
                autoHideMenuBar: true, show: false,
                webPreferences: { contextIsolation: true, preload: path.join(__dirname, 'reminderPreload.js') }
            });

            const loadingHtml = `<!DOCTYPE html><html><head><style>body{background:#f9fcfc;display:flex;justify-content:center;align-items:center;height:100vh;color:#e67e22;font-family:sans-serif;flex-direction:column;gap:20px;}.loader{width:40px;height:40px;border:4px solid #f0e6d6;border-top:4px solid #e67e22;border-radius:50%;animation:spin 1s linear infinite;}@keyframes spin{0%{transform:rotate(0deg);}100%{transform:rotate(360deg);}}</style></head><body><div class="loader"></div><div>正在召喚小秘書...✨</div></body></html>`;
            this.statsWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(loadingHtml)}`);
            this.statsWindow.once('ready-to-show', () => this.statsWindow.show());

            setImmediate(async () => {
                try {
                    const data = await this.getStatsData(configManager, reminderService);
                    const finalHtml = await this.generateStatsHtml(data);
                    if (this.statsWindow && !this.statsWindow.isDestroyed()) {
                        this.statsWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(finalHtml)}`);
                    }
                } catch (e) { log.error('[Monitor] 視窗內容載入失敗:', e.message); }
            });

            this.statsWindow.on('closed', () => { this.statsWindow = null; });
        } catch (err) { log.error('[Monitor] showStatsWindow 關鍵崩潰:', err.message); }
    }

    async generateStatsHtml(data) {
        const { mascotUrl, workTime, leisureTime, otherTime, productivityRate, boundEmployee, workInfo, icloudConnected, icloudUrl } = data;
        const rate = productivityRate || 0;
        let bubbleMsg = '正在為您守護今日進度...✨';
        if (rate >= 80) bubbleMsg = '今天的表現太棒了！簡直是高效代名詞 💪';
        else if (rate >= 50) bubbleMsg = '進度穩定推進中，繼續保持喔 ☕';

        const syncStatus = icloudConnected ? '<span class="status-dot online"></span>' : '<span class="status-dot offline"></span>';
        const syncText = icloudConnected ? 'iCloud 已連線' : (icloudUrl ? 'iCloud 未連線' : '❌ iCloud 網址未設定');

        const checkinBtn = boundEmployee
            ? `<button class="btn ok" onclick="doCheckin(event)" id="checkin-btn">✅ 打卡</button>
               <button class="btn info" onclick="window.reminderAPI.openDashboardWindow()">🖥️ 主控台</button>`
            : `<button class="btn" style="background:#e67e22; width:100%;" onclick="window.reminderAPI.openLinkWindow()">📲 前往綁定 (LINE)</button>`;

        return `<!DOCTYPE html><html><head><meta charset="UTF-8"><style>
            body { font-family:"Microsoft JhengHei",sans-serif; background:#f4f7f6; margin:0; padding:20px; color:#333; overflow-x:hidden; }
            .card { background:#fff; border-radius:18px; padding:25px; box-shadow:0 10px 30px rgba(0,0,0,0.05); margin-bottom:20px; border:1px solid #eee; }
            .status-dot { width:10px; height:10px; border-radius:50%; display:inline-block; margin-right:5px; }
            .online { background:#27ae60; box-shadow:0 0 8px #2ecc71; }
            .offline { background:#e74c3c; box-shadow:0 0 8px #ff7675; }
            .btn-group { display:grid; grid-template-columns:1fr 1fr; gap:12px; margin-top:20px; }
            .btn { border:none; padding:12px; border-radius:12px; cursor:pointer; font-weight:bold; font-size:15px; transition:0.2s; display:flex; align-items:center; justify-content:center; gap:8px; }
            .btn.ok { background:#e67e22; color:#fff; }
            .btn.info { background:#f39c12; color:#fff; }
            .task-item { display:flex; align-items:center; justify-content:space-between; padding:12px; border-bottom:1px solid #f9f9f9; }
            .task-item.completed { opacity:0.6; background:#fcfcfc; }
            .task-title { font-size:15px; flex:1; }
            .task-btn { background:none; border:1px solid #ddd; border-radius:50%; width:28px; height:28px; cursor:pointer; color:#e67e22; }
            .task-item.completed .task-title { text-decoration:line-through; color:#999; }
        </style></head><body>
            <div class="card">
                <div style="display:flex; gap:20px; align-items:flex-start;">
                    <div style="width:130px; height:195px; background:url('${mascotUrl}') top center / cover no-repeat; border-radius:14px; border:3px solid #e67e22; background-color:#2c3e50;"></div>
                    <div style="flex:1; display:flex; flex-direction:column; gap:12px;">
                        <div id="mascot-bubble" style="background:#fffcf5; padding:15px; border-radius:15px; font-size:15px; border:1px solid #f0e6d6;">${bubbleMsg}</div>
                        <div style="display:none; grid-template-columns:1fr 1fr 1fr; gap:8px; text-align:center;">
                            <div>${workTime}<br>工作</div><div>${leisureTime}<br>休閒</div><div>${otherTime}<br>其他</div>
                        </div>
                        <div style="text-align:center; font-weight:bold; font-size:15px; margin-top:8px; color:#5d4037;">今日狀態：同步中 ✨</div>
                    </div>
                </div>
                <div style="display:flex; justify-content:space-between; align-items:center; border-top:1px solid #f9f7f2; margin-top:20px; padding-top:15px;">
                    <div style="font-size:14px; font-weight:bold;">👤 使用者: ${boundEmployee ? boundEmployee.userName : '未連結'}</div>
                    <div style="font-size:12px; display:flex; align-items:center;">${syncStatus} ${syncText}</div>
                </div>
                <div style="display:grid; grid-template-columns:1fr 1fr; margin-top:12px; gap:12px; font-size:14px;">
                    <div>🕒 上班: ${workInfo?.checkinTime || '--:--'}</div>
                    <div>🕒 預計下班: ${workInfo?.expectedOffTime || '--:--'}</div>
                </div>
                <div class="btn-group">${checkinBtn}</div>
                <div style="text-align:right; font-size:10px; color:#ccc; margin-top:10px;">v${data.version}</div>
            </div>
            <div class="card" id="task-center-card">
                <h2>📋 今日提醒事項</h2>
                <div id="t-l"><div style="text-align:center; color:#ccc; padding:20px;">正在讀取計畫...</div></div>
            </div>
            <script>
                const logDebug = (m) => console.log('[UI] ' + m);
                function setMascotMsg(m) { const b = document.getElementById('mascot-bubble'); if(b) b.innerText = m; }
                function updateUI(d) {
                    if(!d) return;
                    const listEl = document.getElementById('t-l');
                    if(listEl && d.todayReminders) {
                        let h = '';
                        d.todayReminders.forEach(r => {
                            const isC = r.status === 'completed';
                            h += '<div class="task-item ' + (isC ? 'completed' : '') + '">';
                            h += '<span class="task-title">' + (isC ? '✅' : '⏰') + ' ' + r.title + '</span>';
                            h += '<button class="task-btn" onclick="window.reminderAPI.complete(\\''+r.id+'\\')">✓</button></div>';
                        });
                        listEl.innerHTML = h || '<div style="text-align:center; color:#ccc; padding:20px;">今日暫無提醒 ✨</div>';
                    }
                }
                async function doCheckin(e) {
                    setMascotMsg('正在通訊中...🚀');
                    const r = await window.reminderAPI.directCheckin();
                    if(r && r.success) setMascotMsg('打卡完成！✨');
                    else setMascotMsg('打卡失敗 ❌');
                    setTimeout(() => window.reminderAPI.refreshStats({isManual:false}), 2000);
                }
                window.onload = () => {
                    if(window.reminderAPI) {
                        window.reminderAPI.onUpdateStats(updateUI);
                        setTimeout(() => window.reminderAPI.refreshStats({isManual:true}), 1000);
                    }
                };
            </script></body></html>`;
    }

    formatMinutes(m) { m = Math.round(m || 0); if (!m) return '0分'; if (m < 60) return m + '分'; return Math.floor(m / 60) + 'h ' + (m % 60) + 'm'; }
}

module.exports = { MonitorService };
