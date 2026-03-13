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

        // 暫存與版本路徑必須放在可讀寫的 userData 下
        try {
            this.userDataPath = app ? app.getPath('userData') : path.join(process.cwd(), 'temp_userData');
        } catch (e) {
            this.userDataPath = path.join(process.cwd(), 'temp_userData');
        }

        // [v1.18.32] 修正核心災難：將 clientPath 導向可讀寫的 userData/app_patches，與 hotReloader 對齊
        this.clientPath = path.join(this.userDataPath, 'app_patches');

        this.versionsPath = path.join(this.userDataPath, 'versions');
        this.tempPath = path.join(this.userDataPath, 'temp_updates');
        this.patchVersionFile = path.join(this.userDataPath, 'patch_version.json');
        this.failedVersionsFile = path.join(this.userDataPath, 'failed_versions.json');

        // 確保必要目錄存在
        if (!fs.existsSync(this.clientPath)) fs.mkdirSync(this.clientPath, { recursive: true });
        if (!fs.existsSync(this.versionsPath)) fs.mkdirSync(this.versionsPath, { recursive: true });
        if (!fs.existsSync(this.tempPath)) fs.mkdirSync(this.tempPath, { recursive: true });

        // [v1.18.34] 自動防禦：啟動時檢查並清理降級的補丁
        this.enforceBaseVersionPriority();
    }

    /**
     * 回報健康事件 (Stub)
     * [v1.18.32] 補回此函式，避免 main.js 呼叫時拋出 TypeError 導致二次崩潰
     */
    async reportHealthEvent(event, data) {
        log.warn(`[VersionManager] Health Event: ${event}`, data);
        // 實作可留空或後續擴充雲端回報邏輯
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
        let healthCheckPath = path.join(this.clientPath, 'src', 'healthCheck.js');

        if (!fs.existsSync(healthCheckPath)) {
            // [v1.18.37] 如果補丁沒有，就去找原生安裝包裡的 (因為 enforceBaseVersionPriority 會把補丁刪掉)
            healthCheckPath = path.join(this.basePath, 'src', 'healthCheck.js');
            if (!fs.existsSync(healthCheckPath)) {
                log.error(`[VersionManager] 找不到 healthCheck.js (原廠與補丁皆無)`);
                return false;
            }
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
        let baseVersion = '2.2.9.0';
        try {
            if (app && app.getVersion) baseVersion = app.getVersion();
            else baseVersion = require('../../package.json').version || '2.2.9.0';
        } catch (e) { }
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

    /**
     * [v1.18.34] 防禦舊補丁覆蓋新 Base 的問題
     * 如果 EXE 的版本號 >= 目前已套用的補丁版本號，就強制清理 app_patches 與 patch_version.json
     */
    enforceBaseVersionPriority() {
        try {
            const baseVersion = this.getBaseVersion();
            if (fs.existsSync(this.patchVersionFile)) {
                const data = JSON.parse(fs.readFileSync(this.patchVersionFile, 'utf8'));
                const patchVersion = data.version ? data.version.toString() : null;

                // 如果 Base >= Patch，代表用戶安裝了新版 EXE，舊補丁已經過期且可能有害
                if (patchVersion && this.compareVersions(baseVersion, patchVersion) >= 0) {
                    log.info(`[VersionManager] 偵測到原生 EXE 版本 (v${baseVersion}) >= 補丁版本 (v${patchVersion})，正在清理過期補丁...`);

                    // 同步清理，確保後續 require 絕對不會吃到過期檔案
                    if (fs.existsSync(this.clientPath)) {
                        fs.rmSync(this.clientPath, { recursive: true, force: true });
                        fs.mkdirSync(this.clientPath, { recursive: true }); // 重建空殼給熱更新預備
                    }
                    if (fs.existsSync(this.patchVersionFile)) {
                        fs.unlinkSync(this.patchVersionFile);
                    }
                    log.info(`[VersionManager] 舊補丁清理完成，安全交由原生 EXE 執行。`);
                }
            }
        } catch (e) {
            log.error('[VersionManager] enforceBaseVersionPriority 執行失敗:', e.message);
        }
    }

    getBaseVersion() {
        try {
            if (app && app.getVersion) return app.getVersion();
            return require('../../package.json').version || '2.2.9.0';
        } catch (e) {
            return '2.2.9.0';
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

    /**
     * [v2.0.8] 紀錄更新失敗的版本，避免無限循環
     */
    async recordFailedVersion(version) {
        try {
            let failed = [];
            if (fs.existsSync(this.failedVersionsFile)) {
                failed = JSON.parse(fs.readFileSync(this.failedVersionsFile, 'utf8'));
            }
            if (!failed.includes(version)) {
                failed.push(version);
                await fs.promises.writeFile(this.failedVersionsFile, JSON.stringify(failed, null, 2));
                log.warn(`[VersionManager] 已紀錄失敗版本: ${version}`);
            }
        } catch (e) {
            log.error(`[VersionManager] 錄製失敗版本異常: ${e.message}`);
        }
    }

    /**
     * [v2.0.8] 檢查版本是否已列入黑名單
     */
    isVersionFailed(version) {
        try {
            if (fs.existsSync(this.failedVersionsFile)) {
                const failed = JSON.parse(fs.readFileSync(this.failedVersionsFile, 'utf8'));
                return failed.includes(version);
            }
        } catch (e) { }
        return false;
    }
}

module.exports = {
    versionService: new VersionManager()
};
