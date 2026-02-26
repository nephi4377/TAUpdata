const { BrowserWindow, ipcMain, screen, app } = require('electron');
const path = require('path');
const fs = require('fs');

class AdminDashboard {
    constructor(configManager) {
        this.config = configManager;
        this.window = null;
    }

    show() {
        if (this.window && !this.window.isDestroyed()) {
            this.window.show();
            this.window.focus();
            return;
        }
        this._createWindow();
    }

    _createWindow() {
        const primaryDisplay = screen.getPrimaryDisplay();
        const { width, height } = primaryDisplay.workAreaSize;

        this.window = new BrowserWindow({
            width: 1200,
            height: 800,
            x: Math.floor((width - 1200) / 2),
            y: Math.floor((height - 800) / 2),
            title: '管理員報表中心',
            webPreferences: {
                nodeIntegration: true,
                contextIsolation: false
            },
            autoHideMenuBar: true
        });

        // [v1.8.9b Fix] 智慧路徑定位：優先尋找補丁(app_patches)夾層中的 HTML
        let uiPath = path.join(__dirname, 'adminDashboard.html');
        const patchUiPath = path.join(app.getPath('userData'), 'app_patches', 'src', 'adminDashboard.html');

        if (fs.existsSync(patchUiPath)) {
            uiPath = patchUiPath;
            console.log('[AdminDashboard] 使用補丁路徑載入 UI:', uiPath);
        } else {
            console.log('[AdminDashboard] 使用原始路徑載入 UI:', uiPath);
        }

        this.window.loadFile(uiPath);

        // 如果需要偵錯，可以暫時取消註解
        // this.window.webContents.openDevTools();
    }

    _stopAutoUpdate() { }
}

module.exports = { AdminDashboard };
