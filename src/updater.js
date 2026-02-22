const { app, dialog } = require('electron');
const { autoUpdater } = require('electron-updater');
const https = require('https');
const fs = require('fs');
const path = require('path');
const log = require('electron-log');
const AdmZip = require('adm-zip');
const os = require('os');

class PatchUpdater {
    constructor() {
        this.repoOwner = 'nephi4377';
        this.repoName = 'TAUpdata';
        this.userDataPath = app.getPath('userData');
        this.patchDirPath = path.join(this.userDataPath, 'app_patches');
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
            const currentVersion = app.getVersion();

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

                    await this.downloadAndApplyPatch(patchAsset.browser_download_url, patchAsset.name);
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

    downloadAndApplyPatch(url, filename) {
        return new Promise((resolve, reject) => {
            const tempZipPath = path.join(os.tmpdir(), filename);
            const file = fs.createWriteStream(tempZipPath);

            const request = https.get(url, (response) => {
                // Handle redirection (GitHub Releases usually redirects to AWS S3)
                if (response.statusCode === 301 || response.statusCode === 302) {
                    return https.get(response.headers.location, (redirectResponse) => {
                        redirectResponse.pipe(file);
                        this.handleFileStream(file, tempZipPath, resolve, reject);
                    }).on('error', reject);
                }

                if (response.statusCode !== 200) {
                    return reject(new Error(`下載失敗，狀態碼: ${response.statusCode}`));
                }

                response.pipe(file);
                this.handleFileStream(file, tempZipPath, resolve, reject);
            }).on('error', reject);
        });
    }

    handleFileStream(file, tempZipPath, resolve, reject) {
        file.on('finish', () => {
            file.close(() => {
                log.info(`[PatchUpdater] 補丁下載完成: ${tempZipPath}，準備解壓縮套用...`);
                try {
                    // 解壓縮
                    if (!fs.existsSync(this.patchDirPath)) {
                        fs.mkdirSync(this.patchDirPath, { recursive: true });
                    }

                    const zip = new AdmZip(tempZipPath);
                    // 覆蓋解壓至 patch 目錄
                    zip.extractAllTo(this.patchDirPath, true);

                    log.info(`[PatchUpdater] 解壓縮完成，準備觸發內部熱重啟`);

                    // 觸發 application event
                    app.emit('patch-downloaded', tempZipPath);

                    resolve();
                } catch (e) {
                    log.error('[PatchUpdater] 解壓縮失敗:', e);
                    reject(e);
                } finally {
                    // 清理暫存
                    try {
                        if (fs.existsSync(tempZipPath)) {
                            fs.unlinkSync(tempZipPath);
                        }
                    } catch (ignore) { }
                }
            });
        });
    }

    compareVersions(v1, v2) {
        const parts1 = v1.split('.').map(Number);
        const parts2 = v2.split('.').map(Number);
        for (let i = 0; i < Math.max(parts1.length, parts2.length); i++) {
            const p1 = parts1[i] || 0;
            const p2 = parts2[i] || 0;
            if (p1 > p2) return 1;
            if (p1 < p2) return -1;
        }
        return 0;
    }
}

module.exports = {
    patchUpdater: new PatchUpdater()
};
