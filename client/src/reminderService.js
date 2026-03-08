// v1.1 - 2026-02-14 16:00 (Asia/Taipei)
// 修改內容: 提醒加入「完成/稍後」按鈕、狀態追蹤、報告整合

const { BrowserWindow, screen, ipcMain, app } = require('electron');
const path = require('path');
const fs = require('fs');

// [v1.12.0 API] 提醒管家已純化：僅負責 UI 渲染與排程，不處理網路解析。

class ReminderService {
    constructor(configManager, monitorService, apiBridge) {
        this.config = configManager;
        this.monitorService = monitorService;
        this.apiBridge = apiBridge;
        this.timers = [];
        this.reminderWindow = null;

        // 今日提醒狀態追蹤
        // { reminderId: { status: 'pending'|'completed'|'snoozed', completedAt: Date, snoozeCount: 0 } }
        this.todayStatus = {};

        // [v1.18.0] 提醒氣泡隊列系統 (Single Bubble Queue)
        this.reminderQueue = [];
        this.isShowingReminder = false;
        this.queueGapMs = 2000; // 氣泡間隔 2 秒

        // 提醒規則定義
        this.reminders = [
            // ═══ 每日提醒 ═══
            {
                id: 'checkin_reminder',
                icon: '⏰',
                title: '打卡提醒',
                message: '您今天尚未打卡，請記得使用 LINE 打卡！',
                timeWindow: { start: '08:25' },
                frequency: 'daily',
                condition: 'not_checked_in'
            },
            {
                id: 'site_arrangement',
                icon: '🏠',
                title: '確認工地安排',
                message: '確認今日與明日工地巡檢排程，掌握各工地施工階段。',
                timeWindow: { start: '09:00', end: '09:30' },
                frequency: 'daily'
            },
            {
                id: 'client_msg_1',
                icon: '📨',
                title: '確認客戶訊息(上午)',
                message: '確認客戶/業主訊息是否已回覆，不要讓客戶等太久！',
                timeWindow: { start: '09:30', end: '10:30' },
                frequency: 'daily'
            },
            {
                id: 'site_photo_report',
                icon: '📸',
                title: '施工照片回報客戶',
                message: '記得傳今日施工照片給客戶，附上施工進度說明。',
                timeWindow: { start: '10:30', end: '11:30' },
                frequency: 'daily'
            },
            {
                id: 'client_msg_2',
                icon: '📨',
                title: '確認客戶訊息(下午)',
                message: '下午了，再確認一次客戶訊息有沒有漏回的。',
                timeWindow: { start: '14:00', end: '15:00' },
                frequency: 'daily'
            },
            {
                id: 'daily_report',
                icon: '📊',
                title: '今日工作回報',
                message: '今日工作回報完成了嗎？快點記錄今天的進度！',
                timeWindow: { beforeOff: 30 },
                frequency: 'daily'
            },

            // ═══ 下班前提醒 ═══
            {
                id: 'tomorrow_site_arrangement',
                icon: '📋',
                title: '確認明日工地安排',
                message: '確認明日工地巡檢與師傅排程，提前通知相關人員。',
                timeWindow: { beforeOff: 60 },
                frequency: 'daily'
            },

            // ═══ 每週固定提醒 ═══
            {
                id: 'recurring_pending',
                icon: '📑',
                title: '追蹤未結案件',
                message: '固定追蹤未結案/收尾案件進度，確保案件準時推進。',
                timeWindow: { start: '10:00', end: '11:00' },
                frequency: 'weekly',
                dayOfWeek: 1
            },
            {
                id: 'friday_next_week',
                icon: '📅',
                title: '確認下週排程',
                message: '確認下週排程安排，提前通知各工地師傅。',
                timeWindow: { start: '15:00', end: '16:00' },
                frequency: 'weekly',
                dayOfWeek: 5
            }
        ];

        // ═══ 未結案追蹤 (週二/四/六) [v26.03.04 計劃書對齊] ═══
        const openCaseDays = [
            { day: 2, label: '週二' },
            { day: 4, label: '週四' },
            { day: 6, label: '週六' }
        ];
        openCaseDays.forEach(d => {
            this.reminders.push({
                id: `open_case_${d.label}`,
                icon: '📑',
                title: '追蹤未結案件',
                message: `${d.label}固定追蹤：檢查未結案/收尾案件進度，確保案件準時推進。`,
                timeWindow: { start: '10:00', end: '11:00' },
                frequency: 'weekly',
                dayOfWeek: d.day
            });
        });

        // 註冊 IPC 事件（提醒視窗的「完成」和「稍後」按鈕）
        this._registerIpcHandlers();

        // [v4.0 批次同步器] 統一由 TaskCenter API 負責 (開發中，暫時靜默)
        // setInterval(() => this.taskCenter && this.taskCenter.sync(), 30 * 60 * 1000);

        console.log('[Reminder] 智慧提醒服務已建立');
    }

    // [v4.0 已廢棄，功能遷移至 TaskCenterService]
    // async _syncPendingTasksToGas() { ... }

