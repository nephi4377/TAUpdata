const { app } = require('electron');
const path = require('path');
const fs = require('fs'); // 回歸原生 fs
const log = require('electron-log');

// [v1.18.21] 去依賴化對抗性修復：殼層 (Shell) 嚴禁依賴第三方 fs-extra，確保啟動絕對穩定。
const fsp = fs.promises;

class VersionManager {
    constructor() {
        // [v1.18.31] 專家級路徑防禦：確保在打包環境與開發環境下路徑一致
        this.basePath = app ? app.getAppPath() : process.cwd();
        this.clientPath = path.join(this.basePath, 'client');

        // 暫存與版本路徑必須放在可讀寫的 userData 下
        try {
            this.userDataPath = app ? app.getPath('userData') : path.join(process.cwd(), 'temp_userData');
        } catch (e) {
            this.userDataPath = path.join(process.cwd(), 'temp_userData');
        }

        this.versionsPath = path.join(this.userDataPath, 'versions');
        this.tempPath = path.join(this.userDataPath, 'temp_updates');
        this.patchVersionFile = path.join(this.userDataPath, 'patch_version.json');

        // 確保必要目錄存在
        if (!fs.existsSync(this.versionsPath)) fs.mkdirSync(this.versionsPath, { recursive: true });
        if (!fs.existsSync(this.tempPath)) fs.mkdirSync(this.tempPath, { recursive: true });
    }

    /**
     * 遞迴複製目錄 (原生 fs 實現)
     */
    async _copyDir(src, dest) {
        await fsp.mkdir(dest, { recursive: true });
        const entries = await fsp.readdir(src, { withFileTypes: true });

        for (const entry of entries) {
            const srcPath = path.join(src, entry.name);
            const destPath = path.join(dest, entry.name);

            if (entry.isDirectory()) {
                await this._copyDir(srcPath, destPath);
            } else {
                await fsp.copyFile(srcPath, destPath);
            }
        }
    }

    /**
     * 遞迴刪除目錄 (原生 fs 實現)
     */
    async _removeDir(dir) {
        if (fs.existsSync(dir)) {
            await fsp.rm(dir, { recursive: true, force: true });
        }
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
                await this._copyDir(this.clientPath, backupDir);
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
     */
    async applyUpdate(sourceDir) {
        log.info(`[VersionManager] 開始原子化切換目錄...`);
        const oldBackup = path.join(this.versionsPath, 'latest_stable_bak');

        try {
            // 1. 清理舊的臨時備份
            await this._removeDir(oldBackup);

            // 2. 將當前 client 移至臨時備份 (原生 rename)
            if (fs.existsSync(this.clientPath)) {
                await fsp.rename(this.clientPath, oldBackup);
            }

            // 3. 將新版本移至 client
            const excludedFiles = ['main.js', 'src/hotReloader.js', 'src/versionService.js'];

            // 使用帶 filter 的手動複製
            const copyWithFilter = async (src, dest, baseSource) => {
                await fsp.mkdir(dest, { recursive: true });
                const entries = await fsp.readdir(src, { withFileTypes: true });

                for (const entry of entries) {
                    const srcPath = path.join(src, entry.name);
                    const destPath = path.join(dest, entry.name);
                    const relativePath = path.relative(baseSource, srcPath).replace(/\\/g, '/');

                    if (excludedFiles.includes(relativePath)) {
                        log.info(`[VersionManager] 跳過受保護檔案: ${relativePath}`);
                        continue;
                    }

                    if (entry.isDirectory()) {
                        await copyWithFilter(srcPath, destPath, baseSource);
                    } else {
                        await fsp.copyFile(srcPath, destPath);
                    }
                }
            };

            await copyWithFilter(sourceDir, this.clientPath, sourceDir);

            // 4. 清理暫存源目錄
            await this._removeDir(sourceDir);

            log.info(`[VersionManager] 目錄切換完成`);
            await this.cleanOldVersions();
        } catch (err) {
            log.error(`[VersionManager] 原子切換失敗，嘗試還原...: ${err.message}`);
            if (fs.existsSync(oldBackup) && !fs.existsSync(this.clientPath)) {
                await fsp.rename(oldBackup, this.clientPath);
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
            await this._removeDir(this.clientPath);
            await fsp.rename(oldBackup, this.clientPath);
            log.info(`[VersionManager] 已回退至上一個穩定快照`);
            return true;
        }

        log.error(`[VersionManager] 回退失敗：找不到穩定備份目錄`);
        return false;
    }

    /**
     * 孤兒檔案清理
     */
    async cleanOldVersions() {
        try {
            if (!fs.existsSync(this.versionsPath)) return;

            const dirs = await fsp.readdir(this.versionsPath);
            const versionDirs = [];

            for (const d of dirs) {
                if (d.startsWith('v-')) {
                    const stats = await fsp.stat(path.join(this.versionsPath, d));
                    versionDirs.push({ name: d, time: stats.mtime.getTime() });
                }
            }

            versionDirs.sort((a, b) => b.time - a.time); // 降序排列

            if (versionDirs.length > 5) {
                const toDelete = versionDirs.slice(5);
                for (const d of toDelete) {
                    log.info(`[VersionManager] 清理舊版本備份: ${d.name}`);
                    await this._removeDir(path.join(this.versionsPath, d.name));
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
                const data = JSON.parse(fs.readFileSync(this.patchVersionFile, 'utf8'));
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

    getBaseVersion() {
        try {
            return app.getVersion();
        } catch (e) {
            return '1.18.20';
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
