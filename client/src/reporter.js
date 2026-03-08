// v1.1 - 2026-02-01 17:31 (Asia/Taipei)
// 修改內容: 完善資料回報服務，支援設定和手動觸發

const schedule = require('node-schedule');
const https = require('https');
const http = require('http');

class ReporterService {
    constructor(configManager, storageService, pcName) {
        this.configManager = configManager;
        this.storageService = storageService;
        this.pcName = pcName;

        this.apiUrl = null;
        this.apiKey = null;
        this.reportJob = null;

        this.isReporting = false;
        this.lastReportTime = null;
        this.lastReportSuccess = null;
        this.lastReportMessage = null;

        this.loadConfig();

        console.log('[Reporter] 回報服務已建立');
    }

    // 載入設定
    loadConfig() {
        this.apiUrl = this.configManager.get('apiUrl') || null;
        this.apiKey = this.configManager.get('apiKey') || 'tienxin-productivity-2026';

        if (this.apiUrl) {
            console.log(`[Reporter] API URL: ${this.apiUrl}`);
        } else {
            console.log('[Reporter] 尚未設定 API URL，上傳功能已停用');
        }
    }

    // 更新設定
    updateConfig(apiUrl, apiKey) {
        this.apiUrl = apiUrl;
        this.apiKey = apiKey || 'tienxin-productivity-2026';
        this.configManager.set('apiUrl', apiUrl);
        this.configManager.set('apiKey', this.apiKey);
        console.log('[Reporter] 設定已更新');
    }

    // 啟動定時回報排程（每小時的第 5 分鐘）
    startSchedule() {
        if (!this.apiUrl) {
            console.log('[Reporter] 尚未設定 API URL，跳過排程啟動');
            return;
        }

        // 每小時第 5 分鐘執行回報
        this.reportJob = schedule.scheduleJob('5 * * * *', async () => {
            console.log('[Reporter] 執行定時回報...');
            await this.reportNow();
        });

        console.log('[Reporter] 定時回報排程已啟動（每小時第 5 分鐘）');
    }

    // 停止排程
    stopSchedule() {
        if (this.reportJob) {
            this.reportJob.cancel();
            this.reportJob = null;
        }
        console.log('[Reporter] 定時回報排程已停止');
    }

