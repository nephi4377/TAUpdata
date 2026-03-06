// v1.1 - 2026-02-14 14:10 (Asia/Taipei)
// 修改內容: 新增 CheckinSystem API 設定、管理者密碼、員工綁定功能

const Store = require('electron-store');
const { app } = require('electron');
const { v4: uuidv4 } = require('uuid');
const { versionService } = require('./versionService');

// ═══════════════════════════════════════════════════════════════
// 管理者密碼設定
// 用途：切換使用者時需要輸入此密碼
// 修改方式：直接修改下面的字串即可
// ═══════════════════════════════════════════════════════════════
// ═══════════════════════════════════════════════════════════════
// 管理者密碼設定 (已廢棄硬編碼，改用 AES 加密存儲於 Config)
// ═══════════════════════════════════════════════════════════════
const crypto = require('crypto');
const ENCRYPTION_KEY = 'tienxin-productivity-secret-key-2026'; // 固定混淆金鑰
const IV_LENGTH = 16;

function encrypt(text) {
    if (!text) return null;
    const iv = crypto.randomBytes(IV_LENGTH);
    const cipher = crypto.createCipheriv('aes-256-cbc', Buffer.from(ENCRYPTION_KEY.padEnd(32).slice(0, 32)), iv);
    let encrypted = cipher.update(text);
    encrypted = Buffer.concat([encrypted, cipher.final()]);
    return iv.toString('hex') + ':' + encrypted.toString('hex');
}

function decrypt(text) {
    if (!text) return null;
    try {
        const textParts = text.split(':');
        if (textParts.length !== 2) return text; // 非加密格式，直接回傳
        const iv = Buffer.from(textParts[0], 'hex');
        const encryptedText = Buffer.from(textParts[1], 'hex');
        const decipher = crypto.createDecipheriv('aes-256-cbc', Buffer.from(ENCRYPTION_KEY.padEnd(32).slice(0, 32)), iv);
        let decrypted = decipher.update(encryptedText);
        decrypted = Buffer.concat([decrypted, decipher.final()]);
        return decrypted.toString();
    } catch (e) {
        return text; // 解密失敗回傳原始值 (相容舊資料)
    }
}

// ═══════════════════════════════════════════════════════════════
// CheckinSystem API 設定
// 用途：與打卡系統後端通訊
// ═══════════════════════════════════════════════════════════════
// [v2.2.7 Restore ID v231] SOP Fix: Updated existing deployment to fix 404
const CHECKIN_API_URL = 'https://script.google.com/macros/s/AKfycbz5-DUPNNciVdvE5wrOogNgxYt8EpDZppAe9f2cUh8pW9y3i29fB6n0RA5r-A5KuAiz/exec';

// [v1.11.24] 分店經緯度定義 (使用者提供精確座標)
const STORE_LOCATIONS = {
    '台南店': { lat: 22.983908, lon: 120.1860286 },
    '高雄店': { lat: 22.6383363, lon: 120.3271388 }
};

const path = require('path');
const fs = require('fs');

// 設定資料儲存目錄 (Portable Mode for Development)
// 在打包後 (isPackaged) 使用系統預設 AppData，避免寫入 asar 失敗
const DATA_DIR = path.join(__dirname, '..', 'data');

class ConfigManager {
    constructor() {
        const options = {
            name: 'tienxin-productivity-config',
            defaults: {
                // 客戶端唯一識別碼
                clientId: null,

                // API 設定（保留舊欄位，未來可擴充其他 API）
                apiUrl: null,
                apiKey: null,

                // 監測設定
                sampleIntervalSeconds: 30,
                reportIntervalMinutes: 60,

                // 分類規則（從後端同步）
                classificationRules: null,

                // 使用者設定
                autoStart: true,
                showNotifications: true,
                autoOpenBrowser: true,

                // 首次執行標記
                isFirstRun: true,

                // 最後同步時間
                lastConfigSync: null,

                // ═══ 生產力助手整合（v1.1 新增）═══

                // 綁定的員工資訊
                // 格式: { userId, userName, shiftStart, shiftEnd, flexibleMinutes, group, boundAt }
                boundEmployee: null,

                // [v2.2.4 Fix] 自訂電腦名稱 (Override hostname)
                pcName: null,

                // 最後一次上傳生產力報告的日期 (YYYY-MM-DD)
                lastReportUploadDate: null,

                // 今日打卡資訊（啟動時從後端取得）
                // 格式: { checkedIn, checkinTime, expectedOffTime, remainingMinutes }
                todayWorkInfo: null,

                // iCloud 行事曆公開訂閱網址
                icloudCalendarUrl: null,

                // [v1.10.2] 分店設定
                storeLocations: STORE_LOCATIONS,

                // [v1.11.10] 秘書性別設定 (female / male)
                mascotGender: 'female',
                mascotSkin: 'default',
                lastSkinChangeDate: null,

                // [v1.15.9] 生產力助手：開發測試與自動化驗證控制 (一次性關閉/開啟)
                debugMode: true
            }
        };

        // 僅在開發模式下強制指定本地目錄
        if (!app.isPackaged) {
            if (!fs.existsSync(DATA_DIR)) {
                fs.mkdirSync(DATA_DIR, { recursive: true });
            }
            options.cwd = DATA_DIR;
        }

        // 設定 Store
        this.store = new Store(options);

        console.log('[Config] 設定管理服務已建立');
    }

