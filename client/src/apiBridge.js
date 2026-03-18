const os = require('os');
const fs = require('fs');
const path = require('path');
const { app } = require('electron');

// [v2.0.12] 深度防禦性載入：確保在 patches 目錄下也能正確載入母體的依賴
function safeRequire(moduleName) {
    try {
        const m = require(moduleName);
        return m;
    } catch (e) {
        try {
            const mPath = require.resolve(moduleName, { paths: [process.cwd(), __dirname, path.join(process.cwd(), 'resources/app.asar/node_modules')] });
            return require(mPath);
        } catch (e2) {
            console.warn(`[ApiBridge] 無法載入模組 ${moduleName}:`, e2.message);
            return null;
        }
    }
}

const axios = safeRequire('axios');
const ical = safeRequire('node-ical');

/**
 * =============================================================================
 * 檔案名稱: apiBridge.js (原 checkinService.js)
 * 專案名稱: 添心系統通訊橋樑 (ApiBridge) v1.0
 * 說明: 系統唯一的後端 (GAS) 通訊出口。負責處理打卡、報表、心跳與規則同步。
 * =============================================================================
 */
class ApiBridge {
    constructor(configManager) {
        this.config = configManager;
        this.icloudConnected = false; // [v1.13.0] 新增連線旗標
        this.monitorService = null;
        this.apiUrl = configManager.getCheckinApiUrl();
        this.pcName = configManager.getPcName();
        this.employeeNames = new Set(); // [v2.2.8.3] 姓名快取
        this.employeeUids = new Set();  // [v2.2.8.5] UID 快取 (精確過濾)
        console.log(`[ApiBridge] 初始化完成，通訊出口已收口於此。電腦名稱: ${this.pcName}`);

        this.logPath = path.join(app.getPath('userData'), 'api_bridge_debug.log');
    }

    setMonitorService(monitorService) {
        this.monitorService = monitorService;
    }

    _hlog(msg) {
        try {
            fs.appendFileSync(this.logPath, `[${new Date().toISOString()}] ${msg}\n`);
        } catch (e) { }
    }

    // ═══════════════════════════════════════════════════════════════
    // 基礎通訊引擎 (單一出口)
    // ═══════════════════════════════════════════════════════════════

    // 通用 GET 請求 (具備 x3 自動重試)
    async get(params, skipPage = false, retryCount = 3) {
        const cleanParams = {};
        if (!skipPage) cleanParams.page = 'attendance_api';

        for (const key in params) {
            if (params[key] !== undefined && params[key] !== null) {
                cleanParams[key] = params[key];
            }
        }

        const queryString = new URLSearchParams(cleanParams).toString();
        const url = `${this.apiUrl}?${queryString}`;

        for (let attempt = 1; attempt <= retryCount; attempt++) {
            try {
                console.log(`[ApiBridge] GET → ${params.action || 'checkin(default)'} (嘗試 ${attempt}/${retryCount})`);
                this._hlog(`GET: ${params.action || 'checkin(default)'} (Attempt ${attempt}) URL: ${url}`);

                const response = await axios.get(url, {
                    timeout: 10000,
                    headers: { 'Content-Type': 'application/json' }
                });

                const data = response.data;
                if (data && typeof data === 'object') {
                    return data;
                } else {
                    throw new Error('回傳格式錯誤 (非 JSON)');
                }
            } catch (error) {
                console.warn(`[ApiBridge] GET 嘗試 ${attempt} 失敗:`, error.message);
                if (attempt === retryCount) {
                    console.error(`[ApiBridge] GET 最終失敗 (${params.action}):`, error.message);
                    return { success: false, message: `網路連線或 API 異常: ${error.message}` };
                }
                // 等待 1 秒後重試
                await new Promise(resolve => setTimeout(resolve, 1000));
            }
        }
    }

    // 通用 POST 請求 (具備 x3 自動重試)
    async post(payload, retryCount = 3) {
        for (let attempt = 1; attempt <= retryCount; attempt++) {
            try {
                console.log(`[ApiBridge] POST → ${payload.action} (嘗試 ${attempt}/${retryCount})`);
                this._hlog(`POST: ${payload.action} (Attempt ${attempt})`);

                const response = await axios.post(this.apiUrl, payload, {
                    timeout: 10000,
                    headers: { 'Content-Type': 'application/json' }
                });

                const data = response.data;
                if (data && typeof data === 'object') {
                    return data;
                } else {
                    throw new Error('回傳格式錯誤 (非 JSON)');
                }
            } catch (error) {
                console.warn(`[ApiBridge] POST 嘗試 ${attempt} 失敗:`, error.message);
                if (attempt === retryCount) {
                    console.error(`[ApiBridge] POST 最終失敗 (${payload.action}):`, error.message);
                    return { success: false, message: `傳送失敗: ${error.message}` };
                }
                // 等待 1 秒後重試
                await new Promise(resolve => setTimeout(resolve, 1000));
            }
        }
    }

