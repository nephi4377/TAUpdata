const { BrowserWindow, ipcMain, screen } = require('electron');
const path = require('path');

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

        this.window.loadFile(path.join(__dirname, 'adminDashboard.html'));
    }

    _stopAutoUpdate() { }
}

module.exports = { AdminDashboard };
