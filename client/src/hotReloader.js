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

                // 創建一個新的 node module 實例
                // absoluteLocalPath 是廠房原始路徑 (例如 d:\...\src\monitor.js)
                const m = new Module(absoluteLocalPath, module);
                m.filename = absoluteLocalPath;
                m.paths = Module._nodeModulePaths(path.dirname(absoluteLocalPath));

                // 【核心補強】: 修正補丁中的 require 邏輯
                // 攔截補丁內部的 require，使其優先查找 patchDirPath
                const originalRequire = m.require;
                m.require = (request) => {
                    // 只處理以 . 或 .. 開頭的相對路徑
                    if (request.startsWith('.')) {
                        const targetPath = path.resolve(path.dirname(absoluteLocalPath), request);
                        const fileName = path.basename(targetPath);
                        const relativeToSrc = path.relative(path.resolve(__dirname, '..', 'src'), targetPath);

                        // 判斷請求的是否為 src 內的模組
                        if (!relativeToSrc.startsWith('..') && !path.isAbsolute(relativeToSrc)) {
                            // 嘗試從 Patch 目錄載入
                            const patchedTargetName = relativeToSrc.replace(/\\/g, '/'); // 轉為正斜線
                            // 注意：我們避開遞迴，只檢查檔案是否存在
                            const possiblePatchFile = path.join(this.patchDirPath, 'src',
                                patchedTargetName.endsWith('.js') ? patchedTargetName : `${patchedTargetName}.js`);

                            if (fs.existsSync(possiblePatchFile)) {
                                // 遞迴使用 loadModuleSafely 載入這個子依賴包
                                // 這裡需要將 relativePath 轉回 ./src/xxx 格式
                                return this.loadModuleSafely(
                                    patchedTargetName.replace('.js', ''),
                                    `./src/${patchedTargetName.replace('.js', '')}`
                                );
                            }
                        }
                    }
                    // 其他情況（如引用 node_modules）交回原始 require
                    return originalRequire.call(m, request);
                };

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