    // ═══════════════════════════════════════════════════════════════
    // 業務特遣隊功能 (打卡/報表/規則)
    // ═══════════════════════════════════════════════════════════════

    // 取得在職員工列表
    async getEmployeeList() {
        const result = await this.get({
            action: 'get_employees',
            filter: 'active'
        });
        
        // [v2.2.8.5] 同步更新本地名稱與 UID 快取
        if (result && result.success && Array.isArray(result.data)) {
            this.employeeNames.clear();
            this.employeeUids.clear();
            result.data.forEach(emp => {
                if (emp.userName) this.employeeNames.add(emp.userName);
                if (emp.userId) this.employeeUids.add(emp.userId);
            });
            console.log(`[ApiBridge] 員工快取同步成功: ${this.employeeNames.size} 名稱 / ${this.employeeUids.size} UID`);
        }
        return result;
    }

    // [v2.2.8.5] 判斷是否為內部員工 (雙重校驗：姓名 或 UID)
    // [v2.6.401] 強化寬容比對：自動轉字串以相容 Firebase 傳入型別
    isEmployee(name, uid) {
        if (uid) {
            const searchUid = uid.toString();
            for (let savedUid of this.employeeUids) {
                if (savedUid && savedUid.toString() === searchUid) return true;
            }
        }
        if (name && this.employeeNames.has(name)) return true;
        return false;
    }

    // 用電腦名稱查詢已綁定的員工
    async getEmployeeByPcName() {
        return await this.get({
            action: 'get_employee_by_pc',
            pcName: this.pcName
        });
    }

    // 綁定電腦到員工
    async bindPcToEmployee(userId) {
        return await this.post({
            action: 'bind_pc_to_employee',
            userId: userId,
            pcName: this.pcName
        });
    }

    // 取得今日打卡資訊
    async getWorkInfo(userId) {
        return await this.get({
            action: 'get_work_info',
            userId: userId
        });
    }

    // [v1.11.27] 桌機直接打卡 (據點優先、即刻套用)
    async directCheckin(userId, userName) {
        let lat = 0;
        let lon = 0;
        let locationMethod = 'none';

        const boundEmployee = this.config.getBoundEmployee();
        if (boundEmployee) {
            const group = boundEmployee.group || '';
            const stores = this.config.getStoreLocations();
            const matchedStore = Object.keys(stores).find(name => group.includes(name.replace('店', '')));

            if (matchedStore) {
                lat = stores[matchedStore].lat;
                lon = stores[matchedStore].lon;
                locationMethod = 'office_fixed';
                console.log(`[ApiBridge] 已即刻套用據點座標: ${matchedStore} (${lat}, ${lon})`);
            }
        }

        if (lat === 0 && lon === 0) {
            try {
                const controller = new AbortController();
                const timeoutId = setTimeout(() => controller.abort(), 1000);
                const ipRes = await fetch('https://ipapi.co/json/', { signal: controller.signal });
                clearTimeout(timeoutId);

                if (ipRes.ok) {
                    const ipData = await ipRes.json();
                    if (ipData && ipData.latitude && ipData.longitude) {
                        lat = parseFloat(ipData.latitude);
                        lon = parseFloat(ipData.longitude);
                        locationMethod = 'ip';
                    }
                }
            } catch (e) { }
        }

        // [v1.18.2] 對齊 checkin.html：使用 GET，不帶 page/action，走 doGet 路由 3（預設打卡）
        const params = {
            userId: userId,
            userName: userName,
            lat: lat,
            lon: lon,
            source: 'assistant',
            locationMethod: locationMethod,
            timestamp: new Date().getTime()
        };

        const result = await this.get(params, true);  // skipPage=true，不帶 page 參數

        // [v1.18.2] 對齊 checkin.html 回應格式：doGet 路由 3 回傳 {status: 'success', message: '...'}
        if (result && result.status === 'success') {
            result.success = true;
        }

        // [v1.18.1] 重要：打卡成功後，立即抓取最新 work_info 並更新到本地 Config
        if (result && result.success) {
            console.log('[ApiBridge] 打卡成功，執行樂觀同步與延遲校準...');

            // 1. 樂觀同步：先用本地時間填補 UI 空白，不讓使用者看到 --:--
            const now = new Date();
            const localTimeStr = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
            const optimisticInfo = {
                checkedIn: true,
                checkinTime: localTimeStr,
                expectedOffTime: '--:--', // 待後端校準
                remainingMinutes: 0
            };
            this.config.setTodayWorkInfo(optimisticInfo);
            this._broadcastUI();
        }

        return result;
    }