    // 註冊 IPC 處理器
    _registerIpcHandlers() {
        // 避免重複註冊
        ipcMain.removeHandler('reminder-complete');
        ipcMain.removeHandler('reminder-snooze');

        ipcMain.handle('reminder-complete', (event, reminderId) => {
            console.log(`[Reminder] ✅ 已完成: ${reminderId}`);
            try {
                // [v1.17.2] 合併更新：保留 isIcloud、title 等原始屬性
                if (!this.todayStatus[reminderId]) {
                    this.todayStatus[reminderId] = {};
                }
                this.todayStatus[reminderId].status = 'completed';
                this.todayStatus[reminderId].completedAt = new Date().toISOString();
                this._saveReminderHistory(reminderId);
                this._saveTodayStatus();

                const win = BrowserWindow.fromWebContents(event.sender);
                if (win && !win.isDestroyed()) {
                    const title = win.getTitle();
                    const bounds = win.getBounds();

                    // [v1.17.5 Fix] 強化判定：提醒視窗寬度固定 400，且不含統計中心關鍵字
                    const isToast = bounds.width === 400 &&
                        !title.includes('詳細統計') &&
                        !title.includes('報表中心') &&
                        !title.includes('統計中心');

                    if (isToast) {
                        console.log('[Reminder] 強制關閉氣泡視窗');
                        win.close();
                    } else {
                        win.webContents.send('reminder-status-updated', reminderId);
                    }
                }

                // [v26.03.04 Fix] 保底關閉：即使 fromWebContents 返回 null 也能關閉
                this._closeReminderWindow();

                // [v1.17.2] 觸發里程碑鼓勵檢查
                this._checkMilestoneEncouragement();

                // [v1.15.8] 通知統計中心刷新
                this._notifyStatusUpdated(reminderId);

                return { success: true };
            } catch (err) {
                console.error('[Reminder] 完成操作失敗:', err);
                return { success: false, error: err.message };
            }
        });

        ipcMain.handle('reminder-undo', (event, reminderId) => {
            console.log(`[Reminder] ↺ 撤銷完成: ${reminderId}`);
            try {
                if (this.todayStatus[reminderId]) {
                    this.todayStatus[reminderId].status = 'pending';
                    this.todayStatus[reminderId].completedAt = null;
                    this._saveTodayStatus();
                }
                return { success: true };
            } catch (err) {
                console.error('[Reminder] 撤銷操作失敗:', err);
                return { success: false, error: err.message };
            }
        });

        ipcMain.handle('reminder-snooze', (event, reminderId) => {
            console.log(`[Reminder] ⏰ 稍後再提醒: ${reminderId}`);
            try {
                const current = this.todayStatus[reminderId] || {};
                const snoozeCount = (current.snoozeCount || 0) + 1;
                // [v26.03.04 Fix] 合併更新：保留 isIcloud、title 等原始屬性
                this.todayStatus[reminderId] = {
                    ...current,
                    status: 'snoozed',
                    snoozeCount
                };
                // [v1.2] 儲存今日狀態
                this._saveTodayStatus();

                // 強制關閉發送該 IPC 請求的視窗（解決孤兒視窗無法關閉的問題）
                const win = BrowserWindow.fromWebContents(event.sender);
                if (win && !win.isDestroyed()) {
                    const title = win.getTitle();
                    if (!title.includes('添心生產力助手 - 詳細統計') && !title.includes('管理員報表中心') && !title.includes('添心統計中心')) {
                        win.close();
                    }
                }

                if (this.reminderWindow === win) {
                    this.reminderWindow = null;
                }

                // [v26.03.04 Fix] 保底關閉：確保提醒視窗一定被關閉
                this._closeReminderWindow();

                // [v26.03.04 Fix] 已移除錯誤邏輯：snooze 不應將任務標記為 completed

                // 20 分鐘後再提醒 (iCloud/系統提醒)
                const reminder = this.reminders.find(r => r.id === reminderId);
                if (reminder) {
                    const timer = setTimeout(() => {
                        // 如果還沒完成，再次提醒
                        if (this.todayStatus[reminderId]?.status !== 'completed') {
                            this.fireReminder(reminder, this._formatDate(new Date()));
                        }
                    }, 20 * 60 * 1000);
                    this.timers.push(timer);
                    console.log(`[Reminder] ${reminderId} 將在 20 分鐘後再次提醒`);
                }
                return { success: true };
            } catch (err) {
                console.error('[Reminder] 稍後提醒操作失敗:', err);
                return { success: false, error: err.message };
            }
        });

        ipcMain.handle('reminder-close', (event) => {
            console.log('[Reminder] 收到前端關閉請求');
            const win = BrowserWindow.fromWebContents(event.sender);
            if (win && !win.isDestroyed()) {
                win.close();
            }
            if (this.reminderWindow === win) {
                this.reminderWindow = null;
            }
            return { success: true };
        });
    }

    // [v1.11.0] 初始化本機提醒掃描
    _initLocalReminderCheck() {
        console.log('[Reminder] 啟動本機自訂提醒定時掃描 (1分鐘/次)');
        const timer = setInterval(() => {
            this.checkDailyReset(); // [v26.03.04] 優先檢查是否跨日
            this._checkLocalReminders();
        }, 60 * 1000);
        this.timers.push(timer);
        this.checkDailyReset();
        this._checkLocalReminders();
    }

    // [v1.11.1] 檢查本機提醒事項 (含提前與重複)
    async _checkLocalReminders() {
        try {
            const now = new Date();
            const todayStr = this._formatDate(now);
            const currentTimeMin = now.getHours() * 60 + now.getMinutes();

            // 凌晨 00:00 重置今日重複任務 (每天只重置一次)
            if (now.getHours() === 0 && now.getMinutes() === 0) {
                if (!this._lastResetDate || this._lastResetDate !== todayStr) {
                    console.log('[Reminder] 凌晨重置重複任務狀態');
                    this.monitorService.storageService.resetRepeatingTasks(todayStr);
                    this._lastResetDate = todayStr;
                }
            }


            const tasks = this.monitorService.storageService.getLocalTasks();
            for (const task of tasks) {
                if (task.status === 'completed') continue;

                // [v1.11.24] 模式 1: 緊急指令 (Emergency/Priority) - 每 20 分鐘強力彈窗一次
                if (task.priority_mode === 'emergency') {
                    const lastSent = task.last_reminder_at ? new Date(task.last_reminder_at) : new Date(0);
                    const diffMin = (now - lastSent) / 60000;
                    if (diffMin >= 20) {
                        this.fireReminder({
                            id: task.id,
                            icon: '🚨',
                            title: `【緊急交辦】${task.title}`,
                            message: `這是最高優先級任務，請務必處理！\n（本提醒將每 20 分鐘出現一次，直到完成）`
                        }, todayStr);
                        // 更新最後發送時間 (此處我們暫借用 reminder_sent 邏輯，但為了週期性，需更新資料庫時間)
                        this.monitorService.storageService.db.run(`UPDATE local_tasks SET last_reminder_at = ? WHERE id = ?`, [now.toISOString(), task.id]);
                    }
                    continue; // 緊急模式獨立處理，不走一般排程
                }

                // 模式 2: 一般定時任務 (含限時倒數)
                if (task.reminder_sent === 1) continue;
                if (!task.due_date || !task.due_time) continue;

                const isToday = (task.due_date === todayStr);
                const isDaily = (task.repeat_type === 'daily');
                // ... (其餘邏輯保持)
                const isWeekly = (task.repeat_type === 'weekly' && now.getDay() === new Date(task.due_date).getDay());

                if (isToday || isDaily || isWeekly) {
                    const [h, m] = task.due_time.split(':').map(Number);
                    const targetTimeMin = h * 60 + m;
                    const leadMin = task.reminder_lead_minutes || 0;

                    if (currentTimeMin >= (targetTimeMin - leadMin)) {
                        const isEarly = (currentTimeMin < targetTimeMin);
                        const label = isEarly ? `【提前 ${leadMin} 分鐘提醒】` : '【正式提醒】';

                        this.fireReminder({
                            id: task.id,
                            icon: '📌',
                            title: label + task.title,
                            message: `時間: ${task.due_time}\n${task.repeat_type !== 'none' ? '週期: ' + task.repeat_type : ''}`
                        }, todayStr);

                        this.monitorService.storageService.updateReminderSent(task.id);
                    }
                }
            }
        } catch (err) {
            console.error('[Reminder] 掃描本機提醒失敗:', err);
        }
    }