    // 立即執行回報 (Aggregation Logic Implemented)
    async reportNow() {
        if (this.isReporting) return { success: false, reason: 'already_reporting' };
        if (!this.apiUrl) return { success: false, reason: 'no_api_url' };

        this.isReporting = true;

        try {
            // 1. 取得待同步資料
            const unsyncedData = await this.storageService.getUnsyncedData();
            if (unsyncedData.length === 0) {
                this.isReporting = false;
                this.lastReportTime = new Date();
                this.lastReportSuccess = true;
                return { success: true, synced: 0 };
            }

            console.log(`[Reporter] 準備處理 ${unsyncedData.length} 筆原始資料...`);

            // 2. 依日期分組 (YYYY-MM-DD)
            const dailyGroups = {};
            for (const row of unsyncedData) {
                const d = row.date; // DB stored as YYYY-MM-DD
                if (!dailyGroups[d]) dailyGroups[d] = [];
                dailyGroups[d].push(row);
            }

            let totalSynced = 0;
            const categoryMap = { 'work': '工作', 'idle': '閒置', 'leisure': '休閒', 'music': '音樂', 'other': '未分類' };

            // 3. 逐日彙總並發送
            for (const dateKey of Object.keys(dailyGroups)) {
                const rows = dailyGroups[dateKey];

                // 初始化統計
                let workMinutes = 0, idleMinutes = 0, leisureMinutes = 0, otherMinutes = 0, musicMinutes = 0;
                let appAggregates = {}; // { '【工作】': { 'App Name': 10 } }
                const unclassifiedList = new Set();

                rows.forEach(r => {
                    const mins = Math.round(r.total_seconds / 60);
                    if (mins <= 0) return; // Skip < 1 min

                    const cat = r.category || 'other';
                    if (cat === 'work') workMinutes += mins;
                    else if (cat === 'idle') idleMinutes += mins;
                    else if (cat === 'leisure') leisureMinutes += mins;
                    else if (cat === 'music') musicMinutes += mins;
                    else otherMinutes += mins;

                    // Detail Aggregation
                    const catLabel = `【${categoryMap[cat] || '未分類'}】`;
                    if (!appAggregates[catLabel]) appAggregates[catLabel] = {};

                    const appName = r.window_title || r.app_name || 'Unknown';
                    // 簡單聚合：只看 App Name (忽略視窗標題差異以縮短長度?) 
                    // 用戶範例: "Splashtop... 36m"
                    // 若要詳細到視窗標題:
                    const detailKey = appName;
                    if (!appAggregates[catLabel][detailKey]) appAggregates[catLabel][detailKey] = 0;
                    appAggregates[catLabel][detailKey] += mins;

                    if (cat === 'other') unclassifiedList.add(appName);
                });

                // 產生詳細文字 (Detail Text)
                let detailLines = [];
                // 優先順序: 未完成提醒?, 工作, 休閒, 未分類, 閒置
                // "未完成提醒" 客戶端無法產生，略過
                const orderedCats = ['【工作】', '【休閒】', '【未分類】', '【閒置】'];

                orderedCats.forEach(label => {
                    if (appAggregates[label]) {
                        detailLines.push(label);
                        // Sort apps by time desc
                        const apps = Object.entries(appAggregates[label]).sort((a, b) => b[1] - a[1]);
                        apps.forEach(([name, m]) => {
                            // Format duration: 65 -> 1h5m
                            const h = Math.floor(m / 60);
                            const min = m % 60;
                            const timeStr = h > 0 ? `${h}h${min}m` : `${min}m`;
                            detailLines.push(`  ${name} ${timeStr}`);
                        });
                    }
                });

                // [v2.2.8] 公式校正：有効工時 / (工作+休閒+其他+音樂)
                const workEfficient = workMinutes + otherMinutes;
                const activeTotal = workEfficient + leisureMinutes + musicMinutes;
                const productivityRate = activeTotal > 0 ? Math.round((workEfficient / activeTotal) * 100) : 0;

                const payload = {
                    pcName: this.pcName,
                    userId: this.userId, // 若為 null，後端會用 pcName 查
                    userName: this.userName,
                    date: dateKey, // YYYY-MM-DD
                    workMinutes,
                    idleMinutes,
                    leisureMinutes,
                    otherMinutes,
                    musicMinutes,
                    lunchMinutes: 0, // 暫無偵測午休
                    productivityRate,
                    detailText: detailLines.join('\n'),
                    unclassifiedKeywords: Array.from(unclassifiedList).join(', ')
                };

                // 發送請求
                console.log(`[Reporter] 發送 ${dateKey} 報表 (Work: ${workMinutes}m)`);
                const result = await this.sendReport(payload);

                if (result.success) {
                    // Mark Processed
                    for (const row of rows) {
                        await this.storageService.markAsSynced(row.min_id, row.max_id);
                    }
                    totalSynced += rows.length;
                    this.lastReportSuccess = true;
                } else {
                    console.error(`[Reporter] 發送 ${dateKey} 失敗: ${result.error}`);
                    this.lastReportSuccess = false;
                    this.lastReportMessage = result.error;
                }
            }

            this.lastReportTime = new Date();
            this.lastReportMessage = `成功回報 ${totalSynced} 筆資料`;
            this.isReporting = false;
            return { success: true, synced: totalSynced };

        } catch (error) {
            console.error('[Reporter] 回報發生錯誤:', error.message);
            this.isReporting = false;
            return { success: false, error: error.message };
        }
    }

