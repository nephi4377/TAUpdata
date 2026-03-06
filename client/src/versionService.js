// v1.0 - 2026-02-23 15:15 (Asia/Taipei)
// 修改內容: 建立版本管理服務，統一處理基礎版本與補丁版本的判定，避免主程式硬編碼瑕疵

const { app } = require('electron');
const path = require('path');
const fs = require('fs-extra'); // 使用 fs-extra 簡化目錄操作
const log = require('electron-log');

class VersionManager {
    constructor() {
        this.basePath = path.join(process.cwd());
        this.clientPath = path.join(this.basePath, 'client');
        this.versionsPath = path.join(this.basePath, 'versions');
        this.tempPath = path.join(this.basePath, 'temp_updates');

        // 防禦性檢查：支援非 Electron 環境測試
        try {
            this.userDataPath = app ? app.getPath('userData') : path.join(this.basePath, 'temp_userData');
        } catch (e) {
            this.userDataPath = path.join(this.basePath, 'temp_userData');
        }
        this.patchVersionFile = path.join(this.userDataPath, 'patch_version.json');
    }

    /**
     * 備份當前 client 目錄
     */
    async backup() {
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const backupDir = path.join(this.versionsPath, `v-${timestamp}`);
        log.info(`[VersionManager] 開始備份至: ${backupDir}`);

        try {
            if (fs.existsSync(this.clientPath)) {
                await fs.copy(this.clientPath, backupDir);
                log.info(`[VersionManager] 備份成功`);
                return backupDir;
            }
            log.warn(`[VersionManager] client 目錄不存在，跳過備份`);
            return null;
        } catch (err) {
            log.error(`[VersionManager] 備份失敗: ${err.message}`);
            throw err;
        }
    }

    /**
     * 原子化應用更新
     * @param {string} sourceDir 暫存的新版本目錄
     */
    async applyUpdate(sourceDir) {
        log.info(`[VersionManager] 開始原子化切換目錄...`);
        const oldBackup = path.join(this.versionsPath, 'latest_stable_bak');

        try {
            // 1. 清理舊的臨時備份
            if (fs.existsSync(oldBackup)) await fs.remove(oldBackup);

            // 2. 將當前 client 移至臨時備份 (原子操作第一步)
            if (fs.existsSync(this.clientPath)) {
                await fs.move(this.clientPath, oldBackup);
            }

            // 3. 將新版本移至 client (原子操作第二步)
            // [v1.17.9] 排除保護檔案，防止更新覆蓋指揮塔
            const excludedFiles = ['main.js', 'src/hotReloader.js', 'src/versionManager.js', 'src/versionService.js'];

            await fs.copy(sourceDir, this.clientPath, {
                overwrite: true,
                filter: (src) => {
                    const relativePath = path.relative(sourceDir, src).replace(/\\/g, '/');
                    if (excludedFiles.includes(relativePath)) {
                        log.info(`[VersionManager] 跳過受保護檔案: ${relativePath}`);
                        return false;
                    }
                    return true;
                }
            });

            // 4. 清理暫存源目錄
            await fs.remove(sourceDir);

            log.info(`[VersionManager] 目錄切換完成`);

            // [v1.17.9] 套用成功後執行孤兒檔案清理
            await this.cleanOldVersions();
        } catch (err) {
            log.error(`[VersionManager] 原子切換失敗，嘗試還原...: ${err.message}`);
            if (fs.existsSync(oldBackup) && !fs.existsSync(this.clientPath)) {
                await fs.move(oldBackup, this.clientPath);
            }
            throw err;
        }
    }

    /**
     * 健康檢查
     */
    async validate() {
        log.info(`[VersionManager] 執行健康檢查...`);
        const healthCheckPath = path.join(this.clientPath, 'src', 'healthCheck.js');

        if (!fs.existsSync(healthCheckPath)) {
            log.error(`[VersionManager] 找不到 healthCheck.js`);
            return false;
        }

        try {
            // 模擬啟動環境或執行特定檢查邏輯
            const healthCheck = require(healthCheckPath);
            const result = await healthCheck.run();
            return result === true;
        } catch (err) {
            log.error(`[VersionManager] 健康檢查執行崩潰: ${err.message}`);
            return false;
        }
    }

    /**
     * 回退至上一個穩定版本
     */
    async rollback() {
        log.info(`[VersionManager] 啟動緊急回退機制...`);
        const oldBackup = path.join(this.versionsPath, 'latest_stable_bak');

        if (fs.existsSync(oldBackup)) {
            await fs.remove(this.clientPath);
            await fs.move(oldBackup, this.clientPath);
            log.info(`[VersionManager] 已回退至上一個穩定快照`);
            return true;
        }

        log.error(`[VersionManager] 回退失敗：找不到穩定備份目錄`);
        return false;
    }

    /**
     * [v1.17.9] 孤兒檔案清理：僅保留最後 5 個版本備份
     */
    async cleanOldVersions() {
        try {
            if (!fs.existsSync(this.versionsPath)) return;

            const dirs = await fs.readdir(this.versionsPath);
            const versionDirs = dirs
                .filter(d => d.startsWith('v-'))
                .map(d => ({ name: d, time: fs.statSync(path.join(this.versionsPath, d)).mtime.getTime() }))
                .sort((a, b) => b.time - a.time); // 降序排列

            if (versionDirs.length > 5) {
                const toDelete = versionDirs.slice(5);
                for (const d of toDelete) {
                    log.info(`[VersionManager] 清理舊版本備份: ${d.name}`);
                    await fs.remove(path.join(this.versionsPath, d.name));
                }
            }
        } catch (e) {
            log.error(`[VersionManager] 版本清理失敗: ${e.message}`);
        }
    }

    /**
     * 取得當前有效版本號 (相容舊邏輯)
     */
    getEffectiveVersion() {
        const baseVersion = app.getVersion();
        try {
            if (fs.existsSync(this.patchVersionFile)) {
                const data = fs.readJsonSync(this.patchVersionFile);
                const patchVersion = data.version ? data.version.toString() : null;
                if (patchVersion && this.compareVersions(patchVersion, baseVersion) > 0) {
                    return patchVersion;
                }
            }
        } catch (e) {
            log.error('[Version] 讀取補丁版本失敗:', e.message);
        }
        return baseVersion;
    }

    /**
     * 取得主要包版本 (asar 內的版本)
     */
    getBaseVersion() {
        try {
            return app.getVersion();
        } catch (e) {
            return '1.11.33'; // Fallback
        }
    }

    compareVersions(v1, v2) {
        if (!v1) return -1;
        if (!v2) return 1;
        const cleanV1 = v1.toString().replace(/^v/i, '');
        const cleanV2 = v2.toString().replace(/^v/i, '');
        const parts1 = cleanV1.split('.').map(part => parseInt(part, 10) || 0);
        const parts2 = cleanV2.split('.').map(part => parseInt(part, 10) || 0);
        const length = Math.max(parts1.length, parts2.length);
        for (let i = 0; i < length; i++) {
            const p1 = parts1[i] || 0;
            const p2 = parts2[i] || 0;
            if (p1 > p2) return 1;
            if (p1 < p2) return -1;
        }
        return 0;
    }
}

module.exports = {
    versionService: new VersionManager()
};