    // 啟動提醒排程
    start() {
        console.log('[Reminder] 啟動今日提醒排程...');
        const now = new Date();
        const today = now.getDay();
        const todayStr = this._formatDate(now);

        // [v1.2] 恢復今日狀態
        this._loadTodayStatus(todayStr);

        // 取得下班時間資訊
        const workInfo = this.config.getTodayWorkInfo();
        const boundEmployee = this.config.getBoundEmployee();

        // 計算員工的上班/下班時間
        let shiftStartMinutes = 8 * 60 + 30;
        let shiftEndMinutes = 17 * 60 + 30;
        let offTimeMinutes = shiftEndMinutes;

        if (boundEmployee) {
            if (boundEmployee.shiftStart) {
                const [h, m] = boundEmployee.shiftStart.split(':').map(Number);
                shiftStartMinutes = h * 60 + m;
            }
            if (boundEmployee.shiftEnd) {
                const [h, m] = boundEmployee.shiftEnd.split(':').map(Number);
                shiftEndMinutes = h * 60 + m;
            }
        }

        if (workInfo && workInfo.expectedOffTime) {
            const [h, m] = workInfo.expectedOffTime.split(':').map(Number);
            offTimeMinutes = h * 60 + m;
        } else {
            offTimeMinutes = shiftEndMinutes;
        }

        // [v1.2] 恢復今日狀態 (如果存檔日期是今天，會填充 this.todayStatus)
        this.todayStatus = this.todayStatus || {};
        const hasLoaded = this._loadTodayStatus(todayStr);

        // 取得已儲存的提醒紀錄
        const reminderHistory = this.config.get('reminderHistory') || {};

        // [v1.11.0] 啟動本機提醒定時巡檢
        this._initLocalReminderCheck();

        // 初始化今日狀態並進行排程
        let scheduledCount = 0;
        for (const reminder of this.reminders) {
            if (!this.shouldTriggerToday(reminder, today, todayStr, reminderHistory)) {
                continue;
            }

            // [v1.2] 標記為待完成 (如果狀態中尚無該項目)
            if (!this.todayStatus[reminder.id]) {
                this.todayStatus[reminder.id] = { status: 'pending' };
            }

            // 如果該提醒今日已完成，則跳過排程，避免重複彈窗
            if (this.todayStatus[reminder.id].status === 'completed') {
                console.log(`[Reminder] ${reminder.id} 今日已完成，不重新排程`);
                continue;
            }

            // 計算觸發時間
            let triggerTime = this.calculateTriggerTime(reminder, now, shiftStartMinutes, offTimeMinutes);
            if (!triggerTime) continue;

            // 如果觸發時間已過
            if (triggerTime <= now) {
                // 特殊規則：打卡提醒 (checkin_reminder) 即使過期也要補彈！
                if (reminder.id === 'checkin_reminder') {
                    const workInfo = this.config.getTodayWorkInfo();
                    const isCheckedIn = workInfo && workInfo.checkedIn;
                    if (!isCheckedIn) {
                        console.log('[Reminder] 偵測到尚未打卡，準備執行 10s 補彈提醒...');
                        triggerTime = new Date(now.getTime() + 10000); // 10秒後補彈
                    } else {
                        continue;
                    }
                } else {
                    continue;
                }
            }

            // 設定計時器
            const delayMs = Math.max(0, triggerTime.getTime() - now.getTime());
            const timer = setTimeout(() => {
                this.fireReminder(reminder, todayStr);
            }, delayMs);

            this.timers.push(timer);
            scheduledCount++;

            const triggerTimeStr = `${String(triggerTime.getHours()).padStart(2, '0')}:${String(triggerTime.getMinutes()).padStart(2, '0')}`;
            console.log(`[Reminder] 已排程: ${reminder.icon} ${reminder.title} → ${triggerTimeStr}`);
        }

        console.log(`[Reminder] 今日共排程 ${scheduledCount} 個提醒，待完成 ${Object.keys(this.todayStatus).length} 項`);
    }

    // 判斷是否應在今天觸發（不限制週末，因為室內裝修業經常週六上班）
    shouldTriggerToday(reminder, dayOfWeek, todayStr, history) {

        switch (reminder.frequency) {
            case 'daily':
                return true;

            case 'weekly':
                return dayOfWeek === reminder.dayOfWeek;

            case 'random_days': {
                const lastShown = history[reminder.id];
                if (!lastShown) return true;

                const lastDate = new Date(lastShown);
                const today = new Date(todayStr);
                const diffDays = Math.floor((today - lastDate) / 86400000);

                if (reminder.holidayBoost) {
                    const yesterday = new Date(today);
                    yesterday.setDate(yesterday.getDate() - 1);
                    const yesterdayDay = yesterday.getDay();
                    if (yesterdayDay === 0 || yesterdayDay === 6) {
                        return Math.random() < 0.9;
                    }
                }

                if (diffDays >= reminder.frequencyDays.max) return true;
                if (diffDays < reminder.frequencyDays.min) return false;
                return Math.random() < 0.5;
            }

            default:
                return true;
        }
    }

    // 計算觸發時間
    calculateTriggerTime(reminder, now, shiftStartMinutes, offTimeMinutes) {
        const tw = reminder.timeWindow;
        // [v1.17.1] 防禦性設計：iCloud 動態提醒無 timeWindow，直接返回 null
        if (!tw) return null;
        let startMinutes, endMinutes;

        if (tw.start && tw.end) {
            const [sh, sm] = tw.start.split(':').map(Number);
            const [eh, em] = tw.end.split(':').map(Number);
            startMinutes = sh * 60 + sm;
            endMinutes = eh * 60 + em;
        } else if (tw.start && !tw.end) {
            // [v1.17.1] 僅有 start 的 timeWindow (如打卡提醒)：預設 15 分鐘視窗
            const [sh, sm] = tw.start.split(':').map(Number);
            startMinutes = sh * 60 + sm;
            endMinutes = startMinutes + 15;
        } else if (tw.startOffset !== undefined) {
            startMinutes = shiftStartMinutes + tw.startOffset;
            endMinutes = startMinutes + 15;
        } else if (tw.beforeOff !== undefined) {
            startMinutes = offTimeMinutes - tw.beforeOff;
            endMinutes = startMinutes + 15;
        } else {
            return null;
        }

        const randomMinutes = startMinutes + Math.floor(Math.random() * (endMinutes - startMinutes));

        const triggerTime = new Date(now);
        triggerTime.setHours(Math.floor(randomMinutes / 60), randomMinutes % 60, 0, 0);

        return triggerTime;
    }

