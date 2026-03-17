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
        this.userDataPath = app ? app.getPath('userData') : path.join(process.cwd(), 'temp_userData');
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
                // [v2.0.8] 檢查黑名單
                if (versionService.isVersionFailed(latestVersion)) {
                    log.info(`[PatchUpdater] 版本 v${latestVersion} 曾發生過失敗，跳過補丁更新。`);
                    return false;
                }
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
                    if (!isManual) {
                        try {
                            autoUpdater.autoDownload = false; // 禁用自動下載以免自帶對話框跳出亂碼
                            // 自行監聽 update-available 處理 (若無監聽則這裡只先觸發檢查)
                            autoUpdater.checkForUpdates();
                        } catch (err) {
                            log.error('AutoUpdater check error:', err);
                        }
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
            if (!isManual) {
                autoUpdater.autoDownload = false;
                autoUpdater.checkForUpdates().catch(e => log.error('[AutoUpdater] backoff error:', e));
            }
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
                        // [v2026.03.17 Fix] 核心過濾：只接受正式發布且非草稿版本，防止 Pre-release 污染
                        if (parsed.prerelease || parsed.draft) {
                            log.info(`[PatchUpdater] 跳過非正式發布版本: ${parsed.tag_name} (Pre-release/Draft)`);
                            return resolve(null);
                        }
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
            if (fs.existsSync(extractTempPath)) {
                await fs.promises.rm(extractTempPath, { recursive: true, force: true });
            }
            await fs.promises.mkdir(extractTempPath, { recursive: true });

            const zip = new AdmZip(tempZipPath);
            zip.extractAllTo(extractTempPath, true);

            // [v2026.03.17 Pre-flight Check] 結構預檢：防止補丁打包偏移事故 (3/12 Lesson)
            const expectedSrcPath = path.join(extractTempPath, 'src');
            if (!fs.existsSync(expectedSrcPath)) {
                log.error(`[PatchUpdater] 預檢失敗：補丁結構偏移！找不到 /src 目錄。`);
                throw new Error('補丁目錄結構不正確 (MISSING_SRC_DIR)，更新已中止以保護母體。');
            }
            
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
                await fs.promises.writeFile(patchVersionFile, JSON.stringify({ version: latestVersion }, null, 2));

                app.emit('patch-downloaded', tempZipPath);
            } else {
                log.warn(`[PatchUpdater] 健康檢查失敗，啟動自動回退！`);
                await versionService.rollback();
                // [v2.0.8] 紀錄失敗，避免無限循環
                await versionService.recordFailedVersion(latestVersion);
                throw new Error('新版本健康檢查未通過，已自動回退至原版本。');
            }

        } catch (error) {
            log.error(`[PatchUpdater] 更新過程發生異常: ${error.message}`);
            throw error;
        } finally {
            // 清理暫存檔
            try {
                if (fs.existsSync(tempZipPath)) await fs.promises.rm(tempZipPath, { force: true });
                if (fs.existsSync(extractTempPath)) await fs.promises.rm(extractTempPath, { recursive: true, force: true });
            } catch (e) {
                log.warn('[PatchUpdater] 清理暫存檔失敗:', e.message);
            }
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
        // [v2026.03.17] 委託給 versionService 進行精準 Semver 比對
        return versionService.compareVersions(v1, v2);
    }
}

// [v1.18.35] 攔截 electron-updater 原生的 HTML Release Note 對話框
autoUpdater.on('update-available', (info) => {
    log.info('[AutoUpdater] 發現全量更新:', info.version);
    const cleanNotes = info.releaseNotes
        ? info.releaseNotes.toString().replace(/<[^>]*>?/gm, '') // 拔除 HTML 標籤
        : '包含系統穩定性與效能提升。';

    dialog.showMessageBox({
        type: 'info',
        title: '發現新版本',
        message: `發現新版本 v${info.version}，正在背景下載中...\n\n更新內容：\n${cleanNotes}`,
        buttons: ['確定']
    });

    autoUpdater.downloadUpdate();
});

autoUpdater.on('update-downloaded', () => {
    dialog.showMessageBox({
        type: 'info',
        title: '更新準備就緒',
        message: '核心套件已下載完成，將在下次啟動時安裝。',
        buttons: ['確定']
    });
});

autoUpdater.on('error', (err) => {
    log.error('[AutoUpdater] 全量更新失敗:', err);
});

module.exports = {
    patchUpdater: new PatchUpdater()
};