    // 初始化
    async init() {
        // 檢查是否需要遷移舊設定 (從 AppData 到 Portable Data)
        if (!this.store.get('clientId')) {
            try {
                const userDataPath = app.getPath('userData');
                const oldConfigPath = path.join(userDataPath, 'tienxin-productivity-config.json');

                if (fs.existsSync(oldConfigPath)) {
                    console.log('[Config] 發現舊設定檔，正在遷移至 Data 目錄...');
                    const oldData = JSON.parse(fs.readFileSync(oldConfigPath, 'utf8'));
                    this.store.store = oldData;
                    console.log('[Config] 設定遷移完成');
                }
            } catch (err) {
                console.error('[Config] 遷移舊設定失敗:', err);
            }
        }

        // 如果沒有 clientId，產生一個
        if (!this.store.get('clientId')) {
            const clientId = uuidv4();
            this.store.set('clientId', clientId);
            console.log(`[Config] 已產生客戶端 ID: ${clientId}`);
        }

        console.log(`[Config] 客戶端 ID: ${this.store.get('clientId')}`);
        console.log(`[Config] 設定檔路徑: ${this.store.path}`);

        // 顯示綁定狀態
        const bound = this.getBoundEmployee();
        if (bound) {
            console.log(`[Config] 已綁定員工: ${bound.userName} (${bound.userId})`);
        } else {
            console.log('[Config] 尚未綁定員工，將啟動設定流程。');
        }
    }

    // 取得設定值
    get(key) {
        if (key === 'lastNotifiedPatch') {
            // 為了不讓舊版唯讀的主程序(main.js)跳出 alert，直接無條件回傳目前的有效版本
            return versionService.getEffectiveVersion();
        }
        return this.store.get(key);
    }

    // 設定值
    set(key, value) {
        this.store.set(key, value);
    }

    // 取得所有設定
    getAll() {
        return this.store.store;
    }

    // 取得自動開啟瀏覽器設定
    getAutoOpenBrowser() {
        return this.store.get('autoOpenBrowser');
    }

    // 設定自動開啟瀏覽器
    setAutoOpenBrowser(value) {
        this.store.set('autoOpenBrowser', value);
    }

    // 重設為預設值
    reset() {
        this.store.clear();
        console.log('[Config] 設定已重設');
    }

    // 匯出設定
    export() {
        return JSON.stringify(this.store.store, null, 2);
    }

    // 匯入設定
    import(jsonString) {
        try {
            const config = JSON.parse(jsonString);
            // 不要覆蓋 clientId
            delete config.clientId;

            for (const [key, value] of Object.entries(config)) {
                this.store.set(key, value);
            }

            console.log('[Config] 設定已匯入');
            return true;
        } catch (error) {
            console.error('[Config] 匯入設定失敗:', error.message);
            return false;
        }
    }

    // 設定 API 連線資訊
    setApiConfig(url, key) {
        this.store.set('apiUrl', url);
        this.store.set('apiKey', key);
        console.log('[Config] API 設定已更新');
    }

    // 檢查是否已設定 API
    isApiConfigured() {
        return !!this.store.get('apiUrl');
    }

    // 標記首次執行完成
    markFirstRunComplete() {
        this.store.set('isFirstRun', false);
    }

    // 是否首次執行
    isFirstRun() {
        return this.store.get('isFirstRun');
    }

    // ═══ 生產力助手整合方法（v1.1 新增）═══

    // 取得 CheckinSystem API URL
    getCheckinApiUrl() {
        return CHECKIN_API_URL;
    }