    // 觸發提醒
    fireReminder(reminder, todayStr) {
        console.log(`[Reminder] 觸發提醒: ${reminder.icon} ${reminder.title}`);

        // [v1.17.3] 支援帶有 message 的外部提醒
        const reminderId = reminder.id;
        const currentStatus = this.todayStatus[reminderId] || { status: 'pending' };

        // 如果已完成，不再提醒
        if (currentStatus.status === 'completed') {
            console.log(`[Reminder] ${reminderId} 已完成，跳過`);
            return;
        }

        // [v26.03.04 Fix] 強化打卡判定：只要有打卡時間（即使 backend 旗標未同步），亦自動完成任務
        if (reminder.condition === 'not_checked_in') {
            const workInfo = this.config.getTodayWorkInfo();
            const isActuallyCheckedIn = workInfo && (workInfo.checkedIn || (workInfo.checkinTime && workInfo.checkinTime !== '--:--'));

            if (isActuallyCheckedIn) {
                console.log('[Reminder] 偵測到已有打卡記錄，自動標記提醒任務為 Done');
                this.todayStatus[reminderId] = {
                    ...currentStatus,
                    status: 'completed',
                    completedAt: new Date().toISOString(),
                    autoCompleted: true
                };
                this._saveTodayStatus();
                this._notifyStatusUpdated(reminderId);
                return;
            }
        }

        // [v1.18.0] 改為排隊模式，避免一次噴出多個氣泡
        this.reminderQueue.push(reminder);
        this.processQueue();
    }

    /**
     * [v1.18.0] 處理提醒隊列
     */
    processQueue() {
        if (this.isShowingReminder || this.reminderQueue.length === 0) return;

        console.log(`[Reminder] 隊列處理中... 剩餘: ${this.reminderQueue.length}`);
        const reminder = this.reminderQueue.shift();
        this.isShowingReminder = true;
        this.showReminderToast(reminder);
    }

    /**
     * [v26.03.04 計劃書對齊] 取得秘書頭像 URL（與統計中心當日換裝同步）
     */
    _getMascotUrl() {
        const gender = this.config.getMascotGender() || 'female';
        const skin = this.config.getMascotSkin() || 'default';

        let fname;
        if (gender === 'female' && skin !== 'default') {
            fname = `secretary_${skin}.png`;
        } else if (gender === 'female') {
            fname = 'secretary.png';
        } else {
            fname = 'secretary_male.png';
        }

        // 優先使用本地快取的 base64（與統計中心頭像完全一致）
        const localAssetPath = path.join(__dirname, '..', 'assets', fname);
        const cacheDir = path.join(app.getPath('userData'), 'mascot_cache');
        const cachedPath = path.join(cacheDir, fname);
        const imgPath = fs.existsSync(cachedPath) ? cachedPath : (fs.existsSync(localAssetPath) ? localAssetPath : null);

        if (imgPath) {
            try {
                const imgBuffer = fs.readFileSync(imgPath);
                return `data:image/png;base64,${imgBuffer.toString('base64')}`;
            } catch (e) {
                console.warn('[Reminder] 頭像讀取失敗:', e.message);
            }
        }

        // 降級：遠端 URL
        return `https://raw.githubusercontent.com/nephi4377/TAUpdata/master/client/assets/${fname}`;
    }

    /**
     * [v1.12.0 API] 渲染提醒視窗 HTML 模板 (核心穩定 API)
     * 之後若無重大 UI 改版，請勿變動此結構。
     */
    _renderReminderHtml(reminder, mascotUrl, snoozeLabel, messageHtml) {
        return `
    <!DOCTYPE html>
    <html>
        <head>
            <meta charset="UTF-8">
            <style>
                * { box-sizing: border-box; }
                html, body {
                    margin: 0; padding: 0; overflow: hidden;
                    font-family: "Microsoft JhengHei", "Segoe UI", sans-serif;
                    background: transparent !important;
                }
                .toast {
                    background: #ffffff; 
                    border: 1px solid #f0f4f4; 
                    border-left: 6px solid #e67e22;
                    border-radius: 18px; 
                    padding: 24px;
                    color: #2c3e50; 
                    box-shadow: 0 4px 20px rgba(0,0,0,0.03);
                    height: 100vh;
                    display: flex;
                    flex-direction: column;
                    position: relative;
                    animation: slideIn 0.5s cubic-bezier(0.18, 0.89, 0.32, 1.28);
                }
                @keyframes slideIn {
                    from {transform: translateX(-110%); opacity: 0; }
                    to {transform: translateX(0); opacity: 1; }
                }
                .close-x {
                    position: absolute;
                    top: 14px;
                    right: 16px;
                    font-size: 22px;
                    color: #d7ccc8;
                    cursor: pointer;
                    transition: color 0.2s;
                    line-height: 1;
                    opacity: 0.5;
                }
                .close-x:hover { color: #e67e22; opacity: 1; }
                
                .content-area {
                    display: flex;
                    gap: 18px;
                    flex: 1;
                    overflow: hidden;
                }
                .right-column {
                    display: flex;
                    flex-direction: column;
                    flex: 1;
                    overflow: hidden;
                }
                .avatar-box {
                    width: 90px; 
                    height: 135px; /* 最大化 1:1.5 proportion */
                    border-radius: 14px;
                    background: url('${mascotUrl}') top center / cover no-repeat;
                    border: 2px solid #e67e22;
                    flex-shrink: 0;
                    background-color: #f9f7f2;
                }
                .text-box {
                    flex: 1;
                    display: flex;
                    flex-direction: column;
                    overflow-y: auto;
                    padding-top: 4px;
                }
                .title {
                    font-size: 17px;
                    font-weight: 800;
                    margin-bottom: 8px;
                    padding-right: 28px;
                    color: #2c3e50;
                    display: flex;
                    align-items: center;
                    gap: 6px;
                }
                .message {
                    font-size: 14px;
                    line-height: 1.6;
                    color: #64748b;
                    overflow-y: auto;
                    flex: 1;
                    word-break: break-all;
                    white-space: pre-wrap;
                }
                .actions {
                    display: flex;
                    justify-content: flex-end;
                    gap: 10px;
                    margin-top: 12px;
                    flex-shrink: 0;
                }
                .btn {
                    padding: 10px 22px;
                    border: none;
                    border-radius: 12px; 
                    font-size: 14px;
                    font-weight: 800;
                    cursor: pointer;
                    transition: all 0.2s;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    gap: 6px;
                }
                .btn-complete {
                    background: linear-gradient(135deg, #10b981, #059669);
                    color: #fff;
                    box-shadow: 0 4px 10px rgba(16, 185, 129, 0.2);
                    min-width: 100px;
                }
                .btn-snooze {
                    background: #fdfcf9;
                    color: #64748b;
                    border: 1px solid #f0e6d6;
                    padding: 8px 16px;
                }
                .btn:active { transform: scale(0.97); }
                
                .progress-bar {
                    position: absolute;
                    bottom: 0;
                    left: 0;
                    height: 4px;
                    background: linear-gradient(to right, #e67e22, #ffa726);
                    width: 100%;
                    animation: countdown 18s linear forwards;
                    border-radius: 0 0 18px 18px;
                }
                @keyframes countdown {
                    from { width: 100%; }
                    to { width: 0%; }
                }
            </style>
        </head>
        <body>
            <div class="toast">
                <div class="close-x" id="btn-close">×</div>
                <div class="content-area">
                    <div class="avatar-box"></div>
                    <div class="right-column">
                        <div class="text-box">
                            <div class="title"><span>${reminder.icon}</span> <span>${reminder.title}</span></div>
                            <div class="message">${messageHtml}</div>
                        </div>
                        <div class="actions">
                            <button id="btn-complete" class="btn btn-complete">✅ 完成</button>
                            <button id="btn-snooze" class="btn btn-snooze">${snoozeLabel}</button>
                        </div>
                    </div>
                </div>
                <div class="progress-bar"></div>
            </div>

            <script>
                document.addEventListener('DOMContentLoaded', () => {
                    const callAPI = (method, id) => {
                        if (window.reminderAPI && window.reminderAPI[method]) {
                            window.reminderAPI[method](id);
                        } else {
                            console.warn('reminderAPI not found, using window.close');
                            window.close();
                        }
                    };

                    document.getElementById('btn-complete').addEventListener('click', () => callAPI('complete', '${reminder.id}'));
                    document.getElementById('btn-snooze').addEventListener('click', () => callAPI('snooze', '${reminder.id}'));
                    document.getElementById('btn-close').addEventListener('click', () => callAPI('close'));

                    // 18 秒後自動關閉
                    setTimeout(() => {
                        callAPI('close');
                    }, 18000);
                });
            </script>
        </body>
    </html>`;
    }

