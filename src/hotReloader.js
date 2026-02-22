const fs = require('fs');
const path = require('path');
const { app } = require('electron');
const log = require('electron-log');

class HotReloader {
    constructor() {
        // 開發環境與打包環境的 userData 目錄一致
        this.userDataPath = app.getPath('userData');
        this.patchDirPath = path.join(this.userDataPath, 'app_patches');
    }

    /**
     * 安全載入模組 (具備熔斷機制)
     * @param {string} moduleName - 模組名稱，例如 'monitor' 
     * @param {string} localPath - 備用本地原路徑，相對於 client 目錄，例如 './src/monitor'
     */
    loadModuleSafely(moduleName, localPath) {
        const patchFilePath = path.join(this.patchDirPath, 'src', `${moduleName}.js`);

        // 檢查是否有補丁檔存在
        if (fs.existsSync(patchFilePath)) {
            try {
                // 清除快取以強制重新讀取
                const resolvedPatchPath = require.resolve(patchFilePath);
                if (require.cache[resolvedPatchPath]) {
                    delete require.cache[resolvedPatchPath];
                }

                log.info(`[HotReloader] 找到 ${moduleName} 補丁，嘗試加載...`);
                // 嘗試引入補丁 (此處即為沙盒測試，若語法錯誤會直接扔出 Exception)
                const module = require(patchFilePath);
                log.info(`[HotReloader] ${moduleName} 補丁加載成功`);
                return module;
            } catch (err) {
                // 補丁故障，觸發熔斷
                log.error(`[HotReloader] 補丁故障，觸發熔斷回退 (${moduleName}):`, err.message);

                // 標記該補丁為損壞 (改名或者移除，避免下次繼續報錯)
                try {
                    const corruptPath = `${patchFilePath}.corrupted_${Date.now()}`;
                    fs.renameSync(patchFilePath, corruptPath);
                    log.info(`[HotReloader] 已將損壞的補丁隔離至: ${corruptPath}`);
                } catch (fsErr) {
                    log.error(`[HotReloader] 無法隔離損壞的補丁:`, fsErr.message);
                }
            }
        }

        // 若無補丁或補丁熔斷，則加載內建原本的模組
        // 清除原始模組快取，確保重新加載
        const resolvedLocalPath = require.resolve(localPath);
        if (require.cache[resolvedLocalPath]) {
            delete require.cache[resolvedLocalPath];
        }

        return require(localPath);
    }
}

// 導出單例
module.exports = {
    hotReloader: new HotReloader()
};