    // 驗證管理者密碼
    verifyAdminPassword(inputPassword) {
        // 從 Store 取得已儲存的密碼 (優先)
        const storedHash = this.store.get('adminPassword');
        if (storedHash) {
            const decrypted = decrypt(storedHash);
            return inputPassword === decrypted;
        }
        // Fallback: 首次執行尚未遷移時，比對預設值並遷移
        if (inputPassword === 'Tx2649819') {
            this.setAdminPassword('Tx2649819'); // 自動遷移加密
            return true;
        }
        return false;
    }

    /**
     * [v1.11.23 修復] 判定當前使用者是否具備管理員權限
     */
    isAdmin() {
        const bound = this.getBoundEmployee();
        if (!bound) return false;

        // 1. 根據組別判定
        if (bound.group && (bound.group === 'BOSS' || bound.group === 'Admin')) return true;

        // 2. 根據權限等級判定 (>= 5 為管理員)
        if (bound.permissionLevel && parseInt(bound.permissionLevel) >= 5) return true;

        // 3. 根據使用者名稱硬編碼 (針對特定管理者)
        if (bound.userName === '黃俊豪' || bound.userId === 'nephi4377') return true;

        return false;
    }

    // 設定管理者密碼
    setAdminPassword(password) {
        this.store.set('adminPassword', encrypt(password));
    }

    // 取得 API Key (解密)
    getApiKey() {
        return decrypt(this.store.get('apiKey'));
    }

    // 設定 API Key (加密)
    setApiKey(key) {
        this.store.set('apiKey', encrypt(key));
    }

    // 取得已綁定的員工資訊
    getBoundEmployee() {
        return this.store.get('boundEmployee');
    }

    // 是否已綁定員工
    isEmployeeBound() {
        return !!this.store.get('boundEmployee');
    }

    // 綁定員工
    bindEmployee(employeeData) {
        const bindInfo = {
            ...employeeData,
            boundAt: new Date().toISOString()
        };
        this.store.set('boundEmployee', bindInfo);
        console.log(`[Config] 已綁定員工: ${employeeData.userName}`);
        return bindInfo;
    }

    // 解除綁定
    unbindEmployee() {
        const current = this.store.get('boundEmployee');
        this.store.set('boundEmployee', null);
        if (current) {
            console.log(`[Config] 已解除綁定: ${current.userName}`);
        }
    }

    // 記錄最後上傳日期
    setLastReportDate(dateStr) {
        this.store.set('lastReportUploadDate', dateStr);
    }

    // 取得最後上傳日期
    getLastReportDate() {
        return this.store.get('lastReportUploadDate');
    }

    // 更新今日打卡資訊
    setTodayWorkInfo(workInfo) {
        this.store.set('todayWorkInfo', workInfo);
    }

    // 取得今日打卡資訊
    getTodayWorkInfo() {
        return this.store.get('todayWorkInfo');
    }

    // 取得電腦名稱 (優先使用設定值，否則使用 hostname)
    getPcName() {
        const os = require('os');
        return this.store.get('pcName') || os.hostname();
    }

    // 設定電腦名稱
    setPcName(name) {
        this.store.set('pcName', name);
    }

    // 別名 (相容 main.js)
    updateWorkInfo(workInfo) {
        this.setTodayWorkInfo(workInfo);
    }

    // --- iCloud 訂閱網址 ---
    getIcloudCalendarUrl() {
        return this.store.get('icloudCalendarUrl');
    }

    setIcloudCalendarUrl(url) {
        this.store.set('icloudCalendarUrl', url);
        console.log('[Config] 已更新 iCloud 訂閱網址');
    }

    // [v1.11.1] 私人小秘書與進階提醒升級
    // [v1.10.2] 取得分店位置
    getStoreLocations() {
        return this.store.get('storeLocations') || STORE_LOCATIONS;
    }

    // [v1.11.10] 秘書性別管理
    getMascotGender() {
        return this.store.get('mascotGender') || 'female';
    }

    setMascotGender(gender) {
        this.store.set('mascotGender', gender);
        console.log(`[Config] 秘書性別已切換為: ${gender}`);
    }

    getMascotSkin() {
        return this.store.get('mascotSkin') || 'default';
    }

    setMascotSkin(skin) {
        this.store.set('mascotSkin', skin);
        console.log(`[Config] 秘書裝束已更換為: ${skin}`);
    }

    getLastSkinChangeDate() {
        return this.store.get('lastSkinChangeDate');
    }

    setLastSkinChangeDate(dateStr) {
        this.store.set('lastSkinChangeDate', dateStr);
    }

    getDebugMode() {
        return this.store.get('debugMode') ?? true;
    }

    setDebugMode(value) {
        this.store.set('debugMode', value);
        console.log(`[Config] Debug Mode 已${value ? '開啟' : '關閉'}`);
    }
}

module.exports = { ConfigManager };