    // 顯示提醒視窗（含互動按鈕）
    showReminderToast(reminder) {
        this._closeReminderWindow();

        const primaryDisplay = screen.getPrimaryDisplay();
        const { width: screenWidth, height: screenHeight } = primaryDisplay.workAreaSize;

        const windowWidth = 400;
        const windowHeight = 180;
        const margin = 20;

        this.reminderWindow = new BrowserWindow({
            width: windowWidth,
            height: windowHeight,
            x: margin,
            y: screenHeight - windowHeight - margin,
            frame: false,
            alwaysOnTop: true,
            skipTaskbar: true,
            resizable: false,
            transparent: true,
            webPreferences: {
                nodeIntegration: false,
                contextIsolation: true,
                // 修正路徑：__dirname 已經是 src 目錄
                preload: path.join(__dirname, 'reminderPreload.js')
            }
        });

        const messageHtml = reminder.message.replace(/\n/g, '<br>');
        const snoozeCount = this.todayStatus[reminder.id]?.snoozeCount || 0;
        const snoozeLabel = snoozeCount > 0 ? `⏰ 稍後(已延${snoozeCount}次)` : '⏰ 稍後提醒';

        // [v1.12.0] 使用穩定 API 渲染 HTML
        const mascotUrl = this._getMascotUrl();
        const html = this._renderReminderHtml(reminder, mascotUrl, snoozeLabel, messageHtml);

        // 寫入臨時檔案
        const tempPath = path.join(app.getPath('userData'), 'temp_reminder.html');
        try {
            fs.writeFileSync(tempPath, html);
            this.reminderWindow.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
        } catch (e) {
            console.error('[Reminder] 無法顯示提醒視窗:', e);
        }

        this.reminderWindow.once('ready-to-show', () => this.reminderWindow.show());

        // [v1.18.0] 監聽視窗關閉，觸發隊列遞補
        this.reminderWindow.once('closed', () => {
            console.log('[Reminder] 氣泡已關閉，準備遞補下一個...');
            this.reminderWindow = null;
            this.isShowingReminder = false;

            // 間隔 2 秒後再噴出下一個，讓畫面有呼吸感
            setTimeout(() => this.processQueue(), this.queueGapMs);
        });
    }

    // 關閉提醒視窗
    _closeReminderWindow() {
        if (this.reminderWindow && !this.reminderWindow.isDestroyed()) {
            this.reminderWindow.close();
        }
        this.reminderWindow = null;
    }

    // 儲存提醒歷史
    _saveReminderHistory(reminderId) {
        const history = this.config.get('reminderHistory') || {};
        history[reminderId] = this._formatDate(new Date());
        this.config.set('reminderHistory', history);
    }

    // ═══════════════════════════════════════════════════════════════
    // 對外 API（供托盤選單、報告、Firebase 轉發使用）
    // ═══════════════════════════════════════════════════════════════

    /**
     * [v26.03.04 新增] 接收外部訊息推送 (LINE/FB)
     * @param {object} data - { id, title, message, source, senderName, siteName }
     */



