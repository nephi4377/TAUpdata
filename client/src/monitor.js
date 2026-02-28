// v1.7 - 2026-02-02 10:13 (Asia/Taipei)
// 修改內容: 改用置頂小視窗取代系統通知

const { Notification, dialog, powerMonitor, BrowserWindow, screen, app } = require('electron');
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
        this.workAlertLevels = [
            { minutes: 60, shown: false, icon: '☕', title: '喝杯水吧', message: '你已經專注工作 1 小時了！', detail: '記得喝口水、讓眼睛休息一下 😊' },
            { minutes: 120, shown: false, icon: '🚶', title: '起來走走', message: '哇！已經連續工作 2 小時了', detail: '起來伸展一下，活動筋骨吧！\n短暫休息能讓你更有效率 💪' },
            { minutes: 180, shown: false, icon: '🌿', title: '休息一下吧', message: '太認真了！已經工作 3 小時', detail: '辛苦了！建議休息 10-15 分鐘\n去外面走走、吃點東西 🍵' },
            { minutes: 240, shown: false, icon: '💆', title: '該好好休息了', message: '連續工作 4 小時，真的很棒！', detail: '但身體需要休息才能繼續奮鬥\n請放下工作，好好放鬆一下 ❤️' },
            { minutes: 270, shown: false, icon: '🛑', title: '休息是為了走更長的路', message: '已經連續工作 4.5 小時了', detail: '你的健康比什麼都重要！\n請務必休息後再繼續 🙏' }
        ];


        console.log('[Monitor] 監測服務已建立');
    }


    // 啟動監測
    async start() {
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

        // 設定定時取樣
        this.sampleTimer = setInterval(async () => {
            await this.sample();
        }, this.sampleInterval);
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

    // [v1.6] 從資料庫恢復今日已產生的統計數據
    async _restoreTodayStats() {
        try {
            console.log('[Monitor] 正在嘗試從資料庫恢復今日數據...');
            const stats = await this.storageService.getTodayTotalSeconds();

            // 恢復工作時間 (work + other)
            this.currentWorkSeconds = stats.work + stats.other;

            // 恢復休閒時間
            this.currentLeisureSeconds = stats.leisure;

            // 由於重啟，視為觸發過一次休閒冷卻，避免重啟後立刻彈窗 (除非再次超過閾值)
            if (this.currentLeisureSeconds >= this.leisureAlertThreshold) {
                this.leisureAlertShown = true;
            }

            console.log(`[Monitor] 數據恢復成功: 工作 ${Math.floor(this.currentWorkSeconds / 60)}分, 休閒 ${Math.floor(this.currentLeisureSeconds / 60)}分`);
        } catch (error) {
            console.error('[Monitor] 數據恢復失敗:', error.message);
        }
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
            const now = new Date();

            // 檢查午休時間
            if (this.isLunchBreak()) {
                await this.storageService.recordActivity({
                    timestamp: now,
                    appName: '午休時間',
                    windowTitle: '',
                    durationSeconds: this.sampleInterval / 1000,
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
                    durationSeconds: this.sampleInterval / 1000,
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

            // 計算時間差（秒）
            let durationSeconds = this.sampleInterval / 1000;
            if (this.lastSampleTime) {
                durationSeconds = Math.round((now - this.lastSampleTime) / 1000);
                if (durationSeconds > 60) {
                    durationSeconds = this.sampleInterval / 1000;
                }
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

            // 根據分類處理警示
            if (category === 'leisure') {
                // 休閒：累計休閒時間，重設非休閒計時
                this.nonLeisureSeconds = 0;
                this.checkLeisureAlert(appName, windowTitle, durationSeconds);
                // 改為在觸發休閒警示時才重置工作追踪，允許短暫休息
            } else {
                // 工作或其他：累計工作時間
                // 需要連續 30 秒以上才重置休閒計時
                this.nonLeisureSeconds += durationSeconds;

                if (this.nonLeisureSeconds >= this.leisureResetThreshold) {
                    // 超過 30 秒非休閒才真正重置休閒追蹤
                    if (this.currentLeisureSeconds > 0) {
                        console.log(`[Monitor] 非休閒超過 ${this.leisureResetThreshold} 秒，重設休閒累計`);
                    }
                    this.resetLeisureTracking();
                }

                // 工作和其他都累計工作時間
                this.checkWorkAlert(durationSeconds);
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
        this.currentWorkSeconds += durationSeconds;
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

        // 隨機選取小秘書裝束
        const config = this.classifierService.configManager;
        const gender = config.get('mascotGender') || 'female';
        let fname = 'secretary.png';
        if (gender === 'female') {
            const skins = ['default', 'blizzard', 'thunder', 'boulder', 'sacred', 'prism'];
            const randomSkin = skins[Math.floor(Math.random() * skins.length)];
            fname = randomSkin === 'default' ? 'secretary.png' : `secretary_${randomSkin}.png`;
        } else {
            fname = 'secretary_male.png';
        }

        // 檢查本地快取
        const cacheDir = path.join(app.getPath('userData'), 'mascot_cache');
        const localFilePath = path.join(cacheDir, fname);
        const mascotUrl = fs.existsSync(localFilePath)
            ? `file://${localFilePath.replace(/\\/g, '/')}`
            : `https://raw.githubusercontent.com/nephi4377/TAUpdata/master/client/assets/${fname}`;

        const primaryDisplay = screen.getPrimaryDisplay();
        const { width: screenWidth, height: screenHeight } = primaryDisplay.workAreaSize;
        const windowWidth = 420;
        const windowHeight = 120;
        const margin = 20;
        const x = margin;
        const y = screenHeight - windowHeight - margin;

        const html = `<!DOCTYPE html><html><head><meta charset="UTF-8"><style>
            * { margin:0; padding:0; box-sizing:border-box; font-family:sans-serif; }
            body { background: rgba(26, 26, 46, 0.98); color:#fff; border-radius:15px; padding:12px; border:1px solid rgba(78,205,196,0.5); box-shadow:0 8px 32px rgba(0,0,0,0.5); height:120px; display:flex; align-items:center; overflow:hidden; }
            .mascot { width:70px; height:95px; background:url('${mascotUrl}') center/cover; border-radius:8px; border:1px solid #4ecdc4; flex-shrink:0; margin-right:15px; }
            .content { flex:1; display:flex; flex-direction:column; justify-content:center; }
            .title { font-size:15px; font-weight:bold; margin-bottom:5px; color:#4ecdc4; }
            .body { font-size:12px; color:#ddd; line-height:1.5; white-space:pre-wrap; }
        </style></head><body><div class="mascot"></div><div class="content"><div class="title">${this.escapeHtml(title)}</div><div class="body">${this.escapeHtml(body)}</div></div></body></html>`;

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

    // [v2026.02 移除] 根據使用者需求停止心跳回報
    /*
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
        if (this.checkinService) {
            const status = (this.lastCategory === 'idle' || this.lastCategory === 'lunch_break') ? 'idle' : 'work';

            // 避免在完全沒有資料時發送 (剛啟動)
            if (!this.lastAppName && !this.lastWindowTitle) return;

            try {
                // 使用 lastAppName 而非 currentApp，因為 last* 是最近一次 sample 的結果
                await this.checkinService.sendHeartbeat(status, this.lastAppName, this.lastWindowTitle);
            } catch (e) {
                console.error('[Monitor] Heartbeat failed:', e.message);
            }
        }
    }
    */
}

module.exports = { MonitorService };
