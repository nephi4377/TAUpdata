// v1.1 - 2026-02-14 16:00 (Asia/Taipei)
// 修改內容: 提醒加入「完成/稍後」按鈕、狀態追蹤、報告整合

const { BrowserWindow, screen, ipcMain, app } = require('electron');
const path = require('path');
const fs = require('fs');

class ReminderService {
    constructor(configManager, monitorService) {
        this.config = configManager;
        this.monitorService = monitorService;
        this.timers = [];
        this.reminderWindow = null;

        // 今日提醒狀態追蹤
        // { reminderId: { status: 'pending'|'completed'|'snoozed', completedAt: Date, snoozeCount: 0 } }
        this.todayStatus = {};

        // 提醒規則定義
        this.reminders = [
            // ═══ 每日提醒 ═══
            {
                id: 'checkin_reminder',
                icon: '⏰',
                title: '打卡提醒',
                message: '您今天尚未打卡，請記得使用 LINE 打卡！',
                timeWindow: { startOffset: 30 },
                frequency: 'daily',
                condition: 'not_checked_in'
            },
            {
                id: 'daily_schedule',
                icon: '📋',
                title: '確認今日工地排程',
                message: '確認今日工地巡檢排程，掌握各工地施工階段。',
                timeWindow: { start: '09:00', end: '09:30' },
                frequency: 'daily'
            },
            {
                id: 'client_msg_1',
                icon: '📨',
                title: '確認客戶訊息',
                message: '確認客戶/業主訊息是否已回覆，不要讓客戶等太久！',
                timeWindow: { start: '09:30', end: '10:30' },
                frequency: 'daily'
            },
            {
                id: 'site_photo_report',
                icon: '📸',
                title: '施工照片回報客戶',
                message: '記得傳今日施工照片給客戶，附上施工進度說明。\n讓客戶安心，是最好的服務！',
                timeWindow: { start: '10:30', end: '11:30' },
                frequency: 'daily'
            },
            {
                id: 'client_msg_2',
                icon: '📨',
                title: '確認客戶訊息',
                message: '下午了，再確認一次客戶訊息有沒有漏回的。',
                timeWindow: { start: '14:00', end: '15:00' },
                frequency: 'daily'
            },
            {
                id: 'tomorrow_plan',
                icon: '🏠',
                title: '確認明日工地安排',
                message: '確認明日工地安排，提前做好準備。',
                timeWindow: { beforeOff: 60 },
                frequency: 'daily'
            },
            {
                id: 'daily_report',
                icon: '📊',
                title: '今日工作回報',
                message: '今日工作回報完成了嗎？\n趁記憶還清晰，快點記錄今天的進度！',
                timeWindow: { beforeOff: 30 },
                frequency: 'daily'
            },

            // ═══ 每週固定提醒 ═══
            {
                id: 'monday_pending',
                icon: '📑',
                title: '追蹤未結案件',
                message: '追蹤未結案/收尾案件進度。\n新的一週，確認各案件狀態。',
                timeWindow: { start: '10:00', end: '11:00' },
                frequency: 'weekly',
                dayOfWeek: 1
            },
            {
                id: 'monday_invoice',
                icon: '🧾',
                title: '確認請款/發票進度',
                message: '確認請款/發票進度，有沒有延遲的？',
                timeWindow: { start: '14:00', end: '15:00' },
                frequency: 'weekly',
                dayOfWeek: 1
            },
            {
                id: 'friday_tools',
                icon: '🔧',
                title: '工具設備歸還確認',
                message: '週五收工前，確認工具設備是否歸還。',
                timeWindow: { start: '16:00', end: '17:00' },
                frequency: 'weekly',
                dayOfWeek: 5
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

        // 註冊 IPC 事件（提醒視窗的「完成」和「稍後」按鈕）
        this._registerIpcHandlers();

        console.log('[Reminder] 智慧提醒服務已建立');
    }

    // 註冊 IPC 處理器
    _registerIpcHandlers() {
        // 避免重複註冊
        ipcMain.removeHandler('reminder-complete');
        ipcMain.removeHandler('reminder-snooze');

        ipcMain.handle('reminder-complete', (event, reminderId) => {
            console.log(`[Reminder] ✅ 已完成: ${reminderId}`);
            try {
                this.todayStatus[reminderId] = {
                    status: 'completed',
                    completedAt: new Date().toISOString()
                };
                // 更新提醒歷史
                this._saveReminderHistory(reminderId);
                // [v1.2] 儲存今日狀態
                this._saveTodayStatus();

                // 強制關閉發送該 IPC 請求的視窗（解決孤兒視窗無法關閉的問題）
                const win = BrowserWindow.fromWebContents(event.sender);
                if (win && !win.isDestroyed()) {
                    win.close();
                }

                // 如果正好是我們最後追蹤的視窗，順便清空參考
                if (this.reminderWindow === win) {
                    this.reminderWindow = null;
                }

                return { success: true };
            } catch (err) {
                console.error('[Reminder] 完成操作失敗:', err);
                return { success: false, error: err.message };
            }
        });

        ipcMain.handle('reminder-snooze', (event, reminderId) => {
            console.log(`[Reminder] ⏰ 稍後再提醒: ${reminderId}`);
            try {
                const current = this.todayStatus[reminderId] || {};
                const snoozeCount = (current.snoozeCount || 0) + 1;
                this.todayStatus[reminderId] = {
                    status: 'snoozed',
                    snoozeCount
                };
                // [v1.2] 儲存今日狀態
                this._saveTodayStatus();

                // 強制關閉發送該 IPC 請求的視窗（解決孤兒視窗無法關閉的問題）
                const win = BrowserWindow.fromWebContents(event.sender);
                if (win && !win.isDestroyed()) {
                    win.close();
                }

                if (this.reminderWindow === win) {
                    this.reminderWindow = null;
                }

                // 20 分鐘後再提醒
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
                    if (workInfo && !workInfo.checkedIn) {
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
        let startMinutes, endMinutes;

        if (tw.start && tw.end) {
            const [sh, sm] = tw.start.split(':').map(Number);
            const [eh, em] = tw.end.split(':').map(Number);
            startMinutes = sh * 60 + sm;
            endMinutes = eh * 60 + em;
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
        console.log(`[Reminder] 觸發提醒: ${reminder.icon} ${reminder.title} `);

        // 如果已完成，不再提醒
        if (this.todayStatus[reminder.id]?.status === 'completed') {
            console.log(`[Reminder] ${reminder.id} 已完成，跳過`);
            return;
        }

        // 特殊條件檢查
        if (reminder.condition === 'not_checked_in') {
            const workInfo = this.config.getTodayWorkInfo();
            if (workInfo && workInfo.checkedIn) {
                console.log('[Reminder] 已打卡，自動標記完成');
                this.todayStatus[reminder.id] = {
                    status: 'completed',
                    completedAt: new Date().toISOString(),
                    autoCompleted: true
                };
                return;
            }
        }

        // 顯示提醒視窗（含完成/稍後按鈕）
        this.showReminderToast(reminder);
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

        const html = `
    < !DOCTYPE html >
        <html>
            <head>
                <meta charset="UTF-8">
                    <style>
                        body {
                            margin: 0; padding: 0; overflow: hidden;
                        font-family: 'Microsoft JhengHei', 'Segoe UI', sans-serif;
                        background: transparent;
                        animation: slideIn 0.4s ease-out;
                }
                        @keyframes slideIn {
                            from {transform: translateX(-100%); opacity: 0; }
                        to {transform: translateX(0); opacity: 1; }
                }
                        .toast {
                            background: linear-gradient(135deg, #1a1a2e 0%, #16213e 50%, #0f3460 100%);
                        border: 1px solid rgba(255,255,255,0.15);
                        border-left: 4px solid #e94560;
                        border-radius: 12px;
                        padding: 16px 20px;
                        color: #e0e0e0;
                        box-shadow: 0 8px 32px rgba(0,0,0,0.4);
                        height: calc(100vh - 34px);
                        display: flex;
                        flex-direction: column;
                        justify-content: space-between;
                }
                        .title {
                            font - size: 15px;
                        font-weight: bold;
                        color: #ffffff;
                        margin-bottom: 6px;
                }
                        .message {
                            font - size: 13px;
                        line-height: 1.5;
                        color: #b0b0b0;
                        flex: 1;
                }
                        .actions {
                            display: flex;
                        gap: 10px;
                        margin-top: 12px;
                }
                        .btn {
                            flex: 1;
                        padding: 8px 12px;
                        border: none;
                        border-radius: 8px;
                        font-size: 13px;
                        font-weight: bold;
                        cursor: pointer;
                        transition: all 0.2s;
                        font-family: inherit;
                }
                        .btn-complete {
                            background: linear-gradient(135deg, #2ecc71, #27ae60);
                        color: #fff;
                }
                        .btn-complete:hover {
                            background: linear-gradient(135deg, #27ae60, #1e8449);
                        transform: scale(1.02);
                }
                        .btn-snooze {
                            background: rgba(255,255,255,0.1);
                        color: #999;
                        border: 1px solid rgba(255,255,255,0.15);
                }
                        .btn-snooze:hover {
                            background: rgba(255,255,255,0.15);
                        color: #ccc;
                }
                    </style>
                    <script>
                // 增加點擊事件監聽，確保在 DOM 載入後執行
                document.addEventListener('DOMContentLoaded', () => {
                            document.getElementById('btn-complete').addEventListener('click', () => {
                                window.reminderAPI.complete('${reminder.id}');
                            });
                    document.getElementById('btn-snooze').addEventListener('click', () => {
                            window.reminderAPI.snooze('${reminder.id}');
                    });
                });
                    </script>
            </head>
            <body>
                <div class="toast">
                    <div>
                        <div class="title">${reminder.icon} ${reminder.title}</div>
                        <div class="message">${messageHtml}</div>
                    </div>
                    <div class="actions">
                        <button id="btn-complete" class="btn btn-complete">
                            ✅ 完成
                        </button>
                        <button id="btn-snooze" class="btn btn-snooze">
                            ${snoozeLabel}
                        </button>
                    </div>
                </div>
            </body>
        </html>`;

        // 寫入臨時檔案
        const tempPath = path.join(app.getPath('userData'), 'temp_reminder.html');
        try {
            fs.writeFileSync(tempPath, html);
            this.reminderWindow.loadFile(tempPath);
        } catch (err) {
            console.error('[Reminder] 無法寫入臨時檔案:', err);
            // fallback
            this.reminderWindow.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
        }

        // 不自動關閉！使用者必須點按鈕
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
    // 對外 API（供托盤選單和報告使用）
    // ═══════════════════════════════════════════════════════════════

    // 取得今日提醒狀態列表（供托盤選單顯示）
    getTodayReminderStatus() {
        const statusList = [];

        for (const [id, status] of Object.entries(this.todayStatus)) {
            const reminder = this.reminders.find(r => r.id === id);
            if (!reminder) continue;

            statusList.push({
                id: reminder.id,
                icon: reminder.icon,
                title: reminder.title,
                status: status.status,
                completedAt: status.completedAt || null,
                autoCompleted: status.autoCompleted || false
            });
        }

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
        const year = date.getFullYear();
        const month = String(date.getMonth() + 1).padStart(2, '0');
        const day = String(date.getDate()).padStart(2, '0');
        return `${year} -${month} -${day} `;
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
                console.log('[Reminder] 發現今日已存狀態，正在恢復...');
                this.todayStatus = savedData.status || {};

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
}

module.exports = { ReminderService };