    // 取得今日提醒狀態列表（供統計中心顯示，具備時間過濾）
    getTodayReminderStatus() {
        const statusList = [];
        const processedIds = new Set();
        const now = new Date();
        const nowMinutes = now.getHours() * 60 + now.getMinutes();

        // 取得今日工作時間背景
        const workInfo = this.config.getTodayWorkInfo();
        const boundEmployee = this.config.getBoundEmployee();
        let shiftStartMinutes = 8 * 60 + 30;
        let shiftEndMinutes = 17 * 60 + 30;
        let offTimeMinutes = shiftEndMinutes;

        if (boundEmployee) {
            if (boundEmployee.shiftStart) {
                const [h, m] = boundEmployee.shiftStart.split(':').map(Number);
                shiftStartMinutes = h * 60 + m;
            }
            if (boundEmployee.shiftEnd) {
                const [h, m] = boundEmployee.shiftEnd.split(':').map(Number);
                shiftEndMinutes = h * 60 + m;
            }
        }
        if (workInfo && workInfo.expectedOffTime) {
            const [h, m] = workInfo.expectedOffTime.split(':').map(Number);
            offTimeMinutes = h * 60 + m;
        }

        // 1. 以當前排程中的提醒清單為基準
        for (const reminder of this.reminders) {
            // [v26.03.04 Fix] 週排程過濾：非今天的 weekly 提醒不顯示
            if (reminder.frequency === 'weekly' && reminder.dayOfWeek !== undefined) {
                const todayDay = now.getDay();
                if (todayDay !== reminder.dayOfWeek) continue;
            }

            const status = this.todayStatus[reminder.id] || { status: 'pending' };
            const isCompleted = status.status === 'completed';

            // 計算此提醒的基準觸發時間 (不含隨機)
            const triggerTime = this.calculateTriggerTime(reminder, now, shiftStartMinutes, offTimeMinutes);
            const triggerTimeMinutes = triggerTime ? (triggerTime.getHours() * 60 + triggerTime.getMinutes()) : 0;

            // [v1.16.2] 精確顯示判定
            const isCheckin = reminder.id === 'checkin_reminder';
            const isIcloud = reminder.isIcloud === true;
            // [v1.17.1] iCloud 行程直接顯示（不受時間過濾）
            if (isIcloud || isCompleted || isCheckin || (triggerTimeMinutes > 0 && nowMinutes >= triggerTimeMinutes)) {
                statusList.push({
                    id: reminder.id,
                    icon: reminder.icon,
                    title: reminder.title,
                    status: status.status
                });
            }
            processedIds.add(reminder.id);
        }

        // 2. 動態行程處理 (iCloud / Local Tasks)
        for (const [id, status] of Object.entries(this.todayStatus)) {
            if (processedIds.has(id)) continue;

            // [v1.17.5 Fix] 增加外部訊息 (isExternal) 判定，排除重複的基礎 ID
            const isExternal = status.isExternal === true;
            const isCompleted = status.status === 'completed';
            let shouldShow = isCompleted || isExternal;

            // 針對 iCloud 行程：[v1.17.1] 全部顯示
            if (id.toString().startsWith('icloud_')) {
                shouldShow = true;
            }

            if (shouldShow) {
                let title = status.title || `任務 #${id} `;
                statusList.push({
                    id: id,
                    icon: status.icon || (id.toString().startsWith('icloud_') ? '🍏' : (isExternal ? '💬' : '⏰')),
                    title: title,
                    status: status.status,
                    completedAt: status.completedAt || null,
                    autoCompleted: status.autoCompleted || false,
                    isIcloud: id.toString().startsWith('icloud_'),
                    isExternal: isExternal
                });
            }
        }

        // [v1.16.3] 專家級排序：未完成 (pending) 置頂，已完成 (completed) 沉底
        statusList.sort((a, b) => {
            if (a.status === 'pending' && b.status !== 'pending') return -1;
            if (a.status !== 'pending' && b.status === 'pending') return 1;
            return 0;
        });

        return statusList;
    }

    // 取得待完成數量
    getPendingCount() {
        return Object.values(this.todayStatus)
            .filter(s => s.status !== 'completed').length;
    }

    // 取得完成數量
    getCompletedCount() {
        return Object.values(this.todayStatus)
            .filter(s => s.status === 'completed').length;
    }

    // 取得未完成項目文字（用於生產力報告）
    getUncompletedText() {
        const uncompleted = [];

        for (const [id, status] of Object.entries(this.todayStatus)) {
            if (status.status === 'completed') continue;

            const reminder = this.reminders.find(r => r.id === id);
            if (!reminder) continue;

            uncompleted.push(`${reminder.icon} ${reminder.title} `);
        }

        if (uncompleted.length === 0) return '';

        return '【未完成提醒】\n' + uncompleted.map(item => `  ${item} `).join('\n');
    }

    // 停止所有提醒
    stop() {
        if (this.timers) {
            for (const timer of this.timers) {
                clearTimeout(timer);
            }
        }
        this.timers = [];
        this._closeReminderWindow();
        console.log('[Reminder] 所有提醒已停止');
    }

    // 日期格式化
    _formatDate(date) {
        if (!date) date = new Date();
        const year = date.getFullYear();
        const month = String(date.getMonth() + 1).padStart(2, '0');
        const day = String(date.getDate()).padStart(2, '0');
        return `${year}-${month}-${day}`;
    }

    /**
     * [v26.03.04] 每日數據清洗門戶：確保跨天時自動重置狀態
     */
    checkDailyReset() {
        const now = new Date();
        const todayStr = this._formatDate(now);

        if (!this.lastCheckDate) {
            this.lastCheckDate = todayStr;
            return;
        }

        if (this.lastCheckDate !== todayStr) {
            console.log(`[Reminder] 📅 偵測到跨日 (${this.lastCheckDate} -> ${todayStr})，自動清空過期狀態...`);
            this.todayStatus = {};
            this.reminders = this.reminders.filter(r => !r.isIcloud && !r.isTomorrowPreview);
            this.config.set('reminderDailyState', null);
            this.lastCheckDate = todayStr;

            // 通知 UI 刷新
            this._notifyStatusUpdated('day_reset');
        }
    }

    // [v1.2] 儲存今日提醒狀態到設定檔
    _saveTodayStatus() {
        try {
            const todayStr = this._formatDate(new Date());
            const data = {
                date: todayStr,
                status: this.todayStatus
            };
            this.config.set('reminderDailyState', data);
        } catch (err) {
            console.error('[Reminder] 儲存狀態失敗:', err);
        }
    }

    // [v1.2] 從設定檔載入今日提醒狀態
    _loadTodayStatus(todayStr) {
        try {
            const savedData = this.config.get('reminderDailyState');
            if (savedData && savedData.date === todayStr) {
                console.log('[Reminder] 發現今日已存狀態，正在恢復並清洗...');
                const rawStatus = savedData.status || {};

                // [v1.13.2] 狀態清洗：僅保留現有規則中存在的 ID 或 iCloud 動態 ID
                const activeIds = new Set(this.reminders.map(r => r.id));
                const cleanedStatus = {};

                for (const [id, s] of Object.entries(rawStatus)) {
                    // [v1.17.2] 多重防護：isIcloud 標記 OR icloud_ 前綴比對
                    if (activeIds.has(id) || s.isIcloud || id.toString().startsWith('icloud_')) {
                        cleanedStatus[id] = s;
                    } else {
                        console.log(`[Reminder] 已移除過時的狀態紀錄: ${id} `);
                    }
                }
                this.todayStatus = cleanedStatus;
                // 修正：將存檔中的 completedAt 轉回 Date 對象 (如果有需要)
                return true;
            } else {
                // 如果日期不同，清空舊狀態
                this.todayStatus = {};
                this.config.set('reminderDailyState', null);
                return false;
            }
        } catch (err) {
            console.error('[Reminder] 載入狀態失敗:', err);
            this.todayStatus = {};
            return false;
        }
    }