    // [v1.18.2] 補助方法：主動廣播 UI 更新
    async _broadcastUI() {
        if (this.monitorService && this.monitorService.statsWindow && !this.monitorService.statsWindow.isDestroyed()) {
            const statsData = await this.monitorService.getStatsData(this.config, null);
            this.monitorService.statsWindow.webContents.send('update-stats-data', statsData);
        }
    }

    // 上傳生產力報告
    async submitProductivityReport(stats, date, detailedStats) {
        const boundEmployee = this.config.getBoundEmployee();
        if (!boundEmployee) {
            return { success: false, message: '尚未綁定員工，無法上傳報告。' };
        }

        const payload = {
            action: 'submit_productivity_report',
            userId: boundEmployee.userId,
            userName: boundEmployee.userName,
            date: date,
            workMinutes: stats.work || 0,
            leisureMinutes: stats.leisure || 0,
            otherMinutes: stats.other || 0,
            idleMinutes: stats.idle || 0,
            musicMinutes: stats.music || 0,
            lunchMinutes: stats.lunch_break || 0,
            productivityRate: stats.productivityRate || 0,
            pcName: this.pcName
        };

        if (detailedStats) {
            payload.detailText = detailedStats.detailText || '';
            payload.unclassifiedKeywords = (detailedStats.unclassifiedKeywords || []).join(', ');
        }

        return await this.post(payload);
    }

    // 發送心跳
    async sendHeartbeat(status, appName, siteName) {
        const boundEmployee = this.config.getBoundEmployee();
        if (!boundEmployee) return;

        return await this.post({
            action: 'update_status',
            userId: boundEmployee.userId,
            userName: boundEmployee.userName,
            status: status,
            appName: appName,
            siteName: this.pcName
        });
    }

    // 同步分類規則
    async syncClassificationRules() {
        const result = await this.get({ action: 'get_rules' });

        if (result.success && result.rules) {
            this.config.set('classificationRules', result.rules);
            return true;
        }
        return false;
    }

    // 啟動初始化
    async initializeOnStartup() {
        // [v2.3.3] 動態過濾強化：啟動時優先抓取員工名單 (不論是否已綁定)
        this.getEmployeeList().catch(() => {});

        const localBound = this.config.getBoundEmployee();
        const isFirstRun = this.config.isFirstRun();

        if (localBound) {

            const workInfoResult = await this.getWorkInfo(localBound.userId);
            if (workInfoResult.success) {
                this.config.setTodayWorkInfo(workInfoResult.data);
            }
            return {
                needSetup: false,
                employee: localBound,
                workInfo: workInfoResult.success ? workInfoResult.data : null
            };
        }

        const pcResult = await this.getEmployeeByPcName();
        if (pcResult.success && pcResult.data) {
            const perm = parseInt(pcResult.data.permission || 0);
            if (perm >= 2) {
                if (isFirstRun) {
                    return { needSetup: true, employee: null, workInfo: null, suggestedEmployee: pcResult.data };
                } else {
                    this.config.bindEmployee(pcResult.data);
                    const workInfoResult = await this.getWorkInfo(pcResult.data.userId);
                    if (workInfoResult.success) {
                        this.config.setTodayWorkInfo(workInfoResult.data);
                    }
                    return {
                        needSetup: false,
                        employee: pcResult.data,
                        workInfo: workInfoResult.success ? workInfoResult.data : null
                    };
                }
            }
        }

        return { needSetup: true, employee: null, workInfo: null };
    }

    // 刷新打卡資訊
    async refreshWorkInfo() {
        const boundEmployee = this.config.getBoundEmployee();
        if (!boundEmployee) return null;

        const result = await this.getWorkInfo(boundEmployee.userId);
        if (result.success) {
            this.config.setTodayWorkInfo(result.data);
            return result.data;
        }
        return null;
    }

    // 補傳昨日報告
    async checkAndSubmitYesterdayReport(storageService) {
        const boundEmployee = this.config.getBoundEmployee();
        if (!boundEmployee) return;

        const yesterday = new Date();
        yesterday.setDate(yesterday.getDate() - 1);
        const yesterdayStr = this._formatDate(yesterday);

        const lastUploadDate = this.config.getLastReportDate();
        if (lastUploadDate === yesterdayStr) return;

        try {
            const yesterdayStats = await storageService.getStatsByDate(yesterdayStr);
            if (!yesterdayStats || yesterdayStats.total === 0) return;

            const detailedStats = await storageService.getDetailedStats(yesterdayStr);
            await this.submitProductivityReport(yesterdayStats, yesterdayStr, detailedStats);
        } catch (error) {
            console.error(`[ApiBridge] 昨日報告補傳失敗:`, error.message);
        }
    }

