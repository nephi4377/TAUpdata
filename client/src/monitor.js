const { Notification, dialog, powerMonitor, BrowserWindow, screen, app, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const https = require('https');

// 動態載入 active-win（ESM 模組）
let activeWin = null;

class MonitorService {
    constructor(storageService, classifierService) {
        this.storageService = storageService;
        this.classifierService = classifierService;

        this.isRunning = false;

        this.lastAppName = null;
        this.lastWindowTitle = null;
        this.lastSampleTime = null;
        this.lastCategory = null;
        this.lastSubCategory = null;

        // 取樣間隔 15 秒
        this.sampleInterval = 15 * 1000;
        this.sampleTimer = null;
        this.sampleCount = 0;

        // 閒置閾值（根據內容類型不同）
        const config = this.classifierService.configManager;
        this.idleThresholdLeisure = (config.get('idleThresholdLeisure') || 10) * 60; // 休閒類：預設 10 分鐘
        this.idleThresholdOther = (config.get('idleThresholdOther') || 5) * 60;      // 其他類：預設 5 分鐘

        // 午休時間設定
        this.lunchBreakStart = 12;
        this.lunchBreakEnd = 13;

        // 休閒警示相關
        this.leisureAlertThreshold = 5 * 60; // 5 分鐘累計休閒觸發警示
        this.leisureResetThreshold = 60;     // 工作/其他超過 60 秒才重置休閒計時
        this.currentLeisureSeconds = 0;
        this.currentLeisureApp = null;
        this.leisureAlertShown = false;
        this.leisureAlertCooldown = false;
        this.todayLeisureAlertCount = 0; // 今日觸發次數
        this.nonLeisureSeconds = 0;          // 追蹤連續非休閒秒數

        // 工作警示相關
        this.currentWorkSeconds = 0;
        this.currentOtherSeconds = 0;
        this.workAlertLevels = [
            { minutes: 60, shown: false, icon: '☕', title: '喝杯水吧', message: '你已經專注工作 1 小時了！', detail: '記得喝口水、讓眼睛休息一下 😊' },
            { minutes: 120, shown: false, icon: '🚶', title: '起來走走', message: '哇！已經連續工作 2 小時了', detail: '起來伸展一下，活動筋骨吧！' },
            { minutes: 180, shown: false, icon: '🌿', title: '休息一下吧', message: '太認真了！已經工作 3 小時', detail: '辛苦了！建議休息 10-15 分鐘' },
            { minutes: 240, shown: false, icon: '💆', title: '該好好休息了', message: '連續工作 4 小時，真的很棒！', detail: '但身體需要休息才能繼續奮鬥' }
        ];

        console.log('[Monitor] 監測服務已建立');
    }

    setApiBridge(apiBridge) {
        this.apiBridge = apiBridge;
    }

    setReminderService(reminderService) {
        this.reminderService = reminderService;
    }

    // 啟動監測
    async start() {
        if (this.apiBridge && this.reminderService) {
            setTimeout(() => {
                this.apiBridge.syncAllIcloudReminders(this.reminderService);
            }, 5000);
            this._icloudSyncTimer = setInterval(() => {
                this.apiBridge.syncAllIcloudReminders(this.reminderService);
            }, 30 * 60 * 1000);
        }

        if (this.isRunning) return;

        if (!activeWin) {
            try {
                activeWin = await import('active-win');
            } catch (error) {
                console.error('[Monitor] 無法載入 active-win:', error.message);
                return;
            }
        }

        this.isRunning = true;
        await this.sample();
        await this._restoreTodayStats();
        this.startHeartbeat();
    }

    stop() {
        if (this.sampleTimer) {
            clearInterval(this.sampleTimer);
            this.sampleTimer = null;
        }
        this.isRunning = false;
    }

    async _restoreTodayStats() {
        try {
            const stats = await this.storageService.getTodayTotalSeconds();
            const MAX_SECONDS = 43200; 
            this.currentWorkSeconds = Math.min(stats.work || 0, MAX_SECONDS);
            this.currentLeisureSeconds = Math.min(stats.leisure || 0, MAX_SECONDS);
            this.currentOtherSeconds = Math.min(stats.other || 0, MAX_SECONDS);
            if (this.currentLeisureSeconds >= this.leisureAlertThreshold) {
                this.leisureAlertShown = true;
            }
        } catch (error) {
            console.error('[Monitor] 數據恢復失敗:', error.message);
        }
    }

    resetLeisureTracking() {
        this.currentLeisureApp = null;
        this.leisureAlertShown = false;
    }

    resetWorkTracking() {
        this.workAlertLevels.forEach(level => level.shown = false);
    }

    isLunchBreak() {
        const now = new Date();
        const hour = now.getHours();
        return hour >= this.lunchBreakStart && hour < this.lunchBreakEnd;
    }

    getIdleTime() {
        try {
            return powerMonitor.getSystemIdleTime();
        } catch (error) {
            return 0;
        }
    }

    getStatus() {
        return {
            isRunning: this.isRunning,
            lastAppName: this.lastAppName,
            lastWindowTitle: this.lastWindowTitle,
            lastSampleTime: this.lastSampleTime,
            lastCategory: this.lastCategory,
            lastSubCategory: this.lastSubCategory,
            sampleCount: this.sampleCount,
            currentLeisureSeconds: this.currentLeisureSeconds,
            currentWorkSeconds: this.currentWorkSeconds,
            isLunchBreak: this.isLunchBreak(),
            leisureSeconds: this.currentLeisureSeconds,
            leisureAlertCount: this.todayLeisureAlertCount,
            idleTime: this.getIdleTime()
        };
    }

    async sample() {
        try {
            const nowTs = Date.now();
            const now = new Date(nowTs);
            let durationSeconds = this.sampleInterval / 1000;

            if (this.lastSampleTime) {
                durationSeconds = Math.round((nowTs - this.lastSampleTime.getTime()) / 1000);
                if (durationSeconds > 60 || durationSeconds < 0) {
                    durationSeconds = 15;
                }
            }

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
                this.resetLeisureTracking();
                this.resetWorkTracking();
                this.lastSampleTime = now;
                return;
            }

            const result = await activeWin.default();
            if (!result) return;

            const appName = result.owner?.name || 'Unknown';
            const windowTitle = result.title || '';
            const classification = this.classifierService.classifyDetailed(appName, windowTitle);
            const category = classification.category;
            const subCategory = classification.subCategory;

            const idleThreshold = (category === 'leisure') ? this.idleThresholdLeisure : this.idleThresholdOther;
            const idleTime = this.getIdleTime();

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
                this.resetLeisureTracking();
                this.resetWorkTracking();
            } else {
                await this.storageService.recordActivity({
                    timestamp: now,
                    appName: appName,
                    windowTitle: windowTitle,
                    durationSeconds: durationSeconds,
                    category: category,
                    subCategory: subCategory
                });

                if (category === 'work') this.currentWorkSeconds += durationSeconds;
                else if (category === 'leisure') this.currentLeisureSeconds += durationSeconds;
                else if (category === 'other') this.currentOtherSeconds += durationSeconds;

                if (category === 'leisure') {
                    this.nonLeisureSeconds = 0;
                    this.checkLeisureAlert(appName, windowTitle, durationSeconds);
                } else {
                    this.nonLeisureSeconds += durationSeconds;
                    if (this.nonLeisureSeconds >= this.leisureResetThreshold) {
                        this.resetLeisureTracking();
                    }
                    if (category === 'work') this.checkWorkAlert(durationSeconds);
                }

                this.lastAppName = appName;
                this.lastWindowTitle = windowTitle;
                this.lastCategory = category;
                this.lastSubCategory = subCategory;
            }
            this.lastSampleTime = now;
            this.sampleCount++;
        } catch (error) {
            console.error('[Monitor] 取樣失敗:', error.message);
        }
    }

    checkLeisureAlert(appName, windowTitle, durationSeconds) {
        this.currentLeisureApp = appName;
        if (this.currentLeisureSeconds >= this.leisureAlertThreshold && !this.leisureAlertShown && !this.leisureAlertCooldown) {
            this.showLeisureAlert(windowTitle || appName);
        }
    }

    checkWorkAlert(durationSeconds) {
        const workMinutes = Math.floor(this.currentWorkSeconds / 60);
        for (const level of this.workAlertLevels) {
            if (workMinutes >= level.minutes && !level.shown) {
                this.showWorkAlert(level);
                level.shown = true;
                break;
            }
        }
    }

    showLeisureAlert(appName) {
        const minutes = Math.floor(this.currentLeisureSeconds / 60);
        this.showToast('⚠️ 專注提醒', `已在「${appName}」停留 ${minutes} 分鐘\n休息一下吧！`);
        this.leisureAlertShown = true;
        this.leisureAlertCooldown = true;
        this.todayLeisureAlertCount++;
        this.resetWorkTracking();
        setTimeout(() => { this.leisureAlertCooldown = false; }, 5 * 60 * 1000);
    }

    showWorkAlert(level) {
        this.showToast(`${level.icon} ${level.title}`, `${level.message}\n${level.detail}`);
    }

    showToast(title, body) {
        // [v1.16.7] 秘書裝束同步
        const config = this.classifierService.configManager;
        const gender = config.getMascotGender() || 'female';
        const currentSkin = config.getMascotSkin() || 'default';
        let fname = (gender === 'female' && currentSkin !== 'default') ? `secretary_${currentSkin}.png` : (gender === 'female' ? 'secretary.png' : 'secretary_male.png');
        
        const cacheDir = path.join(app.getPath('userData'), 'mascot_cache');
        const localFilePath = path.join(cacheDir, fname);
        const mascotUrl = fs.existsSync(localFilePath) ? `file://${localFilePath.replace(/\\/g, '/')}` : `https://raw.githubusercontent.com/nephi4377/TAUpdata/master/client/assets/${fname}`;

        const primaryDisplay = screen.getPrimaryDisplay();
        const { height: screenHeight } = primaryDisplay.workAreaSize;
        const x = 20;
        const y = screenHeight - 160;

        const html = `<!DOCTYPE html><html><head><meta charset="UTF-8"><style>
            * { margin:0; padding:0; box-sizing:border-box; font-family:"Microsoft JhengHei", sans-serif; }
            body { background: rgba(255, 252, 245, 0.95); color:#5d4037; border-radius:18px; padding:15px; border:2px solid #e67e22; box-shadow:0 10px 40px rgba(0,0,0,0.15); height:140px; display:flex; align-items:center; overflow:hidden; }
            .mascot { width:80px; height:110px; background:url('${mascotUrl}') center/cover no-repeat; border-radius:12px; border:2px solid #e67e22; flex-shrink:0; margin-right:15px; background-color:#fff; }
            .bubble { background: #fff; padding: 12px; border: 1px solid #f0e6d6; border-radius: 12px; position: relative; flex:1; }
            .title { font-size:16px; font-weight:800; margin-bottom:4px; color:#e67e22; }
            .body { font-size:13px; color:#6d4c41; line-height:1.4; }
        </style></head><body><div class="mascot"></div><div class="bubble"><div class="title">${title}</div><div class="body">${body}</div></div></body></html>`;

        const tempToast = path.join(app.getPath('userData'), 'toast.html');
        fs.writeFileSync(tempToast, html, 'utf8');

        if (!this.toastWindow || this.toastWindow.isDestroyed()) {
            this.toastWindow = new BrowserWindow({ width: 450, height: 140, x, y, frame: false, transparent: true, alwaysOnTop: true, skipTaskbar: true, resizable: false, focusable: false, show: false, webPreferences: { contextIsolation: true } });
            this.toastWindow.setIgnoreMouseEvents(true);
        }
        this.toastWindow.loadFile(tempToast);
        this.toastWindow.showInactive();
        
        if (this.toastHideTimer) clearTimeout(this.toastHideTimer);
        this.toastHideTimer = setTimeout(() => { if (this.toastWindow) this.toastWindow.hide(); }, 10000);
    }

    startHeartbeat() {
        if (this.heartbeatInterval) clearInterval(this.heartbeatInterval);
        this._sendHeartbeat();
        this.heartbeatInterval = setInterval(() => this._sendHeartbeat(), 5 * 60 * 1000);
    }

    async _sendHeartbeat() {
        const status = (this.lastCategory === 'idle' || this.lastCategory === 'lunch_break') ? 'idle' : 'work';
        if (this.apiBridge?.services?.firebaseService) {
            this.apiBridge.services.firebaseService.updateHeartbeat(status, this.lastAppName || '');
        }
    }

    async getStatsData(configManager, reminderService) {
        const stats = await this.storageService.getTodayStats();
        const topApps = await this.storageService.getTopApps(20);
        const cfg = configManager;
        
        const gender = cfg.getMascotGender() || 'female';
        let currentSkin = cfg.getMascotSkin() || 'default';
        let fname = (gender === 'female' && currentSkin !== 'default') ? `secretary_${currentSkin}.png` : (gender === 'female' ? 'secretary.png' : 'secretary_male.png');

        const cacheDir = path.join(app.getPath('userData'), 'mascot_cache');
        const imgPath = path.join(cacheDir, fname);
        let mascotUrl = '';
        if (fs.existsSync(imgPath)) {
            mascotUrl = `data:image/png;base64,${fs.readFileSync(imgPath).toString('base64')}`;
        } else {
            mascotUrl = `https://raw.githubusercontent.com/nephi4377/TAUpdata/master/client/assets/${fname}`;
        }

        const workInfo = cfg.getTodayWorkInfo();
        let effectiveVersionStr = 'Unknown';
        try {
            const vSvc = require('./versionService').versionService;
            if(vSvc) effectiveVersionStr = vSvc.getEffectiveVersion();
        } catch(e) {}

        return {
            version: effectiveVersionStr,
            debugMode: cfg.getDebugMode(),
            workTime: this.formatMinutes(stats.work / 60),
            leisureTime: this.formatMinutes(stats.leisure / 60),
            otherTime: this.formatMinutes(stats.other / 60),
            productivityRate: stats.productivityRate,
            boundEmployee: cfg.getBoundEmployee(),
            workInfo: workInfo,
            icloudConnected: this.apiBridge ? this.apiBridge.icloudConnected : false,
            icloudUrl: cfg.getIcloudCalendarUrl(),
            todayReminders: (await (reminderService ? reminderService.getTodayReminderStatus() : [])),
            localTasks: (await this.storageService.getLocalTasks()) || [],
            topApps: topApps.slice(0, 10).map(a => ({
                ...a,
                duration_formatted: this.formatMinutes(Math.round(a.duration_seconds / 60))
            })),
            mascotUrl
        };
    }

    async ensureMascotCached(fname) {
        const cacheDir = path.join(app.getPath('userData'), 'mascot_cache');
        if (!fs.existsSync(cacheDir)) fs.mkdirSync(cacheDir, { recursive: true });
        const localPath = path.join(cacheDir, fname);
        if (fs.existsSync(localPath)) return localPath;
        return localPath;
    }

    async showStatsWindow(configManager, reminderService, isManual = true) {
        if (this.statsWindow && !this.statsWindow.isDestroyed()) {
            const data = await this.getStatsData(configManager, reminderService);
            this.statsWindow.webContents.send('update-stats-data', data);
            if (isManual) { this.statsWindow.show(); this.statsWindow.focus(); }
            return;
        }
        this.statsWindow = new BrowserWindow({ width: 720, height: 880, title: '添心統計中心', autoHideMenuBar: true, show: false, webPreferences: { contextIsolation: true, preload: path.join(__dirname, 'reminderPreload.js') } });
        const loadingHtml = `<!DOCTYPE html><html><head><style>body{background:#f9fcfc;display:flex;justify-content:center;align-items:center;height:100vh;color:#e67e22;font-family:sans-serif;flex-direction:column;gap:20px;}.loader{width:40px;height:40px;border:4px solid #f0e6d6;border-top:4px solid #e67e22;border-radius:50%;animation:spin 1s linear infinite;}@keyframes spin{0%{transform:rotate(0deg);}100%{transform:rotate(360deg);}}</style></head><body><div class="loader"></div><div>正在召喚小秘書...✨</div></body></html>`;
        this.statsWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(loadingHtml)}`);
        this.statsWindow.once('ready-to-show', () => this.statsWindow.show());
        setImmediate(async () => {
            const data = await this.getStatsData(configManager, reminderService);
            const finalHtml = await this.generateStatsHtml(data);
            if (this.statsWindow && !this.statsWindow.isDestroyed()) {
                this.statsWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(finalHtml)}`);
            }
        });
        this.statsWindow.on('closed', () => { this.statsWindow = null; });
    }

    async generateStatsHtml(data) {
        const { mascotUrl, workTime, leisureTime, otherTime, productivityRate, boundEmployee, workInfo, icloudConnected, icloudUrl, topApps } = data;
        const rate = productivityRate || 0;
        let bubbleMsg = '正在為您守護今日進度...✨';
        if (rate >= 80) bubbleMsg = '今天的表現太棒了！簡直是高效代名詞 💪';
        else if (rate >= 50) bubbleMsg = '進度穩定推進中，繼續保持喔 ☕';
        
        const checkinBtn = boundEmployee
            ? `<button class="btn ok" onclick="doCheckin(event)" id="checkin-btn">✅ 打卡</button>
               <button class="btn info" onclick="window.reminderAPI.openDashboardWindow()">🖥️ 主控台</button>`
            : `<button class="btn" style="background:#e67e22; width:100%;" onclick="window.reminderAPI.openLinkWindow()">📲 前往綁定 (LINE)</button>`;

        let appRankingHtml = '';
        topApps.forEach((a, i) => {
            appRankingHtml += `<div class="app-row"><span style="width:25px;">${i+1}.</span><span style="flex:1;">${a.app_name}</span><b>${a.duration_formatted}</b></div>`;
        });

        return `<!DOCTYPE html><html><head><meta charset="UTF-8"><style>
            * { margin:0; padding:0; box-sizing:border-box; font-family:"Microsoft JhengHei", sans-serif; }
            body { background:#f9fcfc; color:#2c3e50; padding:18px; }
            .card { background:#fff; border-radius:18px; padding:22px; margin-bottom:18px; box-shadow:0 8px 30px rgba(0,0,0,0.03); border:1px solid #f0f4f4; }
            .btn-group { display:flex; gap:15px; margin-top:18px; }
            .btn { flex:1; padding:14px; border:none; border-radius:15px; cursor:pointer; font-weight:700; display:flex; align-items:center; justify-content:center; gap:8px; transition:0.3s; }
            .btn.ok { background:linear-gradient(135deg, #10b981, #059669); color:white; }
            .btn.info { background:#f1f5f9; color:#475569; }
            .task-item { display:flex; justify-content:space-between; align-items:center; padding:10px; border-radius:10px; margin-bottom:5px; background:#f8fafc; }
            .task-item.completed { opacity:0.5; }
            .task-btn { background:#fff; border:2px solid #10b981; border-radius:8px; width:26px; height:26px; cursor:pointer; color:#10b981; }
            .status-dot { width:10px; height:10px; border-radius:50%; display:inline-block; }
            .online { background:#10b981; }
            .offline { background:#94a3b8; }
            .app-row { display:flex; padding:8px 0; border-bottom:1px solid #eee; font-size:13px; }
        </style></head><body>
            <div class="card">
                <div style="display:flex; gap:20px;">
                    <div style="width:130px; height:200px; background:url('${mascotUrl}') center/cover no-repeat; border-radius:14px; border:3px solid #e67e22;"></div>
                    <div style="flex:1;">
                        <div id="mascot-bubble" style="background:#fffcf5; padding:15px; border-radius:15px; border:1px solid #f0e6d6; min-height:80px;">${bubbleMsg}</div>
                        <!-- 數據顯示預設隱藏 -->
                        <div style="display:none; grid-template-columns:1fr 1fr 1fr; gap:8px; margin-top:10px; text-align:center;">
                            <div>${workTime}<br>工作</div><div>${leisureTime}<br>休閒</div><div>${otherTime}<br>其他</div>
                        </div>
                        <div style="text-align:center; font-weight:bold; margin-top:10px; color:#5d4037;">今日狀態：同步中 ✨</div>
                        <div style="height:10px; background:#f0ede8; border-radius:5px; margin-top:10px; overflow:hidden; display:none;">
                            <div style="width:${rate}%; height:100%; background:#e67e22;"></div>
                        </div>
                    </div>
                </div>
                <div style="display:flex; justify-content:space-between; margin-top:15px; padding-top:15px; border-top:1px solid #eee;">
                    <b>👤 使用者: ${boundEmployee ? boundEmployee.userName : '未連結'}</b>
                    <span><span class="status-dot ${icloudConnected ? 'online' : 'offline'}"></span> ${icloudConnected ? 'iCloud 已連線' : 'iCloud 未連線'}</span>
                </div>
                <div style="display:grid; grid-template-columns:1fr 1fr; margin-top:10px; font-size:14px;">
                    <div>🕒 上班: ${workInfo?.checkinTime || '--:--'}</div>
                    <div>🕒 預計下班: ${workInfo?.expectedOffTime || '--:--'}</div>
                </div>
                <div class="btn-group">${checkinBtn}</div>
            </div>
            <div class="card"><h2>📋 今日任務</h2><div id="t-l"></div></div>
            <div class="card" style="display:none;"><h2>📈 應用排行</h2><div id="app-ranking">${appRankingHtml}</div></div>
            <script>
                // [v1.17.4] MDQ 隊列系統
                let mascotQueue = [];
                let lockUntil = 0;
                function setMascotMsg(text, priority = 3) {
                    const now = Date.now();
                    const b = document.getElementById('mascot-bubble');
                    if(now < lockUntil && priority >= 3) { mascotQueue.push({text, priority}); return; }
                    b.innerText = text;
                    if(priority <= 2) lockUntil = now + 10000;
                }
                setInterval(() => {
                    const now = Date.now();
                    if(now >= lockUntil && mascotQueue.length > 0) {
                        const next = mascotQueue.shift();
                        setMascotMsg(next.text, next.priority);
                    }
                }, 1000);

                function updateUI(d) {
                    const list = document.getElementById('t-l');
                    let h = '';
                    const items = [...(d.todayReminders || []).map(r=>({...r, type:'rem'})), ...(d.localTasks || []).map(t=>({...t, type:'task'}))];
                    items.sort((a,b) => (a.status==='pending'? -1 : 1));
                    items.forEach(i => {
                        const isC = i.status === 'completed';
                        h += '<div class="task-item '+(isC?'completed':'')+'"><span>'+(isC?'✅':'📌')+' '+i.title+'</span>';
                        h += '<button class="task-btn" onclick="window.reminderAPI.complete(\\''+i.id+'\\')">'+(isC?'↺':'✓')+'</button></div>';
                    });
                    list.innerHTML = h || '暫無任務';
                }
                async function doCheckin() { setMascotMsg('通訊中...🚀'); const r = await window.reminderAPI.directCheckin(); setMascotMsg(r.success ? '打卡成功！✨' : '失敗了 ❌'); }
                window.onload = () => { window.reminderAPI.onUpdateStats(updateUI); window.reminderAPI.refreshStats({isManual:true}); };
            </script></body></html>`;
    }

    formatMinutes(m) { m = Math.round(m || 0); if (!m) return '0分'; if (m < 60) return m + '分'; return Math.floor(m / 60) + 'h ' + (m % 60) + 'm'; }
}

module.exports = { MonitorService };