    // [v1.12.0 Pure Remind] 僅負責根據 apiBridge 提供之資料進行提醒排程
    // [v1.13.0 專家職責] 接收由 ApiBridge 同步之雲端行程，僅負責排程自治
    updateIcloudReminders(icloudEvents, todayStr) {
        console.log(`[Reminder] 接收到 iCloud 同步請求，行程總數: ${icloudEvents ? icloudEvents.length : 0} `);
        if (!icloudEvents) return;

        try {
            // 1. 清理舊的 iCloud 提醒定義
            this.reminders = this.reminders.filter(r => !r.isIcloud);
            const now = new Date();
            let count = 0;

            for (const ev of icloudEvents) {
                const icloudReminder = {
                    id: ev.id,
                    icon: '🍏',
                    title: `[${ev.startTime}] [Apple行事曆] ${ev.summary}`,
                    message: `地點: ${ev.location || '未標註'}\n時間: ${ev.startTime}`,
                    timeStr: ev.startTime,
                    isIcloud: true,
                    frequency: 'daily'
                };

                this.reminders.push(icloudReminder);

                // 2. 初始化今日狀態 (Pending 鎖定)
                const startDate = ev.fullStartDate;
                const triggerTime = new Date(now);
                triggerTime.setHours(startDate.getHours(), startDate.getMinutes(), 0, 0);

                if (!this.todayStatus[icloudReminder.id] || this.todayStatus[icloudReminder.id].status !== 'completed') {
                    if (!this.todayStatus[icloudReminder.id]) {
                        this.todayStatus[icloudReminder.id] = {
                            status: 'pending',
                            title: icloudReminder.title,
                            isIcloud: true
                        };
                    } else {
                        // [v1.17.2] 已有狀態時，確保 isIcloud 標記不遺失
                        this.todayStatus[icloudReminder.id].isIcloud = true;
                        if (!this.todayStatus[icloudReminder.id].title) {
                            this.todayStatus[icloudReminder.id].title = icloudReminder.title;
                        }
                    }

                    // 3. 智慧提醒引擎 [v1.13.0]
                    const diffMin = (triggerTime.getTime() - now.getTime()) / (60 * 1000);

                    if (diffMin > 0) {
                        // 未來的行程：排程提醒
                        console.log(`[Reminder] 預掛雲端行程: ${ev.summary} 將於 ${ev.startTime} 提醒`);
                        const timer = setTimeout(() => {
                            this.fireReminder(icloudReminder, todayStr);
                        }, diffMin * 60 * 1000);
                        this.timers.push(timer);
                    } else if (diffMin > -120) {
                        // 過去 2 小時內的行程：補彈提醒 (避免過期太久干擾)
                        console.log(`[Reminder] 補發近期雲端行程: ${ev.summary} (${ev.startTime})`);
                        this.fireReminder(icloudReminder, todayStr);
                    } else {
                        // 更早的行程：僅列入清單，不主動彈窗
                        console.log(`[Reminder] 登錄今日已過行程: ${ev.summary} (${ev.startTime})`);
                    }
                }
                count++;
            }
            console.log(`[Reminder] 排程自治同步完成，今日雲端行程共 ${count} 個`);
        } catch (err) {
            console.error('[Reminder] 雲端數據注入失敗:', err.message);
        }
    }

    // [v1.17.1] 明日排程預覽：下午 3:30 後將明日行程加入待辦清單（僅顯示不彈窗）
    updateTomorrowPreview(tomorrowEvents, tomorrowStr) {
        if (!tomorrowEvents || tomorrowEvents.length === 0) return;
        try {
            // 清理舊的明日預覽
            this.reminders = this.reminders.filter(r => !r.isTomorrowPreview);
            let count = 0;
            for (const ev of tomorrowEvents) {
                const previewReminder = {
                    id: `tomorrow_${ev.id}`,
                    icon: '📅',
                    title: `[明日] ${ev.summary}`,
                    message: `時間: ${ev.startTime} | 地點: ${ev.location}`,
                    timeStr: ev.startTime,
                    isIcloud: true,
                    isTomorrowPreview: true,
                    frequency: 'daily'
                };
                this.reminders.push(previewReminder);
                if (!this.todayStatus[previewReminder.id]) {
                    this.todayStatus[previewReminder.id] = {
                        status: 'pending',
                        title: previewReminder.title,
                        icon: '📅',
                        isTomorrowPreview: true
                    };
                }
                count++;
            }
            console.log(`[Reminder] 明日預覽已注入 ${count} 個行程`);
        } catch (err) {
            console.error('[Reminder] 明日預覽注入失敗:', err.message);
        }
    }

    // [v1.11.8] 手動觸發本機提醒掃描 (用於新增任務後立即生效)
    triggerLocalCheck() {
        console.log('[Reminder] 收到手動檢查請求，立即掃描待辦事項...');
        this._checkLocalReminders();
    }

    /**
     * [v1.16.7] 標記提醒為已完成 (跨服務調用)
     */
    async completeReminder(id) {
        console.log(`[Reminder] 標記任務為已完成: ${id} `);
        if (!this.todayStatus[id]) this.todayStatus[id] = { status: 'pending' };
        this.todayStatus[id].status = 'completed';
        this.todayStatus[id].completedAt = new Date();
        this._saveTodayStatus();

        // [v1.17.2] 里程碑鼓勵機制
        this._checkMilestoneEncouragement();

        // 通知監測視窗與托盤刷新
        this._notifyStatusUpdated(id);
        return { success: true };
    }

