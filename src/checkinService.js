// v1.2 - 2026-02-15 15:30 (Asia/Taipei)
// 修改內容: 修復首次執行時自動綁定跳過設定視窗的問題

const os = require('os');

class CheckinService {
    constructor(configManager) {
        this.config = configManager;
        this.apiUrl = configManager.getCheckinApiUrl();
        this.pcName = configManager.getPcName(); // [v2.2.4] Use config getter
        console.log(`[CheckinService] 初始化完成，電腦名稱: ${this.pcName}`);
    }

    // ═══════════════════════════════════════════════════════════════
    // 基礎 HTTP 請求方法
    // ═══════════════════════════════════════════════════════════════

    // GET 請求
    async _get(params) {
        // [v2026.1 Fix] Remove undefined/null params to avoid "undefined" string in URL
        const cleanParams = {};
        for (const key in params) {
            if (params[key] !== undefined && params[key] !== null) {
                cleanParams[key] = params[key];
            }
        }

        const queryString = new URLSearchParams({
            page: 'attendance_api',
            ...cleanParams
        }).toString();

        const url = `${this.apiUrl}?${queryString}`;
        console.log(`[CheckinService] GET → ${params.action}`);

        try {
            const response = await fetch(url, {
                method: 'GET',
                headers: { 'Content-Type': 'application/json' }
            });

            if (!response.ok) {
                throw new Error(`HTTP 錯誤! 狀態碼: ${response.status}`);
            }

            // GAS 的 doGet 會回傳 302 redirect，fetch 預設會自動跟隨
            const data = await response.json();

            if (data && typeof data === 'object') {
                console.log(`[CheckinService] GET ← ${params.action}: ${data.success ? '成功' : (data.message || '無訊息')}`);
                return data;
            } else {
                throw new Error('回傳格式錯誤 (非 JSON 物件)');
            }
        } catch (error) {
            console.error(`[CheckinService] GET 失敗 (${params.action}):`, error.message);
            return { success: false, message: `網路連線或 API 異常: ${error.message}` };
        }
    }

    // POST 請求
    async _post(payload) {
        console.log(`[CheckinService] POST → ${payload.action}`);

        try {
            const response = await fetch(this.apiUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload),
                redirect: 'follow'
            });

            if (!response.ok) {
                throw new Error(`HTTP 錯誤! 狀態碼: ${response.status}`);
            }

            const data = await response.json();

