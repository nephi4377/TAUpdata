const fs = require('fs');
const path = require('path');
const { app } = require('electron');
const log = require('electron-log');
const Module = require('module');

class HotReloader {
    get userDataPath() {
        return app.getPath('userData');
    }

    get patchDirPath() {
        return path.join(this.userDataPath, 'app_patches');
    }

    /**
     * 安全載入模組 (具備熔斷機制與原生路徑模擬)
     * @param {string} moduleName - 模組名稱，例如 'monitor' 
     * @param {string} localPath - 備用本地原路徑，相對於 client 目錄，例如 './src/monitor'
     */
    loadModuleSafely(moduleName, localPath) {
        const absoluteLocalPath = path.resolve(__dirname, '..', localPath);
        const patchFilePath = path.join(this.patchDirPath, 'src', `${moduleName}.js`);

        const loadOriginal = () => {
            const resolvedLocalPath = require.resolve(absoluteLocalPath);
            if (require.cache[resolvedLocalPath]) {
                delete require.cache[resolvedLocalPath];
            }
            return require(absoluteLocalPath);
        };

        // 檢查是否有補丁檔存在
        if (fs.existsSync(patchFilePath)) {
            try {
                log.info(`[HotReloader] 找到 ${moduleName} 補丁，嘗試加載...`);

                // 讀取補丁代碼
                const content = fs.readFileSync(patchFilePath, 'utf8');

                // 創建一個新的 node module 實例，繼承目前環境，並賦予其等同於「廠房代碼」的偽裝路徑
                const m = new Module(absoluteLocalPath, module);
                m.filename = absoluteLocalPath;
                m.paths = Module._nodeModulePaths(path.dirname(absoluteLocalPath));

                // 進行編譯與沙盒執行
                m._compile(content, absoluteLocalPath);

                log.info(`[HotReloader] ${moduleName} 補丁加載成功`);
                return m.exports;
            } catch (err) {
                // 補丁故障，觸發熔斷
                log.error(`[HotReloader] 補丁故障，觸發熔斷回退 (${moduleName}):`, err.message, err.stack);

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

        // 若無補丁或補丁熔斷崩潰，則加載內建原本的模組 (原廠安全代碼)
        return loadOriginal();
    }
}

// 導出單例
module.exports = {
    hotReloader: new HotReloader()
};
