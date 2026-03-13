const { app, BrowserWindow, screen, ipcMain, shell, powerMonitor } = require('electron');
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
        // 優先從分類服務的 Config 讀取，若無則使用預設值
        const config = this.classifierService.configManager;
        this.idleThresholdLeisure = (config.get('idleThresholdLeisure') || 10) * 60; // 休閒類：預設 10 分鐘
        this.idleThresholdOther = (config.get('idleThresholdOther') || 5) * 60;      // 其他類：預設 5 分鐘 (根據使用者要求調整)

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

        // 工作警示相關（友善提醒）
        this.currentWorkSeconds = 0;
        this.currentOtherSeconds = 0;
        this.workAlertLevels = [
            { minutes: 60, shown: false, icon: '☕', title: '喝杯水吧', message: '你已經專注工作 1 小時了！', detail: '記得喝口水、讓眼睛休息一下 😊' },
            { minutes: 120, shown: false, icon: '🚶', title: '起來走走', message: '哇！已經連續工作 2 小時了', detail: '起來伸展一下，活動筋骨吧！\n短暫休息能讓你更有效率 💪' },
            { minutes: 180, shown: false, icon: '🌿', title: '休息一下吧', message: '太認真了！已經工作 3 小時', detail: '辛苦了！建議休息 10-15 分鐘\n去外面走走、吃點東西 🍵' },
            { minutes: 240, shown: false, icon: '💆', title: '該好好休息了', message: '連續工作 4 小時，真的很棒！', detail: '但身體需要休息才能繼續奮鬥\n請放下工作，好好放鬆一下 ❤️' },
            { minutes: 270, shown: false, icon: '🛑', title: '休息是為了走更長的路', message: '已經連續工作 4.5 小時了', detail: '你的健康比什麼都重要！\n請務必休息後再繼續 🙏' }
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
        // [v1.17.1] iCloud 同步由 AppCore 統一管理，MonitorService 僅負責啟動後的初始同步
        // 啟動後 5 秒執行首次 iCloud 同步，之後每 30 分鐘同步一次
        if (this.apiBridge && this.reminderService) {
            setTimeout(() => {
                console.log('[Monitor] 執行首次 iCloud 同步...');
                this.apiBridge.syncAllIcloudReminders(this.reminderService);
            }, 5000);
            this._icloudSyncTimer = setInterval(() => {
                console.log('[Monitor] 執行 30 分鐘 iCloud 定時同步...');
                this.apiBridge.syncAllIcloudReminders(this.reminderService);
            }, 30 * 60 * 1000);
        }

        if (this.isRunning) {
            console.log('[Monitor] 監測服務已在執行中');
            return;
        }

        // 動態載入 active-win
        if (!activeWin) {
            try {
                activeWin = await import('active-win');
                console.log('[Monitor] active-win 模組載入成功');
            } catch (error) {
                console.error('[Monitor] 無法載入 active-win:', error.message);
                return;
            }
        }

        this.isRunning = true;

        console.log('[Monitor] 開始監測前景視窗');
        console.log(`[Monitor] 取樣頻率: 每 ${this.sampleInterval / 1000} 秒`);
        console.log(`[Monitor] 閒置閾值: 休閒類 ${this.idleThresholdLeisure / 60} 分鐘, 其他類 ${this.idleThresholdOther / 60} 分鐘`);
        console.log(`[Monitor] 午休時間: ${this.lunchBreakStart}:00 - ${this.lunchBreakEnd}:00`);
        console.log(`[Monitor] 休閒警示閾值: ${this.leisureAlertThreshold / 60} 分鐘`);
        console.log(`[Monitor] 工作警示: 1h/2h/3h/4h/4.5h 階段提醒`);

        // 立即執行一次取樣
        await this.sample();

        // [v1.6] 重啟後恢復今日累計數據
        await this._restoreTodayStats();

        // [v26.03.04] 啟動 Firebase 直連心跳 (5分鐘一次)
        this.startHeartbeat();

        console.log('[Monitor] 監測服務啟動中...');
    }

    // 停止監測
    stop() {
        if (this.sampleTimer) {
            clearInterval(this.sampleTimer);
            this.sampleTimer = null;
        }

        this.isRunning = false;
        console.log(`[Monitor] 監測服務已停止，共取樣 ${this.sampleCount} 次`);
    }

    // [v1.16.0] 專家級跨日數據重置與恢復 (數據真實化防禦)
    async _restoreTodayStats() {
        try {
            const today = this.storageService.formatDate(new Date());
            this.lastRestoredDate = today;

            const stats = await this.storageService.getTodayTotalSeconds();
            const MAX_SECONDS = 43200; // 封閉上限 12h (對應 720 分鐘)

            // [v26.03.04 Fix] 正確恢復各分類秒數（包含 Other，解決 0 分問題）
            this.currentWorkSeconds = Math.min(stats.work || 0, MAX_SECONDS);
            this.currentLeisureSeconds = Math.min(stats.leisure || 0, MAX_SECONDS);
            this.currentOtherSeconds = Math.min(stats.other || 0, MAX_SECONDS);

            // 由於重啟，視為觸發過一次休閒冷卻，避免重啟後立刻彈窗 (除非再次超過閾值)
            if (this.currentLeisureSeconds >= this.leisureAlertThreshold) {
                this.leisureAlertShown = true;
            }

            console.log(`[Monitor] 數據恢復成功: 工作 ${Math.floor(this.currentWorkSeconds / 60)}分, 休閒 ${Math.floor(this.currentLeisureSeconds / 60)}分, 其他 ${Math.floor(this.currentOtherSeconds / 60)}分`);
        } catch (error) {
            console.error('[Monitor] 數據恢復失敗:', error.message);
        }
    }


    // 重設休閒追蹤 (僅重設警示狀態，不歸零今日總計)
    resetLeisureTracking() {
        this.currentLeisureApp = null;
        this.leisureAlertShown = false;
    }

    // 重設工作追蹤 (僅重設警示狀態，不歸零今日總計)
    resetWorkTracking() {
        // 重設所有工作警示狀態
        this.workAlertLevels.forEach(level => level.shown = false);
    }

    // 檢查是否為午休時間
    isLunchBreak() {
        const now = new Date();
        const hour = now.getHours();
        return hour >= this.lunchBreakStart && hour < this.lunchBreakEnd;
    }

    // 取得系統閒置時間（秒）
    getIdleTime() {
        try {
            return powerMonitor.getSystemIdleTime();
        } catch (error) {
            return 0;
        }
    }

    // 取得狀態
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
            currentLeisureApp: this.currentLeisureApp,
            currentWorkSeconds: this.currentWorkSeconds,
            currentWorkMinutes: Math.floor(this.currentWorkSeconds / 60),
            isLunchBreak: this.isLunchBreak(),
            leisureSeconds: this.currentLeisureSeconds,
            leisureAlertCount: this.todayLeisureAlertCount,
            idleTime: this.getIdleTime(),
            idleThresholdLeisure: this.idleThresholdLeisure,
            idleThresholdOther: this.idleThresholdOther
        };
    }

    // 執行取樣
    async sample() {
        try {
            // [v1.14.1] 專家級時鐘差值計算
            const nowTs = Date.now();
            const now = new Date(nowTs);
            let durationSeconds;

            if (!this.lastSampleTime) {
                // 首次取樣或重啟後，使用預設取樣間隔
                durationSeconds = this.sampleInterval / 1000;
            } else {
                // 真正的時間差 (秒)
                durationSeconds = Math.round((nowTs - this.lastSampleTime.getTime()) / 1000);

                // [v2.2.8.5 BUGFIX] 排除異常大的時間差 (例如休眠後喚醒)
                // 防止數據灌水 (Spike Protection)
                if (durationSeconds > 60 || durationSeconds < 0) {
                    console.log(`[Monitor] 偵測到時間突波 (${durationSeconds}s)，自動校準為 15s`);
                    durationSeconds = 15;
                }
            }

            // 檢查午休時間
            if (this.isLunchBreak()) {
                await this.storageService.recordActivity({
                    timestamp: now,
                    appName: '午休時間',
                    windowTitle: '',
                    durationSeconds: durationSeconds,
                    category: 'lunch_break'
                });

                this.lastAppName = '午休時間';
                this.lastWindowTitle = '';
                this.lastCategory = 'lunch_break';
                this.lastSubCategory = null;
                this.sampleCount++;

                // 午休時重設所有追蹤
                this.resetLeisureTracking();
                this.resetWorkTracking();
                return;
            }

            // 先取得前景視窗
            const result = await activeWin.default();

            if (!result) {
                return;
            }

            const appName = result.owner?.name || 'Unknown';
            const windowTitle = result.title || '';

            // 先做分類
            const classification = this.classifierService.classifyDetailed(appName, windowTitle);
            const category = classification.category;
            const subCategory = classification.subCategory;

            // 根據分類決定閒置閾值
            const idleThreshold = (category === 'leisure')
                ? this.idleThresholdLeisure  // 休閒類：10 分鐘
                : this.idleThresholdOther;   // 其他類：2 分鐘

            // 取得閒置時間
            const idleTime = this.getIdleTime();

            // 檢查是否超過閒置閾值
            if (idleTime >= idleThreshold) {
                // 閒置狀態
                await this.storageService.recordActivity({
                    timestamp: now,
                    appName: '閒置',
                    windowTitle: `閒置 ${Math.floor(idleTime / 60)} 分鐘 (原: ${appName})`,
                    durationSeconds: durationSeconds,
                    category: 'idle'
                });

                this.lastAppName = '閒置';
                this.lastWindowTitle = `閒置 ${Math.floor(idleTime / 60)} 分鐘`;
                this.lastCategory = 'idle';
                this.lastSubCategory = null;
                this.sampleCount++;

                // 閒置時重設所有追蹤
                this.resetLeisureTracking();
                this.resetWorkTracking();

                return;
            }

            // 記錄到儲存服務
            await this.storageService.recordActivity({
                timestamp: now,
                appName: appName,
                windowTitle: windowTitle,
                durationSeconds: durationSeconds,
                category: category,
                subCategory: subCategory
            });

            // [v26.03.01] 正確累加內存統計 (精確權重反映)
            if (category === 'work') {
                this.currentWorkSeconds += durationSeconds;
            } else if (category === 'leisure') {
                this.currentLeisureSeconds += durationSeconds;
            } else if (category === 'other') {
                this.currentOtherSeconds = (this.currentOtherSeconds || 0) + durationSeconds;
            }

            // 根據分類處理警示
            if (category === 'leisure') {
                // 休閒：累計休閒時間，重設非休閒計時
                this.nonLeisureSeconds = 0;
                this.checkLeisureAlert(appName, windowTitle, durationSeconds);
            } else {
                // 工作或其他：需要連續 30 秒以上才重置休閒計時
                this.nonLeisureSeconds += durationSeconds;

                if (this.nonLeisureSeconds >= this.leisureResetThreshold) {
                    this.resetLeisureTracking();
                }

                // 工作警示 (僅計入 Work 分類，不計入 Other，這更精確)
                if (category === 'work') {
                    this.checkWorkAlert(durationSeconds);
                }
            }

            // 更新最後狀態
            this.lastAppName = appName;
            this.lastWindowTitle = windowTitle;
            this.lastSampleTime = now;
            this.lastCategory = category;
            this.lastSubCategory = subCategory;
            this.sampleCount++;

            // 每 20 次取樣（約 5 分鐘）輸出一次日誌
            if (this.sampleCount % 20 === 0) {
                const workMins = Math.floor(this.currentWorkSeconds / 60);
                const leisureMins = Math.floor(this.currentLeisureSeconds / 60);
                console.log(`[Monitor] 已取樣 ${this.sampleCount} 次，目前: ${appName} [${classification.label}], 工作累計: ${workMins}分, 休閒累計: ${leisureMins}分`);
            }
        } catch (error) {
            console.error('[Monitor] 取樣失敗:', error.message);
        }
    }

    // 檢查休閒警示
    checkLeisureAlert(appName, windowTitle, durationSeconds) {
        // [v26.03.01 Fix] 移除此處重複累加，sample() 已處理過 currentLeisureSeconds
        this.currentLeisureApp = appName;

        let displayName = windowTitle || appName;

        // 簡化顯示名稱
        displayName = displayName
            .replace(/ - Google Chrome$/i, '')
            .replace(/ - Microsoft Edge$/i, '')
            .replace(/ - Firefox$/i, '')
            .replace(/ - 個人 - Microsoft Edge$/i, '')
            .trim();

        if (displayName.length > 40) {
            displayName = displayName.substring(0, 40) + '...';
        }

        // 檢查是否超過閾值
        if (this.currentLeisureSeconds >= this.leisureAlertThreshold &&
            !this.leisureAlertShown && !this.leisureAlertCooldown) {
            this.showLeisureAlert(displayName);
            this.leisureAlertShown = true;
        }

        // 每 2 分鐘輸出一次休閒累計日誌
        const leisureMinutes = Math.floor(this.currentLeisureSeconds / 60);
        if (leisureMinutes > 0 && this.currentLeisureSeconds % 120 < durationSeconds) {
            console.log(`[Monitor] 🔴 休閒累計: ${leisureMinutes} 分鐘 (${displayName})`);
        }
    }

    // 檢查工作警示
    checkWorkAlert(durationSeconds) {
        // [v26.03.01] 注意：內存 currentWorkSeconds 在 sample() 已增加一次，此處僅處理警示邏輯
        const workMinutes = Math.floor(this.currentWorkSeconds / 60);

        // 檢查各階段警示
        for (const level of this.workAlertLevels) {
            if (workMinutes >= level.minutes && !level.shown) {
                this.showWorkAlert(level);
                level.shown = true;
                break; // 一次只顯示一個警示
            }
        }

        // 每 10 分鐘輸出一次工作累計日誌
        if (workMinutes > 0 && this.currentWorkSeconds % 600 < durationSeconds) {
            console.log(`[Monitor] 💼 工作累計: ${workMinutes} 分鐘`);
        }
    }

    // 顯示休閒警示（輕量通知）
    showLeisureAlert(appName) {
        const minutes = Math.floor(this.currentLeisureSeconds / 60);

        console.log(`[Monitor] ⚠️ 休閒警示：已在 ${appName} 停留 ${minutes} 分鐘`);

        this.showToast('⚠️ 專注提醒', `已在「${appName}」停留 ${minutes} 分鐘\n休息一下吧！`);

        // 顯示警示視窗
        this.app.showLeisureAlert(this.currentLeisureApp, Math.floor(minutes));

        this.leisureAlertShown = true;
        this.leisureAlertCooldown = true;
        this.todayLeisureAlertCount++; // 計數+1

        // 觸發休閒警示，重置工作累計
        this.resetWorkTracking();

        // 冷卻 5 分鐘後才允許再次檢查
        setTimeout(() => {
            this.leisureAlertCooldown = false;
        }, 5 * 60 * 1000);
    }

    // 顯示工作警示（輕量通知）
    showWorkAlert(level) {
        const hours = level.minutes / 60;
        const hoursText = hours >= 1 ? `${hours} 小時` : `${level.minutes} 分鐘`;

        console.log(`[Monitor] ${level.icon} 工作警示：已連續工作 ${hoursText}`);

        this.showToast(`${level.icon} ${level.title}`, `${level.message}\n${level.detail}`);
    }

    // 顯示置頂小視窗（不會被專注模式擋住）
    showToast(title, body) {
        console.log(`[Monitor] 顯示警示: ${title}`);

        // [v1.16.7] 秘書裝束同步：與統計中心一致，使用 Config 內的當日裝束
        const config = this.classifierService.configManager;
        const gender = config.getMascotGender() || 'female';
        const currentSkin = config.getMascotSkin() || 'default';

        let fname = (gender === 'female' && currentSkin !== 'default')
            ? `secretary_${currentSkin}.png`
            : (gender === 'female' ? 'secretary.png' : 'secretary_male.png');

        // 檢查本地快取
        const cacheDir = path.join(app.getPath('userData'), 'mascot_cache');
        const localFilePath = path.join(cacheDir, fname);
        const mascotUrl = fs.existsSync(localFilePath)
            ? `file://${localFilePath.replace(/\\/g, '/')}`
            : `https://raw.githubusercontent.com/nephi4377/TAUpdata/master/client/assets/${fname}`;

        const primaryDisplay = screen.getPrimaryDisplay();
        const { width: screenWidth, height: screenHeight } = primaryDisplay.workAreaSize;
        const windowWidth = 450;
        const windowHeight = 140;
        const margin = 20;
        const x = margin;
        const y = screenHeight - windowHeight - margin;

        const html = `<!DOCTYPE html><html><head><meta charset="UTF-8"><style>
            * { margin:0; padding:0; box-sizing:border-box; font-family:"Microsoft JhengHei", sans-serif; }
            body { 
                background: rgba(255, 252, 245, 0.95); 
                color:#5d4037; 
                border-radius:18px; 
                padding:15px; 
                border:2px solid #e67e22; 
                box-shadow:0 10px 40px rgba(0,0,0,0.15); 
                height:140px; 
                display:flex; 
                align-items:center; 
                overflow:hidden;
            }
            .mascot { 
                width:80px; 
                height:110px; 
                background:url('${mascotUrl}') center/cover no-repeat; 
                border-radius:12px; 
                border:2px solid #e67e22; 
                box-shadow:0 4px 12px rgba(0,0,0,0.1);
                background-color:#fff;
                flex-shrink:0; 
                margin-right:15px; 
            }
            .content { flex:1; display:flex; flex-direction:column; justify-content:center; position:relative; }
            .bubble {
                background: #fff;
                padding: 12px;
                border: 1px solid #f0e6d6;
                border-radius: 12px;
                position: relative;
                box-shadow: 2px 2px 5px rgba(0,0,0,0.02);
            }
            .bubble:after {
                content: '';
                position: absolute;
                left: -10px;
                top: 20px;
                border-width: 5px 10px 5px 0;
                border-style: solid;
                border-color: transparent #f0e6d6 transparent transparent;
            }
            .title { font-size:16px; font-weight:800; margin-bottom:4px; color:#e67e22; }
            .body { font-size:13px; color:#6d4c41; line-height:1.4; font-weight:500; }
        </style></head><body>
            <div class="mascot"></div>
            <div class="content">
                <div class="bubble">
                    <div class="title">${this.escapeHtml(title)}</div>
                    <div class="body">${this.escapeHtml(body)}</div>
                </div>
            </div>
        </body></html>`;

        const tempToast = path.join(app.getPath('userData'), 'toast_v18.html');
        fs.writeFileSync(tempToast, html, 'utf8');

        if (!this.toastWindow || this.toastWindow.isDestroyed()) {
            this.toastWindow = new BrowserWindow({
                width: windowWidth, height: windowHeight, x: x, y: y,
                frame: false, transparent: true, alwaysOnTop: true, skipTaskbar: true,
                resizable: false, movable: false, minimizable: false, maximizable: false,
                focusable: false, show: false,
                webPreferences: { contextIsolation: true }
            });
            this.toastWindow.setIgnoreMouseEvents(true);
        }

        this.toastWindow.loadFile(tempToast);
        if (!this.toastWindow.isVisible()) {
            this.toastWindow.showInactive();
        }

        if (this.toastHideTimer) clearTimeout(this.toastHideTimer);

        // 10 秒後開始偵測動作
        this.toastHideTimer = setTimeout(() => {
            if (!this.toastWindow || !this.toastWindow.isVisible()) return;

            console.log('[Monitor] 開始偵測動作以隱藏視窗...');
            let lastIdleTime = powerMonitor.getSystemIdleTime();

            // 清除舊的檢查器
            if (this.activityCheckInterval) clearInterval(this.activityCheckInterval);

            this.activityCheckInterval = setInterval(() => {
                if (!this.toastWindow || !this.toastWindow.isVisible()) {
                    clearInterval(this.activityCheckInterval);
                    return;
                }

                const currentIdleTime = powerMonitor.getSystemIdleTime();
                // 偵測到動作 (閒置時間變少)
                if (currentIdleTime < lastIdleTime) {
                    console.log('[Monitor] 偵測到動作，隱藏警示視窗');
                    this.toastWindow.hide();
                    clearInterval(this.activityCheckInterval);
                } else {
                    lastIdleTime = currentIdleTime;
                }
            }, 500);

            // 60秒後強制隱藏
            setTimeout(() => {
                if (this.activityCheckInterval) clearInterval(this.activityCheckInterval);
                if (this.toastWindow && this.toastWindow.isVisible()) {
                    this.toastWindow.hide();
                }
            }, 60000);

        }, 10000);
    }

    // HTML 跳脫
    escapeHtml(text) {
        if (!text) return '';
        return text
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#039;');
    }


    // 設定午休時間
    setLunchBreak(startHour, endHour) {
        this.lunchBreakStart = startHour;
        this.lunchBreakEnd = endHour;
        console.log(`[Monitor] 午休時間已設為 ${startHour}:00 - ${endHour}:00`);
    }

    // 設定警示閾值（分鐘）
    setLeisureAlertThreshold(minutes) {
        this.leisureAlertThreshold = minutes * 60;
        console.log(`[Monitor] 休閒警示閾值已設為 ${minutes} 分鐘`);
    }

    // [v2026.03.04 恢復] 改為 Firebase 直連心跳回報
    startHeartbeat() {
        if (this.heartbeatInterval) clearInterval(this.heartbeatInterval);

        // 初始發送
        this._sendHeartbeat();

        // 每 3 分鐘發送一次
        this.heartbeatInterval = setInterval(() => {
            this._sendHeartbeat();
        }, 3 * 60 * 1000);
    }

    async _sendHeartbeat() {
        // [v26.03.04] 改為 Firebase 直連心跳回報
        const status = (this.lastCategory === 'idle' || this.lastCategory === 'lunch_break') ? 'idle' : 'work';

        if (this.apiBridge && this.apiBridge.services && this.apiBridge.services.firebaseService) {
            this.apiBridge.services.firebaseService.updateHeartbeat(status, this.lastAppName || '');
        }
    }

    // [v1.13.0] 專家職責遷移：從 TrayManager 接管統計視窗渲染
    async getStatsData(configManager, reminderService) {
        // [v1.13.2 Fix] 防禦性設計
        const cfg = configManager || (this.classifierService ? this.classifierService.configManager : null);
        if (!cfg) {
            console.warn('[Monitor] getStatsData 缺乏 ConfigManager');
            return { topApps: [], stats: {}, status: this.getStatus() };
        }

        const todayStr = new Date().toISOString().split('T')[0];
        const gender = cfg.getMascotGender() || 'female';
        let currentSkin = cfg.getMascotSkin() || 'default';
        const lastChange = cfg.getLastSkinChangeDate();

        // 每日一換邏輯
        if (lastChange !== todayStr) {
            if (gender === 'female') {
                const skins = ['default', 'blizzard', 'thunder', 'boulder', 'sacred', 'prism'];
                currentSkin = skins[Math.floor(Math.random() * skins.length)];
            } else {
                currentSkin = 'default';
            }
            cfg.setMascotSkin(currentSkin);
            cfg.setLastSkinChangeDate(todayStr);
        }

        let fname = (gender === 'female' && currentSkin !== 'default')
            ? `secretary_${currentSkin}.png`
            : (gender === 'female' ? 'secretary.png' : 'secretary_male.png');

        const mascotPath = await this.ensureMascotCached(fname);

        // 讀取頭像
        let mascotUrl = '';
        if (mascotPath && fs.existsSync(mascotPath)) {
            try {
                const imgBuffer = fs.readFileSync(mascotPath);
                mascotUrl = `data:image/png;base64,${imgBuffer.toString('base64')}`;
            } catch (e) {}
        }
        if (!mascotUrl) {
            mascotUrl = `https://raw.githubusercontent.com/nephi4377/TAUpdata/master/client/assets/${fname}`;
        }

        // 獲取數據
        const rawTopApps = await this.storageService.getRecentTopApps(1);
        const dbStats = await this.storageService.getTodayStats();

        // [v1.16.9] 數據牆封頂
        const limitWall = (m) => Math.min(Math.max(0, m || 0), 720);

        const memWork = Math.round((this.currentWorkSeconds || 0) / 60);
        const memLeisure = Math.round((this.currentLeisureSeconds || 0) / 60);
        const memOther = Math.round((this.currentOtherSeconds || 0) / 60);

        const finalWork = limitWall(Math.max(dbStats.work, memWork));
        const finalLeisure = limitWall(Math.max(dbStats.leisure, memLeisure));
        const finalOther = limitWall(Math.max(dbStats.other, memOther));
        const finalIdle = limitWall(dbStats.idle);


        const workInfo = cfg.getTodayWorkInfo();
        let effectiveVersionStr = 'Unknown';
        try {
             // [v2.2.8.5] 嚴格路徑加載版號
             const vsPath = path.join(__dirname, 'versionService.js');
             if (fs.existsSync(vsPath)) {
                 const vSvc = require('./versionService').versionService;
                 if(vSvc) effectiveVersionStr = vSvc.getEffectiveVersion();
             }
        } catch(e) {}

        return {
            version: effectiveVersionStr,
            debugMode: cfg.getDebugMode(),
            workTime: this.formatMinutes(finalWork),
            leisureTime: this.formatMinutes(finalLeisure),
            otherTime: this.formatMinutes(finalOther),
            idleTime: this.formatMinutes(finalIdle),
            boundEmployee: cfg.getBoundEmployee(),
            workInfo: workInfo,
            icloudConnected: this.apiBridge ? this.apiBridge.icloudConnected : false,
            icloudUrl: cfg.getIcloudCalendarUrl(),
            todayReminders: (await (reminderService ? reminderService.getTodayReminderStatus() : [])),
            localTasks: (await this.storageService.getLocalTasks()) || [],
            topApps: rawTopApps.slice(0, 10).map(a => ({
                app_name: a.app_name || '未知',
                duration_formatted: this.formatMinutes(Math.round((a.total_seconds || 0) / 60))
            })),
            mascotUrl: mascotUrl,
            lastUpdate: new Date().toLocaleTimeString('zh-TW', { hour12: false })
        };
    }

    async ensureMascotCached(fname) {
        const cacheDir = path.join(app.getPath('userData'), 'mascot_cache');
        if (!fs.existsSync(cacheDir)) fs.mkdirSync(cacheDir, { recursive: true });
        const localPath = path.join(cacheDir, fname);
        if (fs.existsSync(localPath)) return localPath;
        const url = `https://raw.githubusercontent.com/nephi4377/TAUpdata/master/client/assets/${fname}`;
        return new Promise((resolve) => {
            const file = fs.createWriteStream(localPath);
            https.get(url, (res) => {
                res.pipe(file);
                file.on('finish', () => { file.close(); resolve(localPath); });
            }).on('error', () => { fs.unlink(localPath, () => { }); resolve(null); });
        });
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
                width: 720, height: 880, title: '添心統計中心',
                autoHideMenuBar: true, show: false,
                webPreferences: { contextIsolation: true, preload: path.join(__dirname, 'reminderPreload.js') }
            });

            const loadingHtml = `<!DOCTYPE html><html><head><meta charset="UTF-8"><style>
                body { background:#f9fcfc; display:flex; justify-content:center; align-items:center; height:100vh; color:#e67e22; font-family:sans-serif; flex-direction:column; gap:20px; }
                .loader { width:40px; height:40px; border:4px solid #f0e6d6; border-top:4px solid #e67e22; border-radius:50%; animation:spin 1s linear infinite; }
                @keyframes spin { 0% { transform:rotate(0deg); } 100% { transform:rotate(360deg); } }
            </style></head><body><div class="loader"></div><div>正在召喚小秘書...✨</div></body></html>`;

            this.statsWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(loadingHtml)}`);
            this.statsWindow.once('ready-to-show', () => this.statsWindow.show());

            setImmediate(async () => {
                try {
                    const data = await this.getStatsData(configManager, reminderService);
                    const finalHtml = await this.generateStatsHtml(data);
                    if (this.statsWindow && !this.statsWindow.isDestroyed()) {
                        this.statsWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(finalHtml)}`);
                    }
                } catch (e) {
                    console.error('[Monitor] 渲染失敗:', e.message);
                }
            });

            this.statsWindow.on('closed', () => { this.statsWindow = null; });
        } catch (err) {
            console.error('[Monitor] showStatsWindow 關鍵崩潰:', err.message);
        }
    }

    async generateStatsHtml(data) {
        const { mascotUrl, boundEmployee, workInfo, icloudConnected } = data;
        let bubbleMsg = '正在為您守護今日進度...✨';

        const checkinBtn = boundEmployee
            ? `<button class="btn ok" onclick="doCheckin(event)" id="checkin-btn">✅ 打卡</button>
               <button class="btn info" onclick="window.reminderAPI.openDashboardWindow()">🖥️ 主控台</button>`
            : `<button class="btn" style="background:#e67e22; width:100%;" onclick="window.reminderAPI.openLinkWindow()">📲 前往綁定 (LINE)</button>`;


        return `<!DOCTYPE html><html><head><meta charset="UTF-8"><style>
            * { margin:0; padding:0; box-sizing:border-box; font-family:"Microsoft JhengHei", sans-serif; }
            body { background:#f9fcfc; color:#2c3e50; padding:18px; }
            .card { background:#fff; border-radius:18px; padding:22px; margin-bottom:18px; box-shadow:0 8px 30px rgba(0,0,0,0.03); border:1px solid #f0f4f4; }
            h2 { font-size:16px; margin-bottom:15px; color:#4a5a5a; font-weight:700; }
            .btn-group { display:flex; gap:15px; margin-top:18px; }
            .btn { flex:1; padding:14px; border:none; border-radius:15px; cursor:pointer; font-weight:700; display:flex; align-items:center; justify-content:center; gap:8px; transition:0.3s; }
            .btn.ok { background:linear-gradient(135deg, #10b981, #059669); color:white; box-shadow:0 4px 15px rgba(16,185,129,0.2); }
            .btn.info { background:#f1f5f9; color:#475569; border:1px solid #e2e8f0; }
            .task-item { display:flex; justify-content:space-between; align-items:center; padding:10px; border-radius:10px; margin-bottom:5px; background:#f8fafc; border:1px solid #f1f5f9; transition:0.2s; }
            .task-item.completed { opacity:0.5; background:#f1f5f9; }
            .task-btn { background:#fff; border:2px solid #10b981; border-radius:8px; width:28px; height:28px; cursor:pointer; color:#10b981; font-weight:bold; }
            .status-dot { width:10px; height:10px; border-radius:50%; display:inline-block; }
            .online { background:#10b981; box-shadow:0 0 8px rgba(16,185,129,0.4); }
            .offline { background:#94a3b8; }
            .app-row { display:flex; padding:8px 0; border-bottom:1px solid #f1f5f9; font-size:13px; }
        </style></head><body>
            <div class="card">
                <div style="display:flex; gap:20px;">
                    <div style="width:130px; height:200px; background:url('${mascotUrl}') top center / cover no-repeat; border-radius:14px; border:3px solid #e67e22; box-shadow:0 8px 25px rgba(0,0,0,0.1); background-color:#2c3e50;"></div>
                    <div style="flex:1; display:flex; flex-direction:column; gap:10px;">
                        <div id="mascot-bubble" style="background:#fffcf5; padding:15px; border-radius:15px; border:1px solid #f0e6d6; min-height:80px; position:relative; line-height:1.5;">
                            ${bubbleMsg}
                            <div style="position:absolute; top:20px; left:-10px; border-width:5px 10px 5px 0; border-style:solid; border-color:transparent #f0e6d6 transparent transparent;"></div>
                        </div>
                        <div style="text-align:center; font-weight:bold; margin-top:5px; color:#5d4037; font-size:15px;" id="p-t">今日狀態：同步中 ✨</div>
                    </div>
                </div>
                <div style="display:flex; justify-content:space-between; align-items:center; margin-top:15px; padding-top:15px; border-top:1px solid #eee;">
                    <b>👤 使用者: ${boundEmployee ? boundEmployee.userName : '未連結'}</b>
                    <span style="font-size:12px; color:#8d6e63;"><span class="status-dot ${icloudConnected ? 'online' : 'offline'}"></span> ${icloudConnected ? 'iCloud 已連線' : 'iCloud 未連線'}</span>
                </div>
                <div style="display:grid; grid-template-columns:1fr 1fr; margin-top:10px; font-size:14px; color:#555;">
                    <div>🕒 上班時間: ${workInfo?.checkinTime || '--:--'}</div>
                    <div>🕒 預計下班: ${workInfo?.expectedOffTime || '--:--'}</div>
                </div>
                <div class="btn-group">${checkinBtn}</div>
            </div>
            <script>
                // [v1.17.4] MDQ 隊列系統
                let mascotQueue = [];
                let lockUntil = 0;
                function setMascotMsg(text, priority = 3) {
                    const now = Date.now();
                    const b = document.getElementById('mascot-bubble');
                    if(!b) return;
                    if(now < lockUntil && priority >= 3) { mascotQueue.push({text, priority}); return; }
                    b.innerText = text;
                    if(priority <= 2) lockUntil = now + 10000;
                }
                setInterval(() => {
                    if(Date.now() >= lockUntil && mascotQueue.length > 0) {
                        const next = mascotQueue.shift();
                        setMascotMsg(next.text, next.priority);
                    }
                }, 1000);

                function updateUI(d) {
                    if(!d) return;
                    const list = document.getElementById('t-l');
                    let h = '';
                    const items = [
                        ...(d.todayReminders || []).map(r=>({...r, type:'rem'})), 
                        ...(d.localTasks || []).map(t=>({...t, type:'task'}))
                    ];
                    
                    // 排序：待辦置頂，已完成沉底
                    items.sort((a,b) => (a.status==='pending'? -1 : 1));
                    
                    if(items.length > 0) {
                        items.forEach(i => {
                            const isC = i.status === 'completed';
                            h += '<div class="task-item '+(isC?'completed':'')+'" id="node-'+i.id+'">';
                            h += '<span>'+(isC?'✅':'📌')+' '+i.title+'</span>';
                            h += '<button class="task-btn" onclick="toggleTask('+i.id+', \\''+(isC?'pending':'completed')+'\\', \\''+i.type+'\\')">'+(isC?'↺':'✓')+'</button>';
                            h += '</div>';
                        });
                        list.innerHTML = h;
                    } else {
                        list.innerHTML = '<div style="text-align:center; color:#ccc; padding:20px;">今日暫無待辦事項 ✨</div>';
                    }
                }

                async function toggleTask(id, status, type) {
                    // 樂觀更新
                    const node = document.getElementById('node-'+id);
                    if(node) {
                        const isDone = status==='completed';
                        node.classList.toggle('completed', isDone);
                        node.querySelector('span').innerText = (isDone?'✅':'📌') + ' ' + node.querySelector('span').innerText.substring(2);
                        node.querySelector('button').innerText = isDone?'↺':'✓';
                    }
                    setMascotMsg(status==='completed' ? '又解決了一件，太棒了！✨' : '已為您把任務標記為待辦。');
                    if(type==='rem') {
                        if(status==='completed') await window.reminderAPI.complete(id);
                        else await window.reminderAPI.undo(id);
                    } else {
                        await window.reminderAPI.updateLocalTask(id, status);
                    }
                    window.reminderAPI.refreshStats({isManual:false});
                }

                async function doCheckin() { 
                    setMascotMsg('正在為您打卡...🚀'); 
                    const btn = document.getElementById('checkin-btn');
                    if(btn) btn.disabled = true;
                    try {
                        const r = await window.reminderAPI.directCheckin(); 
                        setMascotMsg(r.success ? '打卡成功！✨ 辛苦了。' : '糟糕，打卡失敗：' + r.message); 
                    } catch(e) {}
                    setTimeout(() => { if(btn) btn.disabled = false; window.reminderAPI.refreshStats({isManual:false}); }, 3000);
                }

                window.onload = () => { 
                    if(window.reminderAPI) {
                        window.reminderAPI.onUpdateStats(updateUI); 
                        window.reminderAPI.refreshStats({isManual:true}); 
                        // 原 60s 定時刷新已由 3min Firebase 心跳與手動觸發取代，故移除。
                    }
                };
            </script></body></html>`;
    }

    formatMinutes(m) { m = Math.round(m || 0); if(!m) return '0分'; if(m < 60) return m + '分'; return Math.floor(m / 60) + 'h ' + (m % 60) + 'm'; }
}

module.exports = { MonitorService };