            if (data && typeof data === 'object') {
                console.log(`[CheckinService] POST ← ${payload.action}: ${data.success ? '成功' : (data.message || '無訊息')}`);
                return data;
            } else {
                throw new Error('回傳格式錯誤 (非 JSON 物件)');
            }
        } catch (error) {
            console.error(`[CheckinService] POST 失敗 (${payload.action}):`, error.message);
            return { success: false, message: `傳送失敗: ${error.message}` };
        }
    }

    // ═══════════════════════════════════════════════════════════════
    // 員工相關 API
    // ═══════════════════════════════════════════════════════════════

    // 取得在職員工列表（用於首次設定選擇身份）
    async getEmployeeList() {
        return await this._get({
            action: 'get_employees',
            filter: 'active'
        });
    }

    // 用電腦名稱查詢已綁定的員工
    async getEmployeeByPcName() {
        return await this._get({
            action: 'get_employee_by_pc',
            pcName: this.pcName
        });
    }

    // 綁定電腦到員工（POST）
    async bindPcToEmployee(userId) {
        return await this._post({
            action: 'bind_pc_to_employee',
            userId: userId,
            pcName: this.pcName
        });
    }

    // ═══════════════════════════════════════════════════════════════
    // 打卡資訊 API
    // ═══════════════════════════════════════════════════════════════

    // 取得今日打卡資訊（含預計下班時間）
    async getWorkInfo(userId) {
        return await this._get({
            action: 'get_work_info',
            userId: userId
        });
    }

    // [v1.10.0] 桌機直接打卡
    async directCheckin(userId, userName) {
        let lat = 0;
        let lon = 0;
        try {
            console.log('[CheckinService] 嘗試透過 IP 取得地理位置...');
            // 透過公開 API 取得粗略的 IP 經緯度 (支援 CORS，無 key 限制，若超過 rate limit 會失敗)
            const ipRes = await fetch('https://ipapi.co/json/');
            if (ipRes.ok) {
                const ipData = await ipRes.json();
                if (ipData && ipData.latitude && ipData.longitude) {
                    lat = parseFloat(ipData.latitude);
                    lon = parseFloat(ipData.longitude);
                    console.log(`[CheckinService] IP 定位成功: ${lat}, ${lon} (${ipData.city})`);
                }
            }
        } catch (e) {
            console.warn('[CheckinService] IP 定位失敗，使用預設值 0,0', e.message);
        }

        // 發送給舊版的打卡端點 (會進到 WebApp.js -> processCheckin)
        return await this._get({
            action: 'checkin',
            userId: userId,
            userName: userName,
            lat: lat,
            lon: lon,
            source: 'desktop_app_' + this.pcName,
            timestamp: new Date().getTime()
        });
    }

    // ═══════════════════════════════════════════════════════════════
    // 生產力報告 API
    // ═══════════════════════════════════════════════════════════════

    // 上傳生產力報告（POST）
    // stats: 基本統計, detailedStats: { detailText, unclassifiedKeywords }
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

        // 新增詳細記錄和未分類關鍵字
        if (detailedStats) {
            payload.detailText = detailedStats.detailText || '';
            payload.unclassifiedKeywords = (detailedStats.unclassifiedKeywords || []).join(', ');
        }

        return await this._post(payload);
    }

    // 發送心跳 (更新即時狀態)
    async sendHeartbeat(status, appName, siteName) {
        const boundEmployee = this.config.getBoundEmployee();
        if (!boundEmployee) return;

        return await this._post({
            action: 'update_status',
            userId: boundEmployee.userId,
            userName: boundEmployee.userName,
            status: status,
            appName: appName,
            siteName: this.pcName // [v2.2 Fix] 強制回傳電腦名稱作為站點名稱 (原本傳入的是 WindowTitle)
        });
    }

    // 同步分類規則
    async syncClassificationRules() {
        // console.log('[CheckinService] 開始同步分類規則...');
        const result = await this._get({ action: 'get_rules' });

        if (result.success && result.rules) {
            const ruleCount = Object.values(result.rules).reduce((acc, arr) => acc + arr.length, 0);
            console.log(`[CheckinService] 規則同步成功 (${ruleCount} 條規則)，更新本地設定`);
            this.config.set('classificationRules', result.rules);
            return true;
        } else {
            console.warn('[CheckinService] 規則同步失敗或無資料');
            return false;
        }
    }

    // ═══════════════════════════════════════════════════════════════
    // 整合流程
    // ═══════════════════════════════════════════════════════════════

    // 啟動時的初始化流程
    // 回傳: { needSetup, employee, workInfo, suggestedEmployee }
    async initializeOnStartup() {
        console.log('[CheckinService] 開始啟動初始化流程...');

        // 步驟 1：檢查本地是否已有綁定
        const localBound = this.config.getBoundEmployee();
        const isFirstRun = this.config.isFirstRun();

        if (localBound) {
            console.log(`[CheckinService] 本地已綁定: ${localBound.userName}`);

            // 步驟 2：取得今日打卡資訊
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

        // 步驟 1b：本地無綁定，嘗試用電腦名稱查後端
        console.log('[CheckinService] 本地無綁定，嘗試用電腦名稱查詢後端...');
        const pcResult = await this.getEmployeeByPcName();

        if (pcResult.success && pcResult.data) {
            const perm = parseInt(pcResult.data.permission || 0);

            // [v2.2.8.2] 只有權限 >= 2 的員工才允許透過電腦名稱自動辨識
            if (perm >= 2) {
                if (isFirstRun) {
                    console.log(`[CheckinService] 首次執行，後端建議綁定: ${pcResult.data.userName}`);
                    return {
                        needSetup: true,
                        employee: null,
                        workInfo: null,
                        suggestedEmployee: pcResult.data
                    };
                } else {
                    console.log(`[CheckinService] 非首次執行，自動同步後端綁定: ${pcResult.data.userName}`);
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
            } else {
                console.log(`[CheckinService] 自動辨識到 ${pcResult.data.userName}，但權限不足 (${perm})，忽略並進入設定`);
            }
        }

        // 步驟 1c：本地和後端都沒有綁定 → 需要首次設定
        console.log('[CheckinService] 需要首次設定（選擇身份）');
        return {
            needSetup: true,
            employee: null,
            workInfo: null
        };
    }

    // 定時刷新打卡資訊（每 30 分鐘呼叫一次）
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

    // 檢查並補傳昨日報告
    async checkAndSubmitYesterdayReport(storageService) {
        const boundEmployee = this.config.getBoundEmployee();
        if (!boundEmployee) return;

        // 計算昨天的日期
        const yesterday = new Date();
        yesterday.setDate(yesterday.getDate() - 1);
        const yesterdayStr = this._formatDate(yesterday);

        // 檢查昨天是否已上傳
        const lastUploadDate = this.config.getLastReportDate();
        if (lastUploadDate === yesterdayStr) {
            console.log(`[CheckinService] 昨日 (${yesterdayStr}) 報告已上傳，跳過`);
            return;
        }

        // 取得昨日統計
        try {
            const yesterdayStats = await storageService.getStatsByDate(yesterdayStr);
            if (!yesterdayStats || yesterdayStats.total === 0) {
                console.log(`[CheckinService] 昨日 (${yesterdayStr}) 無數據，跳過補傳`);
                return;
            }

            // 取得詳細統計
            const detailedStats = await storageService.getDetailedStats(yesterdayStr);

            console.log(`[CheckinService] 補傳昨日 (${yesterdayStr}) 報告...`);
            const result = await this.submitProductivityReport(yesterdayStats, yesterdayStr, detailedStats);

            if (result.success) {
                console.log(`[CheckinService] 昨日報告補傳成功`);
            }
        } catch (error) {
            console.error(`[CheckinService] 補傳昨日報告失敗:`, error.message);
        }
    }

    // 上傳今日報告（可選擇傳入 reminderService 以附加未完成提醒）
    async submitTodayReport(storageService, reminderService) {
        const boundEmployee = this.config.getBoundEmployee();
        if (!boundEmployee) return;

        const today = this._formatDate(new Date());

        try {
            const todayStats = await storageService.getTodayStats();
            if (!todayStats || todayStats.total === 0) {
                console.log('[CheckinService] 今日無數據，跳過上傳');
                return;
            }

            // 取得詳細統計
            const detailedStats = await storageService.getDetailedStats(today);

            // 在詳細記錄最前面插入未完成提醒事項
            if (reminderService) {
                const uncompletedText = reminderService.getUncompletedText();
                if (uncompletedText) {
                    detailedStats.detailText = detailedStats.detailText
                        ? (uncompletedText + '\n' + detailedStats.detailText)
                        : uncompletedText;
                }
            }

            console.log('[CheckinService] 上傳今日報告...');
            const result = await this.submitProductivityReport(todayStats, today, detailedStats);

            if (result.success) {
                this.config.setLastReportDate(today);
                console.log('[CheckinService] 今日報告上傳成功');
            }

            return result;
        } catch (error) {
            console.error('[CheckinService] 上傳今日報告失敗:', error.message);
            return { success: false, message: error.message };
        }
    }

    // 日期格式化工具
    _formatDate(date) {
        const year = date.getFullYear();
        const month = String(date.getMonth() + 1).padStart(2, '0');
        const day = String(date.getDate()).padStart(2, '0');
        return `${year}-${month}-${day}`;
    }
}

module.exports = { CheckinService };