    // 發送 HTTP 請求 (含指數退避重試)
    async sendReport(data) {
        const maxRetries = 3;
        let attempt = 0;

        while (attempt <= maxRetries) {
            try {
                return await this._doRequest(data);
            } catch (error) {
                attempt++;
                if (attempt > maxRetries) {
                    console.error(`[Reporter] 發送失敗，已達最大重試次數 (${maxRetries}):`, error.message);
                    return { success: false, error: error.message };
                }

                // 指數退避: 2s, 4s, 8s...
                const delay = Math.pow(2, attempt) * 1000;
                console.log(`[Reporter] 發送失敗: ${error.message}，${delay / 1000} 秒後重試 (${attempt}/${maxRetries})...`);
                await new Promise(resolve => setTimeout(resolve, delay));
            }
        }
    }

    // 實際執行 HTTP 請求
    _doRequest(data) {
        return new Promise((resolve, reject) => {
            try {
                const url = new URL(this.apiUrl);
                const isHttps = url.protocol === 'https:';
                const httpModule = isHttps ? https : http;

                const postData = JSON.stringify({
                    action: 'submit_productivity_report',
                    apiKey: this.apiKey,
                    data: data
                });

                const options = {
                    hostname: url.hostname,
                    port: url.port || (isHttps ? 443 : 80),
                    path: url.pathname + url.search,
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Content-Length': Buffer.byteLength(postData)
                    },
                    timeout: 30000
                };

                // console.log(`[Reporter] 發送請求到: ${url.hostname}`);

                const req = httpModule.request(options, (res) => {
                    let responseData = '';

                    res.on('data', (chunk) => {
                        responseData += chunk;
                    });

                    res.on('end', () => {
                        try {
                            // 檢查 HTTP 狀態碼
                            if (res.statusCode >= 500) {
                                reject(new Error(`伺服器錯誤 (${res.statusCode})`));
                                return;
                            }

                            const response = JSON.parse(responseData);
                            if (response.success) {
                                resolve({ success: true, message: response.message });
                            } else {
                                // 業務邏輯錯誤 (如 API Key 錯誤) 通常不需重試，但這裡回傳 false 讓呼叫者決定
                                resolve({ success: false, error: response.error || '伺服器回應失敗' });
                            }
                        } catch (e) {
                            reject(new Error('無法解析伺服器回應'));
                        }
                    });
                });

                req.on('error', (error) => {
                    reject(new Error(error.message));
                });

                req.on('timeout', () => {
                    req.destroy();
                    reject(new Error('請求逾時'));
                });

                req.write(postData);
                req.end();

            } catch (error) {
                reject(error);
            }
        });
    }

    // 註冊電腦
    async registerPC(employeeName, department) {
        if (!this.apiUrl) {
            return { success: false, error: '尚未設定 API URL' };
        }

        return new Promise((resolve) => {
            try {
                const url = new URL(this.apiUrl);
                const isHttps = url.protocol === 'https:';
                const httpModule = isHttps ? https : http;

                const postData = JSON.stringify({
                    action: 'register',
                    apiKey: this.apiKey,
                    data: {
                        pcName: this.pcName,
                        employeeName: employeeName,
                        department: department
                    }
                });

                const options = {
                    hostname: url.hostname,
                    port: url.port || (isHttps ? 443 : 80),
                    path: url.pathname + url.search,
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Content-Length': Buffer.byteLength(postData)
                    },
                    timeout: 30000
                };

                const req = httpModule.request(options, (res) => {
                    let responseData = '';

                    res.on('data', (chunk) => {
                        responseData += chunk;
                    });

                    res.on('end', () => {
                        try {
                            const response = JSON.parse(responseData);
                            resolve(response);
                        } catch (e) {
                            resolve({ success: false, error: '無法解析伺服器回應' });
                        }
                    });
                });

                req.on('error', (error) => {
                    resolve({ success: false, error: error.message });
                });

                req.write(postData);
                req.end();

            } catch (error) {
                resolve({ success: false, error: error.message });
            }
        });
    }

    // 取得回報狀態
    getStatus() {
        return {
            apiUrl: this.apiUrl ? '已設定' : '未設定',
            apiUrlValue: this.apiUrl || null,
            lastReportTime: this.lastReportTime,
            lastReportSuccess: this.lastReportSuccess,
            lastReportMessage: this.lastReportMessage,
            isReporting: this.isReporting
        };
    }
}

module.exports = { ReporterService };
