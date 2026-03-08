const { Notification, dialog, powerMonitor, BrowserWindow, screen, app, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const https = require('https');
const { versionService } = require('./versionService');

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
            const MAX_SECONDS = 86400; // 封閉上限 24h

            // [v26.03.04 Fix] 正確恢復各分類秒數（修復 work+other 灌水問題）
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

    // [v26.03.01] 專家級統計數據快照同步 - 解決計時器卡死在 13 分的問題
    async _syncDisplayStatsWithDB() {
        const stats = await this.storageService.getTodayTotalSeconds();
        // 內存累加為主，僅在明顯落後 DB 時對齊 (防禦性設計)
        if (stats.work > this.currentWorkSeconds) this.currentWorkSeconds = stats.work;
        if (stats.leisure > this.currentLeisureSeconds) this.currentLeisureSeconds = stats.leisure;
        if (stats.other > (this.currentOtherSeconds || 0)) this.currentOtherSeconds = stats.other;
    }

    // 重設休閒追蹤
    resetLeisureTracking() {
        this.currentLeisureSeconds = 0;
        this.currentLeisureApp = null;
        this.leisureAlertShown = false;
    }

    // 重設工作追蹤
    resetWorkTracking() {
        this.currentWorkSeconds = 0;
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
            let durationSeconds = this.sampleInterval / 1000;

            if (this.lastSampleTime) {
                // 真正的時間差 (秒)
                durationSeconds = Math.round((nowTs - this.lastSampleTime.getTime()) / 1000);

                // [v1.18.4] 專家級防禦：若時間差過大 (> 60s)，可能剛從休眠喚醒
                // 為了數據準確性，強制校準為 15s 取樣基準，防止數據灌水 (Spike Protection)
                if (durationSeconds > 60) {
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
        this.currentLeisureSeconds += durationSeconds;
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

    // 測試休閒警示
    testLeisureAlert() {
        console.log('[Monitor] 測試休閒警示');
        this.showToast('⚠️ 專注提醒（測試）', '已在「YouTube」停留 5 分鐘\n休息一下吧！');
    }

    // 測試工作警示
    testWorkAlert(level = 0) {
        console.log('[Monitor] 測試工作警示');
        const alertLevel = this.workAlertLevels[level] || this.workAlertLevels[0];
        this.showToast(`${alertLevel.icon} ${alertLevel.title}（測試）`, `${alertLevel.message}\n${alertLevel.detail}`);
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

        // 每 5 分鐘發送一次
        this.heartbeatInterval = setInterval(() => {
            this._sendHeartbeat();
        }, 5 * 60 * 1000);
    }

    async _sendHeartbeat() {
        // [v26.03.04] 改為 Firebase 直連心跳回報
        const status = (this.lastCategory === 'idle' || this.lastCategory === 'lunch_break') ? 'idle' : 'work';

        if (this.apiBridge && this.apiBridge.services && this.apiBridge.services.firebaseService) {
            this.apiBridge.services.firebaseService.updateHeartbeat(status, this.lastAppName || '');
        }
    }
    // [v1.13.0] 專家職責遷移：從 TrayManager 接管統計視窗渲染
    // [v1.14.0] 專家診斷：獲取數據前強制進行一次數據庫對齊，解決計時器卡死在 13 分的問題
    async getStatsData(configManager, reminderService) {
        // [v26.03.01 Fix] 移除強制 _restoreTodayStats，改用輕量級同步，防止計時器回跳 (跳回 13 分/25 分)
        // 因 DB 寫入與緩存可能有 15s 延遲，內存變數才是最即時的真實數據。
        // await this._restoreTodayStats(); 

        // [v1.13.2 Fix] 防禦性設計：若漏傳服務，嘗試從內部引用獲取
        const cfg = configManager || (this.classifierService ? this.classifierService.configManager : null);
        if (!cfg) {
            console.warn('[Monitor] getStatsData 缺乏 ConfigManager，暫時返回空數據');
            return { topApps: [], stats: {}, status: this.getStatus() };
        }

        const todayStr = new Date().toISOString().split('T')[0];
        const gender = configManager.getMascotGender() || 'female';
        let currentSkin = configManager.getMascotSkin() || 'default';
        const lastChange = configManager.getLastSkinChangeDate();

        // [v1.13.0] 每日一換邏輯：若日期不符，則重新抽籤並更新紀錄
        if (lastChange !== todayStr) {
            console.log(`[Monitor] 偵測到新的一天 (${todayStr})，更換小秘書裝束...`);
            if (gender === 'female') {
                const skins = ['default', 'blizzard', 'thunder', 'boulder', 'sacred', 'prism'];
                currentSkin = skins[Math.floor(Math.random() * skins.length)];
            } else {
                currentSkin = 'default'; // 男秘書目前僅有 default
            }
            configManager.setMascotSkin(currentSkin);
            configManager.setLastSkinChangeDate(todayStr);
        }

        let fname = (gender === 'female' && currentSkin !== 'default')
            ? `secretary_${currentSkin}.png`
            : (gender === 'female' ? 'secretary.png' : 'secretary_male.png');

        const mascotPath = await Promise.race([
            this.ensureMascotCached(fname),
            new Promise(resolve => setTimeout(() => resolve(null), 3000))
        ]);

        // [v1.17.1] 修復：data: URL 中無法載入 file:// 資源，改用 base64 data URI
        let mascotUrl = '';
        const localAssetPath = path.join(__dirname, '..', 'assets', fname);
        const cachedPath = mascotPath;
        const imgPath = (cachedPath && fs.existsSync(cachedPath)) ? cachedPath : (fs.existsSync(localAssetPath) ? localAssetPath : null);
        if (imgPath) {
            try {
                const imgBuffer = fs.readFileSync(imgPath);
                mascotUrl = `data:image/png;base64,${imgBuffer.toString('base64')}`;
            } catch (e) {
                console.warn('[Monitor] 頭像讀取失敗:', e.message);
            }
        }
        if (!mascotUrl) {
            mascotUrl = `https://raw.githubusercontent.com/nephi4377/TAUpdata/master/client/assets/${fname}`;
        }

        // 獲取今日排行：修正參數為 1（代表取今天），原本誤傳 1000（天）導致查無資料
        const rawTopApps = await this.storageService.getRecentTopApps(1);
        console.log(`[Monitor] 原始排行數據: ${JSON.stringify(rawTopApps)}`);

        // 前端加總邏輯：合併相同應用的時數與分類
        const combinedApps = {};
        if (rawTopApps && rawTopApps.length > 0) {
            rawTopApps.forEach(a => {
                const name = a.app_name || a.appName || '未知';

                if (!combinedApps[name]) {
                    combinedApps[name] = {
                        dur: 0,
                        category: a.category || 'other'
                    };
                }
                const dur = a.total_seconds || a.totalSeconds || a.duration_seconds || a.durationSeconds || 0;
                combinedApps[name].dur += dur;
            });
        }

        // [v26.03.02 Fix] 注入當前活躍的內存數據到排行榜
        if (this.lastAppName) {
            const name = this.lastAppName;
            if (!combinedApps[name]) {
                combinedApps[name] = { dur: 0, category: this.lastCategory || 'other' };
            }
            // 視為今日採樣的一部分
            combinedApps[name].dur += 15;
        }

        const topApps = Object.entries(combinedApps)
            .map(([name, data]) => ({
                app_name: name,
                duration_seconds: data.dur,
                category: data.category
            }))
            .sort((a, b) => b.duration_seconds - a.duration_seconds)
            .filter(a => a.duration_seconds > 0);

        const dbStats = await this.storageService.getTodayStats();

        // [v1.16.9] 數據牆封頂：所有分類與排行數值強制截斷至 1440 分鐘
        const limit1440 = (m) => Math.min(Math.max(0, m || 0), 1440);

        // [v26.03.04 Fix] 使用內存累加值為主，DB 為輔：解決 DB 15 秒延遲寫入導致前端數據停滯
        const memWork = Math.round((this.currentWorkSeconds || 0) / 60);
        const memLeisure = Math.round((this.currentLeisureSeconds || 0) / 60);
        const memOther = Math.round((this.currentOtherSeconds || 0) / 60);

        const finalWork = limit1440(Math.max(dbStats.work, memWork));
        const finalLeisure = limit1440(Math.max(dbStats.leisure, memLeisure));
        const finalOther = limit1440(Math.max(dbStats.other, memOther));
        const finalIdle = limit1440(dbStats.idle);

        const totalActive = finalWork + finalLeisure + finalOther;
        const sumAll = totalActive + finalIdle;
        const productivityRate = sumAll > 0 ? Math.round((finalWork / sumAll) * 100) : 0;

        const workInfo = cfg.getTodayWorkInfo();
        if (workInfo && workInfo.checkedIn && workInfo.checkinTime && (!workInfo.expectedOffTime || workInfo.expectedOffTime === '--:--')) {
            try {
                const [h, m] = workInfo.checkinTime.split(':').map(Number);
                const offH = (h + 9) % 24;
                workInfo.expectedOffTime = `${String(offH).padStart(2, '0')}:${String(m).padStart(2, '0')} (估)`;
            } catch (e) { }
        }

        return {
            version: versionService.getEffectiveVersion(),
            debugMode: cfg.getDebugMode(),
            workTime: this.formatMinutes(finalWork),
            leisureTime: this.formatMinutes(finalLeisure),
            otherTime: this.formatMinutes(finalOther),
            idleTime: this.formatMinutes(finalIdle),
            productivityRate: Math.min(100, productivityRate),
            boundEmployee: cfg.getBoundEmployee(),
            workInfo: workInfo,
            icloudConnected: this.apiBridge ? this.apiBridge.icloudConnected : false,
            icloudUrl: cfg ? cfg.getIcloudCalendarUrl() : null,
            todayReminders: (await (reminderService ? reminderService.getTodayReminderStatus() : [])),
            localTasks: (await this.storageService.getLocalTasks()) || [],
            topApps: topApps.slice(0, 10).map(a => ({
                ...a,
                duration_seconds: Math.min(86400, a.duration_seconds), // 確保數據排行不溢出
                duration_formatted: this.formatMinutes(Math.round(a.duration_seconds / 60))
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
            console.log('[Monitor] 極速啟動統計中心 (Memory-Inject Mode)...');

            if (this.statsWindow && !this.statsWindow.isDestroyed()) {
                const data = await this.getStatsData(configManager, reminderService);
                this.statsWindow.webContents.send('update-stats-data', data);
                if (isManual) {
                    this.statsWindow.show();
                    this.statsWindow.focus();
                }
                return;
            }

            this.statsWindow = new BrowserWindow({
                width: 720, height: 880, title: `添心統計中心 (v${versionService.getEffectiveVersion()})`,
                autoHideMenuBar: true, show: false,
                webPreferences: { contextIsolation: true, preload: path.join(__dirname, 'reminderPreload.js') }
            });

            // 建構初始加載 HTML
            const loadingHtml = `<!DOCTYPE html><html><head><meta charset="UTF-8"><style>
                body { background:#f9fcfc; display:flex; justify-content:center; align-items:center; height:100vh; color:#e67e22; font-family:sans-serif; flex-direction:column; gap:20px; }
                .loader { width:40px; height:40px; border:4px solid #f0e6d6; border-top:4px solid #e67e22; border-radius:50%; animation:spin 1s linear infinite; }
                @keyframes spin { 0% { transform:rotate(0deg); } 100% { transform:rotate(360deg); } }
            </style></head><body><div class="loader"></div><div>正在召喚小秘書...✨</div></body></html>`;

            this.statsWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(loadingHtml)}`);
            this.statsWindow.once('ready-to-show', () => this.statsWindow.show());

            // 異步渲染主內容 (使用 setImmediate 確保視窗先顯示)
            setImmediate(async () => {
                try {
                    const data = await this.getStatsData(configManager, reminderService);
                    const finalHtml = await this.generateStatsHtml(data);
                    if (this.statsWindow && !this.statsWindow.isDestroyed()) {
                        this.statsWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(finalHtml)}`);
                    }
                } catch (e) {
                    console.error('[Monitor] 視窗內容載入失敗:', e.message);
                }
            });

            this.statsWindow.on('closed', () => { this.statsWindow = null; });
        } catch (err) {
            console.error('[Monitor] showStatsWindow 關鍵崩潰:', err.message);
        }
    }

    _startAutoRefresh(config, reminder) {
        // [v26.03.01 BUGFIX] 移除此重複定時器，由 AppCore 統一每 60 秒刷新即可，減少資源消耗
    }

    _stopAutoRefresh() {
        // 職責移交至 AppCore
    }

    async generateStatsHtml(data) {
        const { mascotUrl, workTime, leisureTime, otherTime, idleTime, productivityRate, topApps, boundEmployee, workInfo } = data;
        const rate = productivityRate || 0;

        // [v1.13.0] 語意化對話邏輯
        let bubbleMsg = '正在為您守護今日進度...✨';
        if (rate >= 80) bubbleMsg = '今天的表現太棒了！簡直是高效代名詞 💪';
        else if (rate >= 50) bubbleMsg = '進度穩定推進中，繼續保持喔 ☕';
        else if (rate > 0) bubbleMsg = '剛開始啟動嗎？小添陪您一起加油 📈';

        const checkinBtn = boundEmployee
            ? `<button class="btn ok" onclick="doCheckin(event)" id="checkin-btn">✅ 打卡</button>
               <button class="btn info" onclick="window.reminderAPI.openDashboardWindow()">🖥️ 主控台</button>`
            : `<button class="btn" style="background:#e67e22; width:100%;" onclick="window.reminderAPI.openLinkWindow()">📲 前往綁定 (LINE)</button>`;

        let appH = '';
        if (topApps && topApps.length > 0) {
            topApps.forEach((a, i) => {
                const timeStr = a.duration_formatted || '0分';

                appH += `<div class="app-row">
                    <span style="color:#888; font-size:11px; width:25px;">${i + 1}.</span>
                    <span style="flex:1; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; font-size:13px; color:#5d4037;">${a.app_name}</span>
                    <span style="font-weight:bold; color:#d35400; font-size:13px;">${timeStr}</span>
                </div>`;
            });
        }

        const isIcloudOnline = data.icloudConnected;
        const hasIcloudUrl = !!data.icloudUrl;

        let syncStatus = '<span class="status-dot offline"></span>';
        let syncText = 'iCloud 未連線';

        if (isIcloudOnline) {
            syncStatus = '<span class="status-dot online"></span>';
            syncText = 'iCloud 已連線';
        } else if (!hasIcloudUrl) {
            syncStatus = '<span class="status-dot offline" style="background:#e74c3c;"></span>';
            syncText = '❌ iCloud 網址未設定';
        }

        return `<!DOCTYPE html><html><head><meta charset="UTF-8"><style>
            * { margin:0; padding:0; box-sizing:border-box; font-family:"Microsoft JhengHei", sans-serif; }
            body { background:#f9fcfc; color:#2c3e50; padding:18px; overflow-x:hidden; }
            .card { background:#fff; border-radius:18px; padding:22px; margin-bottom:18px; box-shadow:0 8px 30px rgba(0,0,0,0.03); border:1px solid #f0f4f4; transition: 0.3s; }
            .card:hover { transform: translateY(-2px); box-shadow: 0 12px 40px rgba(0,0,0,0.05); }
            h2 { font-size:16px; margin-bottom:15px; display:flex; align-items:center; gap:10px; color:#4a5a5a; font-weight:700; }
            .summary-val { font-size:24px; font-weight:800; color:#2c3e50; letter-spacing:-0.5px; }
            .btn-group { display:flex; gap:15px; margin-top:18px; }
            .btn { flex:1; padding:14px; border:none; border-radius:15px; cursor:pointer; font-weight:700; font-size:15px; transition:0.3s cubic-bezier(0.4, 0, 0.2, 1); display:flex; align-items:center; justify-content:center; gap:8px; }
            .btn.ok { background:linear-gradient(135deg, #10b981, #059669); color:white; box-shadow:0 4px 15px rgba(16,185,129,0.2); }
            .btn.ok:hover { transform:scale(1.02); box-shadow:0 6px 20px rgba(16,185,129,0.3); }
            .btn.info { background:#f1f5f9; color:#475569; border:1px solid #e2e8f0; }
            .btn.info:hover { background:#e2e8f0; }
            .task-item { display:flex; justify-content:space-between; align-items:center; padding:8px 12px; border-radius:10px; margin-bottom:4px; background:#f8fafc; border:1px solid #f1f5f9; transition:0.2s; }
            .task-item:hover { background:#fff; border-color:#d1d5db; transform: translateX(2px); }
            .task-item.completed { opacity:0.5; background:#f1f5f9; }
            .task-title { font-size:13px; font-weight:600; color:#334155; display:flex; align-items:center; gap:8px; line-height:1.4; }
            .task-btn { background:#fff; border:2px solid #10b981; border-radius:8px; width:26px; height:26px; cursor:pointer; display:flex; align-items:center; justify-content:center; color:#10b981; font-weight:bold; transition:0.2s; font-size:12px; }
            .task-btn:hover { background:#10b981; color:#fff; }
            .task-btn.done { border-color:#94a3b8; color:#94a3b8; }
            .app-list-container { max-height:250px; overflow-y:auto; padding-right:5px; }
            .app-row { display:flex; align-items:center; padding:10px 0; border-bottom:1px solid #f1f5f9; }
            .status-dot { width:10px; height:10px; border-radius:50%; display:inline-block; }
            .status-dot.online { background:#10b981; box-shadow:0 0 8px rgba(16,185,129,0.4); }
            .status-dot.offline { background:#94a3b8; }
        </style></head>
        <body>
            <div class="card">
                <!-- 視覺改動：左側大秘書，右側資訊流 -->
                <div style="display:flex; gap:20px; align-items:flex-start;">
                    <!-- 左側：壯觀小秘書 (120x180) -->
                    <div style="width:130px; flex-shrink:0;">
                        <div style="width:130px; height:195px; background:url('${mascotUrl}') top center / cover no-repeat; border-radius:14px; border:3px solid #e67e22; box-shadow:0 8px 25px rgba(0,0,0,0.12); background-color:#2c3e50;"></div>
                    </div>

                    <!-- 右側資訊流 -->
                    <div style="flex:1; display:flex; flex-direction:column; gap:12px;">
                        <!-- 秘書對話欄 (唯一動態氣泡) -->
                        <div id="mascot-bubble" style="background:#fffcf5; color:#5d4037; padding:15px; border-radius:15px; font-size:15px; position:relative; border:1px solid #f0e6d6; line-height:1.5; transition: opacity 0.3s; box-shadow: 0 4px 10px rgba(0,0,0,0.02);">
                            ${bubbleMsg}
                            <div style="position:absolute; top:20px; left:-10px; border-width:5px 10px 5px 0; border-style:solid; border-color:transparent #f0e6d6 transparent transparent;"></div>
                        </div>

                        <!-- 數據三排 -->
                        <div style="display:grid; grid-template-columns:1fr 1fr 1fr; gap:8px; text-align:center;">
                            <div style="background:#fdfcf9; padding:10px; border-radius:10px; border:1px solid #f9f7f2;"><div class="summary-val" id="stat-work">${workTime}</div><div style="font-size:12px; color:#8d6e63;">工作</div></div>
                            <div style="background:#fdfcf9; padding:10px; border-radius:10px; border:1px solid #f9f7f2;"><div class="summary-val" id="stat-leisure" style="color:#e91e63;">${leisureTime}</div><div style="font-size:12px; color:#8d6e63;">休閒</div></div>
                            <div style="background:#fdfcf9; padding:10px; border-radius:10px; border:1px solid #f9f7f2;"><div class="summary-val" id="stat-other" style="color:#795548;">${otherTime}</div><div style="font-size:12px; color:#8d6e63;">其他</div></div>
                        </div>

                        <!-- 進度條 -->
                        <div style="margin-top:5px;">
                            <div style="height:10px; background:#f0ede8; border-radius:5px; overflow:hidden;">
                                <div id="p-f" style="height:100%; background:linear-gradient(to right, #e67e22, #ffa726); width:${rate}%;"></div>
                            </div>
                            <div id="p-t" style="text-align:center; font-weight:bold; font-size:15px; margin-top:8px; color:#5d4037;">當前生產力：${rate}%</div>
                        </div>
                    </div>
                </div>

                <!-- 使用者資訊與 iCloud 燈號 (置於第一區塊下方) -->
                <div style="display:flex; justify-content:space-between; align-items:center; border-top:1.5px solid #f9f7f2; margin-top:20px; padding-top:15px;">
                    <div style="font-size:14px; font-weight:bold; color:#5d4037;">
                        👤 使用者: ${boundEmployee ? boundEmployee.userName : '未連結'} 
                        ${data.debugMode ? `<span style="font-size:11px; color:#8d6e63; font-weight:normal; margin-left:5px; background:#f0e6d6; padding:1px 6px; border-radius:4px;">UID: ${boundEmployee ? boundEmployee.userId : '--'}</span>` : ''}
                    </div>
                    <div id="icloud-status-bar" style="font-size:12px; color:#8d6e63; display:flex; align-items:center; background:#fdfcf9; padding:5px 12px; border-radius:8px; border:1px solid #f0e6d6;">${syncStatus} ${syncText}</div>
                </div>
                
                <div style="display:grid; grid-template-columns:1fr 1fr; margin-top:12px; gap:12px; font-size:15px; color:#8d6e63; font-weight:500;">
                    <div>🕒 上班時間: <span id="val-checkin-time" style="color:#555;">${workInfo?.checkinTime || '--:--'}</span></div>
                    <div>🕒 預計下班: <span id="val-off-time" style="color:#555;">${workInfo?.expectedOffTime || '--:--'}</span></div>
                </div>

                <!-- 底部橫排按鈕 (使用對齊後的動態變數) -->
                <div class="btn-group">
                    ${checkinBtn}
                </div>
                <div style="display:flex; justify-content:space-between; align-items:center; margin-top:5px; padding:0 2px;">
                    <div id="sync-ts" style="font-size:10px; color:#aaa;">首次加載中...</div>
                    <div style="font-size:10px; color:#ccc; display:flex; align-items:center; gap:5px;">
                        ${data.version} 
                        <span style="cursor:pointer; opacity:0.3; transition:0.3s;" onclick="window.reminderAPI.testFireReminder()" title="穩定性測試">🐞</span>
                    </div>
                </div>
            </div>

            <!-- 下層：提醒事項與排行 (預設顯示，確保對齊計畫書) -->
            <div class="card" id="task-center-card">
                <div id="debug-box" style="display:none; background:rgba(0,0,0,0.8); color:#0f0; font-family:monospace; font-size:10px; padding:10px; border-radius:8px; margin-bottom:10px; max-height:100px; overflow-y:auto;"></div>
                <h2>📋 今日提醒與待辦事項</h2>
                <div id="t-l"><div style="text-align:center; color:#ccc; font-size:14px; padding:20px;">正在加載今日計畫...</div></div>
            </div>

            <div class="card">
                <h2>📈 全量應用活躍排行</h2>
                <div id="app-ranking-list" class="app-list-container">${appH || '<div style="text-align:center; color:#ccc; font-size:14px; padding:20px;">暫無活躍記錄</div>'}</div>
            </div>

            <script>
                /**
                 * [v1.14.4-DEBUG] 深度診斷腳本
                 */
                const dbg = document.getElementById('debug-box');
                function logDebug(msg) {
                    if(!dbg) return;
                    if (msg.includes('ERROR:')) {
                        dbg.style.display = 'block';
                        dbg.innerHTML += '<div><span style="color:#ff5252">[' + new Date().toLocaleTimeString() + '] ' + msg + '</span></div>';
                    }
                    console.log('[DEBUG] ' + msg);
                }

                window.onerror = (msg, url, line) => {
                    logDebug('GLOBAL ERROR: ' + msg + ' at ' + line);
                };

                logDebug('腳本開始載入...');

                // [v1.17.4] 小助手對話隊列系統 (Mascot Dialogue Queue, MDQ)
                const MASCOT_CONFIG = {
                    QUEUE_LOCK_MS: 10000,   // 重要訊息保留 10 秒
                    IDLE_CHAT_INTERVAL_MS: 15 * 60 * 1000 // 15 分鐘自動閒聊
                };

                let mascotState = {
                    queue: [],
                    currentMsg: null,
                    lockUntil: 0,
                    lastActive: Date.now()
                };

                const CHAT_LIB = [
                    "案場進度還順利嗎？記得給自己三分鐘深呼吸喔 🌿",
                    "小添正在幫您守護進度，安心專注吧 💪",
                    "今天也是元氣滿滿的一天呢！✨",
                    "剛才的工作回報寫得很清楚喔，辛苦了！",
                    "喝杯熱咖啡或溫水吧，適度休息效率更高 ☕",
                    "目前的生產力節奏很穩健，繼續保持！",
                    "忙碌之餘，也要記得對自己微笑一下 😊",
                    "需要幫忙整理這週的報表嗎？小添隨時待命。",
                    "感覺現在的您專注力滿分！很有魅力呢 ✨",
                    "完成了這麼多項，您值得給自己一點小獎勵 🎁"
                ];

                function setMascotMsg(msg, priority = 3) {
                    const now = Date.now();
                    const b = document.getElementById('mascot-bubble');
                    if(!b) return;

                    mascotState.lastActive = now;

                    // 優先級定義: 1: 緊急(LINE), 2: 操作反饋, 3: 閒聊/狀態
                    const newMsg = { text: msg, priority: priority, ts: now };

                    // 邏輯:
                    // 1. 如果鎖定中，且新訊息優先級 <= 目前訊息，則加入隊列
                    // 2. 如果鎖定中，但新訊息是更高優先級 (如 LINE 蓋掉閒聊)，則直接中斷並顯示
                    // 3. 如果沒鎖定，直接顯示
                    
                    const isLocked = now < mascotState.lockUntil;
                    const isHigherPriority = mascotState.currentMsg && newMsg.priority < mascotState.currentMsg.priority;

                    if (isLocked && !isHigherPriority) {
                        mascotState.queue.push(newMsg);
                        // 隊列排序 (優先級高的在前)
                        mascotState.queue.sort((a,b) => a.priority - b.priority);
                        return;
                    }

                    _displayMascotUI(newMsg);
                }

                function _displayMascotUI(msgObj) {
                    const b = document.getElementById('mascot-bubble');
                    if(!b) return;

                    b.style.opacity = '0';
                    setTimeout(() => {
                        b.innerText = msgObj.text;
                        b.style.opacity = '1';
                    }, 300);

                    mascotState.currentMsg = msgObj;
                    // 如果是重要訊息 (優先級 1 或 2)，啟動保留鎖
                    if (msgObj.priority <= 2) {
                        mascotState.lockUntil = Date.now() + MASCOT_CONFIG.QUEUE_LOCK_MS;
                    } else {
                        mascotState.lockUntil = 0;
                    }
                }

                // 每秒檢查隊列與閒置狀態
                setInterval(() => {
                    const now = Date.now();
                    
                    // 1. 檢查鎖定是否過期，若過期則看是否有隊列待播
                    if (now >= mascotState.lockUntil && mascotState.queue.length > 0) {
                        const next = mascotState.queue.shift();
                        _displayMascotUI(next);
                    }

                    // 2. 閒聊計時器 (15 分鐘無訊息則主動出聲)
                    if (now - mascotState.lastActive >= MASCOT_CONFIG.IDLE_CHAT_INTERVAL_MS) {
                        const randomMsg = CHAT_LIB[Math.floor(Math.random() * CHAT_LIB.length)];
                        setMascotMsg(randomMsg, 3);
                    }
                }, 1000);

                function updateUI(d) {
                    try {
                        if (!d) { logDebug('updateUI 收到空數據'); return; }
                        logDebug('收到更新數據，版本:' + d.version);
                        
                        // 更新同步時間
                        const now = new Date();
                        const tsStr = now.getHours().toString().padStart(2, '0') + ':' + 
                                      now.getMinutes().toString().padStart(2, '0') + ':' + 
                                      now.getSeconds().toString().padStart(2, '0');
                        const tsEl = document.getElementById('sync-ts');
                        if (tsEl) tsEl.innerText = '最後更新: ' + tsStr;

                        // [v1.16.2] 即時更新 iCloud 燈號
                        const icStat = document.getElementById('icloud-status-bar');
                        if (icStat && d.icloudConnected !== undefined) {
                            const isOnline = d.icloudConnected;
                            const hasUrl = !!d.icloudUrl;
                            let s = '<span class="status-dot ' + (isOnline ? 'online' : 'offline') + '"></span>';
                            let t = isOnline ? 'iCloud 已連線' : (hasUrl ? 'iCloud 未連線' : '❌ iCloud 網址未設定');
                            icStat.innerHTML = s + ' ' + t;
                        }

                        // 更新核心三項數據
                        const sw = document.getElementById('stat-work');
                        const sl = document.getElementById('stat-leisure');
                        const so = document.getElementById('stat-other');
                        if(sw) sw.innerText = d.workTime;
                        if(sl) sl.innerText = d.leisureTime;
                        if(so) so.innerText = d.otherTime;

                        // 更新進度條
                        const r = d.productivityRate || 0;
                        const pf = document.getElementById('p-f');
                        const pt = document.getElementById('p-t');
                        if (pf) pf.style.width = r + '%';
                        if (pt) pt.innerText = '當前生產力：' + r + '%';

                        // [v1.18.2] 重要：更新打卡資訊 (防禦性更新，避免空資料洗掉樂觀時間)
                        const vct = document.getElementById('val-checkin-time');
                        const vot = document.getElementById('val-off-time');
                        if (d.workInfo && d.workInfo.checkinTime) {
                            if (vct) vct.innerText = d.workInfo.checkinTime;
                        }
                        if (d.workInfo && d.workInfo.expectedOffTime && d.workInfo.expectedOffTime !== '--:--') {
                            if (vot) vot.innerText = d.workInfo.expectedOffTime;
                        }

                        // [v26.03.04 Fix] 動態更新排行榜
                        const rankEl = document.getElementById('app-ranking-list');
                        if (rankEl && d.topApps && d.topApps.length > 0) {
                            let rh = '';
                            d.topApps.forEach((a, i) => {
                                const ts = a.duration_formatted || '0分';
                                rh += '<div class="app-row">';
                                rh += '<span style="color:#888; font-size:11px; width:25px;">' + (i+1) + '.</span>';
                                rh += '<span style="flex:1; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; font-size:13px; color:#5d4037;">' + a.app_name + '</span>';
                                rh += '<span style="font-weight:bold; color:#d35400; font-size:13px;">' + ts + '</span>';
                                rh += '</div>';
                            });
                            rankEl.innerHTML = rh;
                        }

                        // 渲染任務清單
                        const listEl = document.getElementById('t-l');
                        if (listEl) {
                            let h = '';
                            const rems = d.todayReminders || [];
                            const tasks = d.localTasks || [];
                            
                            // 數據過濾：過濾掉重複或無效數據
                            const allItems = [
                                ...rems.map(r => ({...r, type: 'rem'})),
                                ...tasks.map(t => ({...t, type: 'task', status: t.status.toLowerCase()}))
                            ];
                            
                            if (allItems.length > 0) {
                                document.getElementById('task-center-card').style.display = 'block';
                                
                                // [v1.16.7] 強化排序：未完成 (pending) 置頂，已完成 (completed) 沉底
                                allItems.sort((a, b) => {
                                    const aP = a.status === 'pending';
                                    const bP = b.status === 'pending';
                                    if (aP && !bP) return -1;
                                    if (!aP && bP) return 1;
                                    return 0;
                                });

                                allItems.forEach(item => {
                                    const isC = item.status === 'completed';
                                    h += '<div class="task-item ' + (isC ? 'completed' : '') + '" id="task-node-' + item.id + '">';
                                    
                                    // 視覺對齊：已完成顯示綠色打勾與灰色底色
                                    if (item.type === 'rem') {
                                        let titleH = '<div style="display:flex; flex-direction:column; gap:2px;">';
                                        titleH += '<span class="task-title" style="' + (isC ? 'color:#94a3b8;' : '') + '">' + (isC ? '✅' : (item.icon || '⏰')) + ' ' + item.title + (isC ? ' <span style="font-size:10px; color:#10b981; margin-left:5px;">(DONE)</span>' : '') + '</span>';
                                        if (item.message && !isC) {
                                            titleH += '<span style="font-size:11px; color:#64748b; margin-left:22px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; max-width:280px;" title="'+item.message+'">' + item.message + '</span>';
                                        }
                                        titleH += '</div>';
                                        h += titleH;
                                        h += isC ? '<button class="task-btn done" onclick="undoTask(event,\\''+item.id+'\\')">↺</button>' : '<button class="task-btn" onclick="completeTask(event,\\''+item.id+'\\',\\''+item.title+'\\')">✓</button>';
                                    } else {
                                        h += '<span class="task-title" style="' + (isC ? 'color:#94a3b8;' : '') + '">' + (isC ? '✅' : '📌') + ' ' + item.title + (isC ? ' <span style="font-size:10px; color:#10b981; margin-left:5px;">(DONE)</span>' : '') + '</span>';
                                        h += '<button class="task-btn ' + (isC ? 'done' : '') + '" onclick="toggleTask(event,'+item.id+',\\''+(isC?'pending':'completed')+'\\')">' + (isC ? '↺' : '✓') + '</button>';
                                    }
                                    h += '</div>';
                                });
                                listEl.innerHTML = h;
                            } else {
                                listEl.innerHTML = '<div style="text-align:center; color:#ccc; font-size:13px; padding:20px;">今日暫無待辦事項 ✨</div>';
                            }
                        }
                    } catch (ex) {
                        logDebug('updateUI 崩潰: ' + ex.message);
                    }
                }

                async function doCheckin(e) {
                    if (e) e.stopPropagation();
                    logDebug('點擊打卡按鈕');
                    const btn = document.getElementById('checkin-btn');
                    if (btn) { 
                        btn.disabled = true; 
                        btn.innerHTML = '⏳ 打卡傳送中...'; 
                    }
                    
                    // [v1.14.4] 計畫對齊：點擊瞬間氣泡播報
                    setMascotMsg('正在為您打卡...🚀');

                    try {
                        const r = await window.reminderAPI.directCheckin();
                        if (r && r.success) {
                            setMascotMsg('打卡成功！✨ 辛苦了，又是活力滿滿的一天。', 2);
                            if (btn) {
                                btn.innerHTML = '✨ 打卡成功';
                            }
                        } else {
                            setMascotMsg('糟糕，打卡失敗了：' + (r?r.message:'伺服器未回應'), 2);
                            if (btn) { btn.disabled = false; btn.innerHTML = '✅ 打卡'; }
                        }
                        
                        // [v1.18.4] 統一於此處恢復按鈕並刷新，移除重複定義
                        setTimeout(() => {
                            if (btn) {
                                btn.disabled = false;
                                btn.innerHTML = '✅ 打卡';
                            }
                            window.reminderAPI.refreshStats({ isManual: false });
                        }, 3000);
                        
                    } catch (ex) {
                        logDebug('打卡出錯: ' + ex.message);
                        if (btn) { btn.disabled = false; btn.innerHTML = '✅ 打卡'; }
                    }
                }

                async function toggleTask(e,id,s) { 
                    setMascotMsg((s.toLowerCase() === 'completed') ? '又解決了一件待辦，做得好！✨' : '已為您把任務重新標記為待處理。');
                    await window.reminderAPI.updateLocalTask(id, s); 
                    window.reminderAPI.refreshStats({isManual:true}); 
                }
                async function undoTask(e,id) { 
                    setMascotMsg('任務已撤銷，隨時可以再次挑戰！🚀');
                    // [v1.16.4] 撤銷樂觀更新
                    const node = document.getElementById('task-node-' + id);
                    if (node) {
                        node.classList.remove('completed');
                        const btn = node.querySelector('.task-btn');
                        if (btn) btn.innerHTML = '✓';
                    }
                    await window.reminderAPI.undo(id); 
                    window.reminderAPI.refreshStats({isManual:true}); 
                }
                const SUCCESS_GREETINGS = [
                    '太棒了！又完成了一項：「{t}」🎉',
                    '漂亮！「{t}」已解決，您真是進度殺手 💪',
                    '「{t}」達成！離今天的全點亮目標又近了一步 ✨',
                    '做得好！「{t}」順利完成，要稍微喝口水休息一下嗎？☕',
                    '神級效率！「{t}」完成，今天的工作節奏太讚了 📈',
                    '又解決了一件麻煩事：「{t}」，感覺空氣都清新了點 😊'
                ];

                async function completeTask(e,id,t) { 
                    const randomGreet = SUCCESS_GREETINGS[Math.floor(Math.random() * SUCCESS_GREETINGS.length)]
                        .replace('{t}', t);
                    setMascotMsg(randomGreet);
                    
                    // [v1.16.3] 樂觀更新：立即變更樣式，消滅反應遲鈍感
                    const node = document.getElementById('task-node-' + id);
                    if (node) {
                        node.classList.add('completed');
                        const btn = node.querySelector('.task-btn');
                        if (btn) btn.innerHTML = '↺'; 
                    }
                    await window.reminderAPI.complete(id); 
                    window.reminderAPI.refreshStats({isManual:true}); 
                }

                window.onload = () => {
                    logDebug('視窗載入完成 (window.onload)');
                    if (window.reminderAPI) {
                        logDebug('reminderAPI 已就緒');
                        window.reminderAPI.onUpdateStats((d) => updateUI(d));
                        
                        // [v1.15.8] 監聽提醒狀態主動刷新 (修復點擊已完成不轉跳問題)
                        if (window.reminderAPI.onReminderStatusUpdated) {
                            window.reminderAPI.onReminderStatusUpdated((id) => {
                                logDebug('收到提醒狀態變動信號: ' + id);
                                window.reminderAPI.refreshStats({ isManual: false });
                            });
                        }

                        // [v1.17.4] 監聽小助手對話推送 (MDQ 串接)
                        if (window.reminderAPI.onPushMascotMsg) {
                            window.reminderAPI.onPushMascotMsg((d) => {
                                setMascotMsg(d.text, d.priority);
                            });
                        }

                         // [v1.16.4] 強化定時器：增加安全保護與日誌發送
                         setInterval(() => {
                             try {
                                 logDebug('執行 60s 定時同步');
                                 window.reminderAPI.refreshStats({ isManual: false });
                             } catch (e) {
                                 logDebug('定時重新整理出錯: ' + e.message);
                             }
                         }, 60000);

                        // [v1.18.4] 監聽里程碑達成
                        if (window.reminderAPI.onMilestoneReached) {
                            window.reminderAPI.onMilestoneReached((d) => {
                                logDebug('達成里程碑: ' + d.count);
                                setMascotMsg(d.icon + ' ' + d.message, 2); // 優先級 2: 操作反饋
                            });
                        }
                        
                        // 初始刷新
                        setTimeout(() => window.reminderAPI.refreshStats({ isManual: true }), 1000);
                    } else {
                        logDebug('錯誤: 找不到 reminderAPI (preload 可能失效)');
                    }
                };
            </script>
        </body>
        </html>`;
    }

    formatMinutes(m) { m = Math.round(m || 0); if (!m) return '0分'; if (m < 60) return m + '分'; return Math.floor(m / 60) + 'h ' + (m % 60) + 'm'; }
}

module.exports = { MonitorService };
