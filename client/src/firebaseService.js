const { initializeApp } = require('firebase/app');
const { getDatabase, ref, onChildAdded, off, set, remove } = require('firebase/database');
const os = require('os');

/**
 * =============================================================================
 * 檔案名稱: firebaseService.js
 * 專案名稱: 添心即時通訊服務 (Firebase) v1.0
 * 說明: 負責監聽雲端即時訊息 (LINE/FB)，並轉發至小助手提醒系統。
 * =============================================================================
 */
class FirebaseService {
    constructor(configManager, reminderService, monitorService) {
        this.config = configManager;
        this.reminderService = reminderService;
        this.monitorService = monitorService;
        this.db = null;
        this.activeUserId = null;
        this.activeRef = null;

        // 總監提供的 Firebase 配置
        this.firebaseConfig = {
            apiKey: "AIzaSyApr3pKxW9Ukot6_QRJ2WunlQD8R4DImoQ",
            authDomain: "brave-calling-391208.firebaseapp.com",
            databaseURL: "https://brave-calling-391208-default-rtdb.asia-southeast1.firebasedatabase.app",
            projectId: "brave-calling-391208",
            storageBucket: "brave-calling-391208.firebasestorage.app",
            messagingSenderId: "274903284381",
            appId: "1:274903284381:web:be4c60d23357af39a2f274",
            measurementId: "G-P32VPSR69L"
        };
    }

    async init() {
        if (this.db && this.activeRef) {
            console.log('[Firebase] 服務已在運行中，跳過重複初始化。');
            return;
        }

        try {
            const bound = this.config.getBoundEmployee();
            if (!bound || !bound.userId) {
                console.warn('[Firebase] ⚠️ 無法啟動監聽：尚未綁定使用者 (Missing UserId)');
                return;
            }

            console.log(`[Firebase] 正在連接至即時通知中心 (${this.firebaseConfig.projectId})...`);
            if (!this.db) {
                const app = initializeApp(this.firebaseConfig);
                this.db = getDatabase(app);
            }

            this.startListening(bound.userId);
        } catch (error) {
            console.error('[Firebase] 啟動失敗:', error.message);
        }
    }

    /**
     * 切換監聽的使用者 (例如重新綁定時)
     */
    startListening(userId) {
        if (this.activeRef) {
            console.log(`[Firebase] 正在關閉舊的監聽節點 [${this.activeUserId}]...`);
            off(this.activeRef);
            this.activeRef = null;
        }

        this.activeUserId = userId;
        console.log(`[Firebase] 開始監聽使用者 [${userId}] 的新訊息...`);

        // 監聽 notifications 節點下該使用者的子節點
        this.activeRef = ref(this.db, `notifications/${userId}`);

        // 使用 onChildAdded 監聽新訊息
        onChildAdded(this.activeRef, (snapshot) => {
            const msg = snapshot.val();
            if (!msg) return;

            // [v1.18.3 優化] 檢查是否為過舊的訊息 (放寬至 30 分鐘，避免不同 PC 時差問題)
            const thirtyMinutesAgo = Date.now() - (30 * 60 * 1000);
            if (msg.timestamp && msg.timestamp < thirtyMinutesAgo && !this.config.getDebugMode()) {
                console.log(`[Firebase] ⚠️ 跳過過期訊息 (已超過 30min): ${msg.message}`);
                return;
            }

            this.processIncomingMessage(snapshot.key, msg);
        });

        console.log(`[Firebase] ✨ 監聽器啟動成功，正在接收 [${userId}] 的即時通知...`);
    }

    /**
     * 處理新收到的訊息內容
     */
    async processIncomingMessage(msgId, data) {
        if (!this.processedMessages) this.processedMessages = new Set();
        if (this.processedMessages.has(msgId)) return; // 內存重複過濾

        console.log(`[Firebase] 收到新訊息 [${msgId}]:`, data.message);
        this.processedMessages.add(msgId);

        if (!this.reminderService) return;

        // 轉換為 Reminder 格式
        const notification = {
            id: `firebase_${msgId}`,
            source: data.source,
            senderName: data.senderName,
            title: `[${data.source.toUpperCase()}] ${data.senderName}`,
            message: data.message,
            icon: data.source === 'line' ? '💬' : '🔵',
            isExternal: true,
            siteName: data.siteName || '系統通知',
            createdAt: new Date(data.timestamp || Date.now()).toISOString()
        };

        // 呼叫提醒服務進行推播與持久化
        this.reminderService.pushExternalNotification(notification);

        // [v1.17.4] 同步推送到小助手對話氣泡 (秘書報告)
        const mascotText = `秘書報告：LINE「${data.senderName}」傳來訊息：${data.message}`;
        if (this.monitorService && this.monitorService.statsWindow && !this.monitorService.statsWindow.isDestroyed()) {
            this.monitorService.statsWindow.webContents.send('push-mascot-msg', { text: mascotText, priority: 1 });
        }

        // [v1.18.1] 重要：閉環同步 - 成功接收後立即移除 Firebase 上的資料
        try {
            const msgRef = ref(this.db, `notifications/${this.activeUserId}/${msgId}`);
            await remove(msgRef);
            console.log(`[Firebase] 已成功清理雲端訊息節點 [${msgId}]`);
        } catch (err) {
            console.error(`[Firebase] 清理訊息失敗 [${msgId}]:`, err.message);
        }
    }

    /**
     * [v26.03.04 新增] 更新 Firebase 直連心跳
     * @param {string} status - 當前狀態 (work/idle)
     * @param {string} appName - 當前使用的應用程式
     */
    async updateHeartbeat(status = 'work', appName = '') {
        try {
            if (!this.db || !this.activeUserId) return;

            const hbRef = ref(this.db, `userStatus/${this.activeUserId}`);
            const payload = {
                userName: this.config.getBoundEmployee()?.userName || '未知員工',
                pcName: os.hostname() || '未知電腦',
                status: status,
                appName: appName,
                lastHeartbeat: Date.now(),
                version: '1.18.5-hb'
            };

            await set(hbRef, payload);
            // console.log(`[Firebase] 心跳已更新: ${this.activeUserId} (${status})`);
        } catch (error) {
            console.error('[Firebase] 心跳更新失敗:', error.message);
        }
    }

    stop() {
        if (this.activeRef) {
            off(this.activeRef);
            console.log('[Firebase] 已停止即時通訊監聽。');
        }
    }
}

module.exports = { FirebaseService };