    /**
     * [v1.17.2] 里程碑鼓勵：完成 3/6/9/12 項任務時，小秘書給予階段性鼓勵
     */
    _checkMilestoneEncouragement() {
        const completedCount = Object.values(this.todayStatus)
            .filter(s => s.status === 'completed').length;

        const milestones = {
            3: {
                icon: '🌱', title: '起步階段', messages: [
                    '今天的效率不錯，繼續保持！',
                    '三項任務已完成，節奏很好喔！',
                    '穩步推進中，您做得很棒！'
                ]
            },
            6: {
                icon: '🔥', title: '加速階段', messages: [
                    '太強了！半天就完成六項任務，您是團隊的動力引擎！',
                    '六項達標！這效率簡直是火力全開 🔥',
                    '任務推進速度驚人，設計總監果然不同凡響！'
                ]
            },
            9: {
                icon: '⭐', title: '卓越階段', messages: [
                    '九項任務全數達標，這就是專業經理人的風範！',
                    '九項完成！今天的您閃閃發光 ✨',
                    '卓越表現！團隊因您而更出色！'
                ]
            },
            12: {
                icon: '🏆', title: '全壘打', messages: [
                    '今天所有任務全壘打！您就是添心的 MVP！辛苦了，記得補充水分 💧',
                    '完美的一天！十二項全數達陣，真正的冠軍！🏆',
                    '全壘打成就達成！今天的努力值得最高的敬意！'
                ]
            },
            15: {
                icon: '🎖️', title: '傳奇成就', messages: [
                    '您突破了人類極限！請受一拜 🙇‍♀️',
                    '十五項達成！您就是效率的代名詞！',
                    '傳奇級表現，小添已經無法形容您的厲害了！'
                ]
            },
            20: {
                icon: '🌌', title: '宇宙級效率', messages: [
                    '今日的成就已載入史冊... 🏆✨',
                    '二十項任務！您的效率已經超越宇宙法則了 🌌',
                    '宇宙級成就解鎖！小添為您感到無比驕傲！'
                ]
            },
            25: {
                icon: '👑', title: '系統霸主', messages: [
                    '今日您就是神！請務必好好休息 💖',
                    '二十五項！您是小添見過最強的系統霸主！👑',
                    '請受小添最高規格的崇拜！今天可以早點下班了 🙏'
                ]
            }
        };

        const milestone = milestones[completedCount];
        if (milestone) {
            const msg = milestone.messages[Math.floor(Math.random() * milestone.messages.length)];
            console.log(`[Reminder] 🎉 里程碑達成 (${completedCount}項): ${msg}`);

            // 透過所有視窗發送里程碑通知
            const windows = BrowserWindow.getAllWindows();
            windows.forEach(win => {
                if (!win.isDestroyed()) {
                    win.webContents.send('milestone-reached', {
                        count: completedCount,
                        icon: milestone.icon,
                        title: milestone.title,
                        message: msg
                    });
                }
            });
        }
    }

    /**
     * [v1.16.7] 撤銷已完成狀態 (還原為 Pending)
     */
    async undoReminder(id) {
        console.log(`[Reminder] 撤銷任務狀態: ${id} `);
        if (this.todayStatus[id]) {
            this.todayStatus[id].status = 'pending';
            this.todayStatus[id].completedAt = null;
            this._saveTodayStatus();
            this._notifyStatusUpdated(id);
        }
        return { success: true };
    }

    /**
     * [v1.16.7] 延後提醒
     */
    async snoozeReminder(id) {
        console.log(`[Reminder] 延後提醒任務: ${id} `);
        if (!this.todayStatus[id]) this.todayStatus[id] = { status: 'pending', snoozeCount: 0 };
        this.todayStatus[id].status = 'snoozed';
        this.todayStatus[id].snoozeCount = (this.todayStatus[id].snoozeCount || 0) + 1;
        this._saveTodayStatus();
        this._notifyStatusUpdated(id);
        return { success: true };
    }

    _notifyStatusUpdated(id) {
        // 發送給所有視窗 (統計中心與托盤)
        const windows = BrowserWindow.getAllWindows();
        windows.forEach(win => {
            if (!win.isDestroyed()) {
                win.webContents.send('reminder-status-updated', id);
            }
        });
    }
    /**
     * [v1.17.4] 接收來自外部服務 (如 Firebase) 的即時推送通知
     * 這些通知具備跨日持久化、即時彈窗、手動按完成才消失的特性。
     * [v1.17.4] 實裝聚合邏輯：同客戶訊息合併，兩條以內全顯示，三條以上整合為計數。
     */
    pushExternalNotification(notification) {
        if (!notification || !notification.id) return;

        // [v1.18.2] 狀態保護機制：一旦標記為完成，拒絕從雲端「復活」該任務
        if (this.todayStatus[notification.id] && this.todayStatus[notification.id].status === 'completed') {
            return;
        }

        console.log(`[Reminder] 接收外部通訊: ${notification.title}`);

        const now = new Date();
        const todayStr = this._formatDate(now);

        // 1. 查找是否存在同一客戶且未處理的訊息 (聚合邏輯)
        let existingId = null;
        for (const [id, status] of Object.entries(this.todayStatus)) {
            if (status.isExternal && status.status === 'pending' &&
                status.senderName === notification.senderName &&
                status.source === notification.source) {
                existingId = id;
                break;
            }
        }

        let targetId = notification.id;
        let count = 1;
        let finalMessage = notification.message;

        if (existingId) {
            targetId = existingId;
            const existing = this.todayStatus[existingId];
            count = (existing.messageCount || 1) + 1;

            if (count === 2) {
                finalMessage = `${existing.message}\n---\n${notification.message}`;
            } else if (count >= 3) {
                finalMessage = `「${notification.senderName}」已發送 ${count} 條訊息。請儘速開啟相關通訊 App 進行回應處理！`;
            }
        }

        // 2. 寫入或更新今日狀態
        this.todayStatus[targetId] = {
            status: 'pending',
            title: notification.title,
            icon: notification.icon || '💬',
            message: finalMessage,
            siteName: notification.siteName,
            isExternal: true,
            source: notification.source,
            senderName: notification.senderName,
            messageCount: count,
            createdAt: notification.createdAt || now.toISOString()
        };

        // 3. 持久化存儲
        this._saveTodayStatus();

        // 4. 下載圖片並執行彈窗提醒 (增加排重保護)
        const reminderObj = {
            id: targetId,
            icon: notification.icon || '💬',
            title: notification.title,
            message: finalMessage,
            isExternal: true
        };

        // [v1.18.2] 隊列排重：避免內容完全相同的訊息重複進隊列
        const isDuplicate = this.reminderQueue.some(r => r.id === targetId && r.message === finalMessage);
        if (!isDuplicate) {
            this.fireReminder(reminderObj, todayStr);
        }

        // 5. 通知所有視窗刷新數據
        this._notifyStatusUpdated(targetId);
    }
}

module.exports = { ReminderService };
