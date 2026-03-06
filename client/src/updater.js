const { app, dialog } = require('electron');
const { autoUpdater } = require('electron-updater');
const https = require('https');
const fs = require('fs');
const path = require('path');
const log = require('electron-log');
const AdmZip = require('adm-zip');
const os = require('os');
const { versionService } = require('./versionService');

class PatchUpdater {
    constructor() {
        this.repoOwner = 'nephi4377';
        this.repoName = 'TAUpdata';
        this.userDataPath = app.getPath('userData');
        this.patchDirPath = path.join(this.userDataPath, 'app_patches');
    }

    /**
     * 讀取當前有效版本 (含已套用的補丁版本)
     */
    getCurrentConfiguredVersion() {
        return versionService.getEffectiveVersion();
    }

    /**
     * 檢查 GitHub 最新版本並比對目前版本
     */
    async checkForUpdates(isManual = false) {
        log.info('[PatchUpdater] 開始檢查補丁更新...');

        try {
            const releaseInfo = await this.fetchLatestRelease();
            if (!releaseInfo) {
                if (isManual) this.showNoUpdateDialog();
                return;
            }

            const latestVersion = releaseInfo.tag_name.replace(/^v/, '');
            const currentVersion = this.getCurrentConfiguredVersion();

            log.info(`[PatchUpdater] 目前版本: ${currentVersion} / 最新版本: ${latestVersion}`);

            if (this.compareVersions(latestVersion, currentVersion) > 0) {
                log.info(`[PatchUpdater] 發現新版本 v${latestVersion}，尋找增量補丁檔...`);

                const patchAsset = releaseInfo.assets.find(asset =>
                    asset.name.startsWith('patch-') && asset.name.endsWith('.zip')
                );

                if (patchAsset) {
                    log.info(`[PatchUpdater] 找到增量補丁檔: ${patchAsset.name}，準備下載解壓...`);

                    if (isManual) {
                        dialog.showMessageBox({
                            type: 'info',
                            title: '發現新版本',
                            message: `發現增量補丁 v${latestVersion}，正在背景下載更新...\n下載完成後，視圖會自動刷新套用。`,
                            buttons: ['確定']
                        });
                    }

                    await this.downloadAndApplyPatch(patchAsset.browser_download_url, patchAsset.name, latestVersion);
                    return true; // 告知有補丁更新
                } else {
                    log.info('[PatchUpdater] 最新 Release 不含 patch.zip，退回全量 autoUpdater');
                    // 沒有補丁包，交由原版 electron-updater 處理
                    if (isManual) {
                        // 在 main 內會呼叫
                        return false;
                    } else {
                        autoUpdater.checkForUpdates();
                    }
                }
            } else {
                log.info('[PatchUpdater] 當前為最新版本');
                if (isManual) this.showNoUpdateDialog();
            }
        } catch (error) {
            log.error('[PatchUpdater] 檢查更新異常:', error);
            if (isManual) {
                dialog.showErrorBox('檢查更新失敗', `發生網路錯誤或 API 異常：\n${error.message}`);
            }
            // 退回全量 autoUpdater
            if (!isManual) autoUpdater.checkForUpdates();
        }
        return false;
    }

    showNoUpdateDialog() {
        dialog.showMessageBox({
            type: 'info',
            title: '檢查更新',
            message: '目前已是最新版本！',
            buttons: ['確定']
        });
    }

    fetchLatestRelease() {
        return new Promise((resolve, reject) => {
            const options = {
                hostname: 'api.github.com',
                path: `/repos/${this.repoOwner}/${this.repoName}/releases/latest`,
                method: 'GET',
                headers: {
                    'User-Agent': 'Tienxin-App'
                }
            };

            https.get(options, (res) => {
                let data = '';

                if (res.statusCode !== 200) {
                    if (res.statusCode === 404) {
                        return resolve(null); // No releases
                    }
                    return reject(new Error(`API Error: ${res.statusCode}`));
                }

                res.on('data', chunk => data += chunk);
                res.on('end', () => {
                    try {
                        const parsed = JSON.parse(data);
                        resolve(parsed);
                    } catch (e) {
                        reject(e);
                    }
                });
            }).on('error', reject);
        });
    }

    async downloadAndApplyPatch(url, filename, latestVersion) {
        const tempZipPath = path.join(os.tmpdir(), filename);
        const extractTempPath = path.join(versionService.tempPath, `patch_v${latestVersion}`);

        try {
            log.info(`[PatchUpdater] 開始下載補丁: ${url}`);
            await this.downloadFile(url, tempZipPath);

            log.info(`[PatchUpdater] 下載完成，開始解壓縮至暫存目錄: ${extractTempPath}`);
            if (fs.existsSync(extractTempPath)) await fs.remove(extractTempPath);
            await fs.ensureDir(extractTempPath);

            const zip = new AdmZip(tempZipPath);
            zip.extractAllTo(extractTempPath, true);

            // 執行熱更新原子化流程
            log.info(`[PatchUpdater] 進入原子化交換流程...`);

            // 1. 備份
            await versionService.backup();

            // 2. 套用更新
            await versionService.applyUpdate(extractTempPath);

            // 3. 健康檢查
            const isHealthy = await versionService.validate();

            if (isHealthy) {
                log.info(`[PatchUpdater] 健康檢查通過，正式套用版本 v${latestVersion}`);
                const patchVersionFile = path.join(this.userDataPath, 'patch_version.json');
                await fs.writeJson(patchVersionFile, { version: latestVersion });

                app.emit('patch-downloaded', tempZipPath);
            } else {
                log.warn(`[PatchUpdater] 健康檢查失敗，啟動自動回退！`);
                await versionService.rollback();
                throw new Error('新版本健康檢查未通過，已自動回退至原版本。');
            }

        } catch (error) {
            log.error(`[PatchUpdater] 更新過程發生異常: ${error.message}`);
            throw error;
        } finally {
            // 清理暫存檔
            if (fs.existsSync(tempZipPath)) await fs.remove(tempZipPath);
            if (fs.existsSync(extractTempPath)) await fs.remove(extractTempPath);
        }
    }

    downloadFile(url, dest) {
        return new Promise((resolve, reject) => {
            const file = fs.createWriteStream(dest);
            https.get(url, (response) => {
                if (response.statusCode === 301 || response.statusCode === 302) {
                    return https.get(response.headers.location, (redir) => {
                        redir.pipe(file);
                        file.on('finish', () => file.close(resolve));
                    }).on('error', reject);
                }
                if (response.statusCode !== 200) return reject(new Error(`HTTP ${response.statusCode}`));
                response.pipe(file);
                file.on('finish', () => file.close(resolve));
            }).on('error', reject);
        });
    }

    compareVersions(v1, v2) {
        return versionService.compareVersions(v1, v2);
    }
}

module.exports = {
    patchUpdater: new PatchUpdater()
};
