const { app } = require('electron');
const path = require('path');

// 模擬依賴物件
const mockApp = {
    getPath: (name) => {
        if (name === 'userData') return __dirname;
        return __dirname;
    },
    quit: () => { }
};

const mockConfig = {
    getBoundEmployee: () => ({ userName: '測試員' }),
    getTodayWorkInfo: () => ({ checkedIn: true, checkinTime: '08:55', expectedOffTime: '18:00' }),
    getConfig: () => ({}),
    isEmployeeBound: () => true
};

const mockStorage = {
    getTodayStats: async () => ({ work: 120, leisure: 30, other: 10, total: 160 }),
    getHourlyStats: async () => [],
    getRecentTopApps: async () => [],
    getBrowserHistory: async () => []
};

const mockMonitor = {
    getStatus: () => ({ isPaused: false, sampleCount: 100 })
};

// 引入真實類別
const { ReminderService } = require('./src/reminderService');
const { TrayManager } = require('./src/tray.js');

async function runTest() {
    console.log('--- 🧪 開始功能驗證 ---');

    console.log('\n[1] 檢查提醒清單瘦身...');
    const reminderService = new ReminderService(mockConfig, mockMonitor);
    const reminders = reminderService.reminders;

    const hasClientMsg = reminders.some(r => r.title.includes('確認客戶訊息'));
    const hasMaterial = reminders.some(r => r.title.includes('材料'));
    const hasQuotation = reminders.some(r => r.title.includes('報價'));

    if (hasClientMsg) console.log('  ✅ [PASS] 包含「確認客戶訊息」');
    else console.log('  ❌ [FAIL] 缺少「確認客戶訊息」');

    if (!hasMaterial) console.log('  ✅ [PASS] 已移除「材料」提醒');
    else console.log('  ❌ [FAIL] 仍存在「材料」提醒');

    if (!hasQuotation) console.log('  ✅ [PASS] 已移除「報價」提醒');
    else console.log('  ❌ [FAIL] 仍存在「報價」提醒');

    console.log('\n[2] 檢查 HTML 互動按鈕...');
    // 設定一些假裝的狀態讓 generateStatsHtml 抓取
    reminderService.todayStatus = {
        'client_msg_1': { id: 'client_msg_1', title: '確認客戶訊息', status: 'pending', icon: '📨' }
    };

    const trayManager = new TrayManager(mockApp, mockMonitor, mockStorage, mockConfig, null, null, reminderService);

    try {
        const html = await trayManager.generateStatsHtml();

        // 檢查關鍵程式碼
        if (html.includes('onclick="completeReminder(\'client_msg_1\')"')) {
            console.log('  ✅ [PASS] HTML 包含互動按鈕 (onclick="completeReminder")');
        } else {
            console.log('  ❌ [FAIL] HTML 缺少互動按鈕');
            console.log('HTML 片段:', html.substring(html.indexOf('reminder-row'), html.indexOf('reminder-row') + 200));
        }

        if (html.includes('window.reminderAPI.refreshStats()')) {
            console.log('  ✅ [PASS] 包含自動刷新邏輯 (refreshStats)');
        } else {
            console.log('  ❌ [FAIL] 缺少自動刷新邏輯');
        }

    } catch (e) {
        console.error('  ❌ [ERROR] 生成 HTML 失敗:', e);
    }

    console.log('\n--- 驗證結束 ---');
    process.exit(0);
}

app.whenReady().then(runTest);
