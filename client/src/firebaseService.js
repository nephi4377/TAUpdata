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
        this.messageBuffer = new Map(); // [v2.2.8.6] 訊息整合緩衝 (Anti-Spam)
        
        // [v2.2.8.7] 訊息持久化去重 (Deduplication)
        this.processedMessages = new Set(this.config.get('processedMessageIds') || []);
        this.contentFingerprints = new Set(); // 內存內容指紋 (防止 Webhook 重試)

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

        // [v26.03.15] 監聽 iCloud 網址雲端同步 (一處設定，處處生效)
        const icRef = ref(this.db, 'settings/icloud_config');
        onChildAdded(icRef, (snapshot) => this._handleIcloudSync(snapshot.val()));
        // 同時監聽更新
        const { onValue } = require('firebase/database');
        onValue(icRef, (snapshot) => {
            const val = snapshot.val();
            if (val) this._handleIcloudSync(val);
        });

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
        
        // [v2.2.8.7] 雙重去重：ID 持久化比對 + 內容指紋比對
        const senderUid = data.senderUid || data.senderId || data.userId;
        const fingerprint = `${senderUid}:${data.message}`;

        if (this.processedMessages.has(msgId) || this.contentFingerprints.has(fingerprint)) {
            console.log(`[Firebase] ♻️ 跳過重複訊息 (ID 或內容已處理): ${msgId}`);
            this.removeMessage(msgId).catch(() => {});
            return;
        }

        // [v2.2.8.6] 訊息智慧整合 (Batching)
        this.processedMessages.add(msgId);
        this.contentFingerprints.add(fingerprint);
        
        // 持久化保存 ID (限制最近 100 筆)
        const idList = Array.from(this.processedMessages).slice(-100);
        this.config.set('processedMessageIds', idList);
        
        // 分流：若為員工則直接清理並略過提醒
        const apiBridge = this.reminderService.apiBridge;
        if (apiBridge && apiBridge.isEmployee(data.senderName, senderUid)) {
            console.log(`[Firebase] 🔇 靜默過濾內部員工訊息: ${data.senderName} (${senderUid || 'no-uid'})`);
            this.removeMessage(msgId).catch(() => {});
            return;
        }

        // 若非員工，進入緩衝池
        this._bufferMessage(senderUid, data, msgId);
    }

    /**
     * 將訊息放入緩衝，2秒內同發送者合併
     */
    _bufferMessage(senderUid, data, msgId) {
        const key = senderUid || data.senderName;
        let buffer = this.messageBuffer.get(key);

        if (!buffer) {
            buffer = {
                senderName: data.senderName,
                senderUid: senderUid,
                source: data.source || 'line',
                messages: [],
                msgIds: [],
                timer: null
            };
            this.messageBuffer.set(key, buffer);
        }

        // 加入新內容
        buffer.messages.push(data.message);
        buffer.msgIds.push(msgId);

        // 重設計時器 (每次新訊息進來延展 2秒)
        if (buffer.timer) clearTimeout(buffer.timer);
        
        buffer.timer = setTimeout(() => {
            this._flushBuffer(key);
        }, 2000);
    }

    /**
     * 沖刷緩衝並送出提醒
     */
    async _flushBuffer(key) {
        const buffer = this.messageBuffer.get(key);
        if (!buffer) return;

        // 合併訊息文字 (用 | 分隔)
        const combinedMessage = buffer.messages.join(' | ');
        
        // 1. 轉換為 Reminder 格式 (用於清單與歷史)
        const notification = {
            id: `firebase_batch_${Date.now()}`,
            source: buffer.source,
            senderName: buffer.senderName,
            title: `[${buffer.source.toUpperCase()}] ${buffer.senderName}`,
            message: combinedMessage,
            icon: buffer.source === 'line' ? '💬' : '🔵',
            isExternal: true,
            siteName: '即時通知整合',
            createdAt: new Date().toISOString()
        };

        // 呼叫提醒服務進行推播與持久化
        this.reminderService.pushExternalNotification(notification);

        // 2. 同步推送到小助手對話氣泡 (秘書報告) - 僅發送一次整合成員
        const mascotText = `秘書報告：${buffer.source.toUpperCase()}「${buffer.senderName}」傳來 ${buffer.messages.length} 則訊息：${combinedMessage}`;
        if (this.monitorService && this.monitorService.statsWindow && !this.monitorService.statsWindow.isDestroyed()) {
            this.monitorService.statsWindow.webContents.send('push-mascot-msg', { text: mascotText, priority: 1 });
        }

        console.log(`[Firebase] 📦 已送出合併提醒 (${buffer.messages.length} 筆): ${buffer.senderName}`);

        // 從 Firebase 批次物理移除
        for (const mid of buffer.msgIds) {
            this.removeMessage(mid).catch(() => {});
        }

        // 清除緩衝
        this.messageBuffer.delete(key);
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

    /**
     * [v26.03.15] 處理 iCloud 網址雲端同步
     */
    _handleIcloudSync(data) {
        if (!data || !data.url) return;
        const currentUrl = this.config.getIcloudCalendarUrl();
        if (data.url !== currentUrl) {
            console.log(`[Firebase] 🔗 偵測到雲端 iCloud 網址變更，正在同步...`);
            this.config.setIcloudCalendarUrl(data.url);
            
            // 立即觸發一次同步
            if (this.reminderService && this.reminderService.apiBridge) {
                this.reminderService.apiBridge.syncAllIcloudReminders(this.reminderService);
            }
        }
    }

    /**
     * [v26.03.15] 將 iCloud 網址推送到雲端
     */
    async uploadIcloudUrl(url) {
        if (!this.db) return;
        try {
            const icRef = ref(this.db, 'settings/icloud_config');
            await set(icRef, {
                url: url,
                updatedAt: Date.now(),
                updatedBy: this.config.getBoundEmployee()?.userName || '未知'
            });
            console.log('[Firebase] iCloud 網址已同步至雲端');
        } catch (e) {
            console.error('[Firebase] 雲端同步失敗:', e.message);
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