    // [v26.03.15.2] 儲存 iCloud 網址並啟動同步
    async saveIcloudUrl(url) {
        if (!url) return { success: false, message: '網址不能為空' };
        
        console.log(`[ApiBridge] 正在儲存 iCloud 網址: ${url.substring(0, 30)}...`);
        
        // 1. 儲存至本地 Config
        this.config.setIcloudCalendarUrl(url);

        // 2. 同步至 Firebase (雲端分散式同步)
        if (this.services && this.services.firebaseService) {
            await this.services.firebaseService.uploadIcloudUrl(url);
        }

        // 3. 立即觸發一次行程抓取與 UI 廣播
        if (this.services && this.services.reminderService) {
            await this.syncAllIcloudReminders(this.services.reminderService);
        }

        return { success: true, message: 'iCloud 網址已更新並啟動同步' };
    }

    // [v1.5] 獲獲並解析 iCloud 行事曆事件
    async fetchIcloudEvents(url, todayStr) {
        if (!url) return [];
        // [v1.13.0] URL 自動校準：webcal:// 會導致部分環境 axios 報錯，強制轉為 https://
        // [v1.14.0] 專家級網址預檢：移除特定參數並強制 HTTPS
        const safeUrl = url.replace('webcal://', 'https://').split('?')[0];
        try {
            console.log(`[ApiBridge] 正在抓取 iCloud (${safeUrl.substring(0, 40)}...)...`);
            const response = await axios.get(safeUrl, {
                timeout: 15000,
                headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36' }
            });
            const icalData = ical.parseICS(response.data);
            const events = [];

            for (let k in icalData) {
                if (icalData.hasOwnProperty(k)) {
                    const ev = icalData[k];
                    if (ev.type === 'VEVENT') {
                        events.push(ev);
                    }
                }
            }
            console.log(`[ApiBridge] iCloud 解析成功，抓到 ${events.length} 個行程`);

            const now = new Date();
            const result = [];

            for (const ev of events) {
                const summary = ev.summary || '';
                const location = ev.location || '';
                
                // [v2.2.8.5] 排除內部人員對話/行程轉為提醒事項
                // 比對摘要與地點中是否包含員工姓名
                let isInternalMessage = false;
                for (const empName of this.employeeNames) {
                    if (summary.includes(empName) || location.includes(empName)) {
                        isInternalMessage = true;
                        break;
                    }
                }
                
                if (isInternalMessage) {
                    console.log(`[ApiBridge] 過濾內部人員行程: ${summary}`);
                    continue;
                }

                const startDate = new Date(ev.start);
                const endDate = new Date(ev.end);
                let isToday = false;

                // 處理重複規則 (RRULE)
                if (ev.rrule) {
                    const dates = ev.rrule.between(
                        new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0),
                        new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59),
                        true
                    );
                    if (dates.length > 0) {
                        isToday = true;
                        startDate.setFullYear(now.getFullYear(), now.getMonth(), now.getDate());
                    }
                } else {
                    // [v1.14.1] 專家級跨日校準：只要今日位於事件區間內即包含
                    const sStr = this._formatDate(startDate);
                    const eStr = this._formatDate(new Date(endDate.getTime() - 1000));
                    const isTodayInRange = (sStr <= todayStr && eStr >= todayStr);
                    if (isTodayInRange) {
                        isToday = true;
                        // 如果是跨日事件且開始日期不是今天，將開始時間設為 00:00 提醒
                        if (sStr < todayStr) {
                            startDate.setFullYear(now.getFullYear(), now.getMonth(), now.getDate());
                            startDate.setHours(0, 0, 0, 0);
                        }
                    }
                }

                if (isToday) {
                    const hh = String(startDate.getHours()).padStart(2, '0');
                    const mm = String(startDate.getMinutes()).padStart(2, '0');
                    result.push({
                        id: `icloud_${ev.uid || Math.random().toString(36).substr(2, 9)}`,
                        summary: ev.summary,
                        location: ev.location || '未標註',
                        startTime: `${hh}:${mm}`,
                        fullStartDate: startDate
                    });
                }
            }
            return result;
        } catch (err) {
            console.error('[ApiBridge] iCloud 同步失敗:', err.message);
            return [];
        }
    }

    // 上傳今日報表
    async submitTodayReport(storageService, reminderService) {
        const boundEmployee = this.config.getBoundEmployee();
        if (!boundEmployee) return;

        const today = this._formatDate(new Date());

        try {
            const todayStats = await storageService.getTodayStats();
            if (!todayStats || todayStats.total === 0) return;

            const detailedStats = await storageService.getDetailedStats(today);

            if (reminderService) {
                const uncompletedText = reminderService.getUncompletedText();
                if (uncompletedText) {
                    detailedStats.detailText = detailedStats.detailText
                        ? (uncompletedText + '\n' + detailedStats.detailText)
                        : uncompletedText;
                }
            }

            const result = await this.submitProductivityReport(todayStats, today, detailedStats);
            if (result.success) {
                this.config.setLastReportDate(today);
            }
            return result;
        } catch (error) {
            console.error('[ApiBridge] 今日報告上傳失敗:', error.message);
            return { success: false, message: error.message };
        }
    }

    // [v4.0] 專業交辦回饋：報告阻塞原因 (到店受阻/其他原因)
    async reportBlocked(taskId, reason, duration) {
        console.log(`[ApiBridge] 報告交辦阻塞: ${taskId} 原因: ${reason}`);
        const boundEmployee = this.config.getBoundEmployee();
        if (!boundEmployee) return { success: false, message: '尚未綁定員工' };

        return await this.post({
            action: 'report_blocked',
            taskId: taskId,
            userId: boundEmployee.userId,
            userName: boundEmployee.userName,
            reason: reason,
            duration: duration || 0
        });
    }

    // [v4.0] 專業交辦回饋：完成任務
    async completeTask(taskId, note, duration) {
        console.log(`[ApiBridge] 報告交辦完成: ${taskId}`);
        const boundEmployee = this.config.getBoundEmployee();
        if (!boundEmployee) return { success: false, message: '尚未綁定員工' };

        return await this.post({
            action: 'complete_task',
            taskId: taskId,
            userId: boundEmployee.userId,
            userName: boundEmployee.userName,
            note: note || '',
            duration: duration || 0
        });
    }

    // [v1.13.0 專家職責] 全量同步 iCloud 行事曆並推播至提醒管家
    async syncAllIcloudReminders(reminderService) {
        const url = this.config.getIcloudCalendarUrl();
        if (!url || !reminderService) {
            this.icloudConnected = false;
            return;
        }

        const today = this._formatDate(new Date());
        try {
            const events = await this.fetchIcloudEvents(url, today);
            if (events && events.length >= 0) {
                reminderService.updateIcloudReminders(events, today);
                this.icloudConnected = true;

                // [v1.17.1] 下午 3:30 後，額外抓取明日排程並注入提醒
                const now = new Date();
                const currentMinutes = now.getHours() * 60 + now.getMinutes();
                if (currentMinutes >= 15 * 60 + 30) {
                const tomorrow = new Date(now);
                tomorrow.setDate(tomorrow.getDate() + 1);
                const tomorrowStr = this._formatDate(tomorrow);
                const tomorrowEvents = await this.fetchIcloudEvents(url, tomorrowStr);
                if (tomorrowEvents && tomorrowEvents.length > 0) {
                    console.log(`[ApiBridge] 明日預覽：抓取到 ${tomorrowEvents.length} 個明日行程`);
                    reminderService.updateTomorrowPreview(tomorrowEvents, tomorrowStr);
                }
                }

                // [v1.14.0] 燈號同步強化：主動廣播數據更新
                if (this.monitorService && this.monitorService.statsWindow) {
                    const data = await this.monitorService.getStatsData(this.config, reminderService);
                    this.monitorService.statsWindow.webContents.send('update-stats-data', data);
                }
                return { success: true, count: events.length };
            }
        } catch (err) {
            console.error('[ApiBridge] 雲端同步專家任務失敗:', err.message);
        }
        this.icloudConnected = false;
        return { success: false };
    }

    // [v1.17.8] 異常事件回報專屬出入口
    async reportErrorLog(eventData) {
        console.error('[ApiBridge] 專案偵測到嚴重異常，正在上報雲端...', eventData.type);
        return await this.post({
            action: 'report_system_error',
            pcName: this.pcName,
            ...eventData
        });
    }

    _formatDate(date) {
        const year = date.getFullYear();
        const month = String(date.getMonth() + 1).padStart(2, '0');
        const day = String(date.getDate()).padStart(2, '0');
        return `${year}-${month}-${day}`;
    }
}

module.exports = { ApiBridge };
