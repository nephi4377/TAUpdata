const fs = require('fs-extra');
const path = require('path');
const logger = require('electron-log');
// [IMMUTABLE_SHELL] -----------------------------------------------------------
// 【核心承重牆 - 安全傘】此檔案屬於「不可變殼層 (Immutable Shell)」。
// 職責: 處理原子交換、版本快照、以及災難性的自動版本回退 (Rollback)。
// =============================================================================
// =============================================================================
class VersionManager {
    constructor() {
        // [v26.03.01] 改用穩定目錄計算，防止 process.cwd() 偏移
        this.basePath = path.resolve(__dirname, '..', '..');
        this.clientPath = path.join(this.basePath, 'client');
        this.versionsDir = path.join(this.basePath, 'versions');
        this.tempUpdateDir = path.join(this.basePath, 'update_temp');

        if (!fs.existsSync(this.versionsDir)) {
            fs.ensureDirSync(this.versionsDir);
        }
    }

    /**
     * [v1.17.8] 雲端跳火警：向後端回報異常事件
     */
    async reportHealthEvent(type, details) {
        try {
            // [v1.17.8 穩定性補強] 自動搜尋現有的 API 實例
            let bridge = null;
            try {
                // 如果 appCore 已初始化，從全域獲取實例
                const { appCore } = require('../main');
                if (appCore && appCore.services && appCore.services.apiBridge) {
                    bridge = appCore.services.apiBridge;
                }
            } catch (e) { }

            const eventData = {
                type: type,
                timestamp: new Date().toISOString(),
                details: details
            };

            if (bridge && typeof bridge.reportErrorLog === 'function') {
                await bridge.reportErrorLog(eventData);
            } else {
                logger.warn('[HealthReport] 找不到作用中的 ApiBridge，轉為本地紀錄', eventData);
            }
        } catch (e) {
            logger.error('[HealthReport] 無法回報事件:', e.message);
        }
    }

    /**
     * 建立目前版本的快照
     */
    async createSnapshot() {
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const snapshotDir = path.join(this.versionsDir, `v-${timestamp}`);
        logger.info(`[Version] 建立快照至: ${snapshotDir}`);
        await fs.copy(this.clientPath, snapshotDir, {
            filter: (src) => !src.includes('node_modules') && !src.includes('.git')
        });
        return snapshotDir;
    }

    /**
     * 原子交換：將暫存區的新版本替換至生產區
     */
    async atomicSwap() {
        if (!fs.existsSync(this.tempUpdateDir)) {
            throw new Error('找不到暫存更新目錄 (update_temp)');
        }

        const backupPath = path.join(this.basePath, 'client_backup_tmp');

        try {
            logger.info('[Version] 執行原子交換流程...');

            // 1. 備份目前 client (重新命名)
            if (fs.existsSync(backupPath)) await fs.remove(backupPath);
            await fs.move(this.clientPath, backupPath);

            // 2. 將暫存區移動至 client
            await fs.move(this.tempUpdateDir, this.clientPath);

            // 3. 嘗試執行健康檢查 (需在外部由 AppCore 啟動後執行)
            logger.info('[Version] 原子交換成功，請重啟並執行健康檢查。');

            // 延遲刪除舊備份
            setTimeout(() => fs.remove(backupPath).catch(() => { }), 30000);
            return true;
        } catch (err) {
            logger.error(`[Version] 原子交換失敗，準備自動復原: ${err.message}`);
            // 災難復原
            if (fs.existsSync(backupPath) && !fs.existsSync(this.clientPath)) {
                await fs.move(backupPath, this.clientPath);
            }
            throw err;
        }
    }

    /**
     * 自動回退至最新一個穩定版本
     */
    async rollback() {
        logger.warn('[Version] 🚨 啟動自動回退機制...');
        const versions = fs.readdirSync(this.versionsDir)
            .filter(d => d.startsWith('v-'))
            .sort()
            .reverse();

        if (versions.length === 0) {
            logger.error('[Version] 找不到任何可用快照，無法回退！');
            return false;
        }

        const lastStable = path.join(this.versionsDir, versions[0]);
        logger.info(`[Version] 恢復至穩定版本: ${versions[0]}`);

        try {
            // 安全覆蓋 (不移動，保留快照)
            await fs.copy(lastStable, this.clientPath, { overwrite: true });
            logger.info('[Version] 回退完成，系統將重新啟動。');
            return true;
        } catch (err) {
            logger.error(`[Version] 回退重大失敗: ${err.message}`);
            return false;
        }
    }

    /**
     * 健康檢查橋接 (由 AppCore 調用)
     */
    async performHealthCheck() {
        try {
            const { runHealthCheck } = require('./healthCheck');
            await runHealthCheck();
            return true;
        } catch (err) {
            return false;
        }
    }
}

module.exports = new VersionManager();
