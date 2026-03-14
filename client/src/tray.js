// v1.11.17 - 2026-02-26 21:05 (Asia/Taipei)
// 修改內容: 還原所有功能、加入「開啟整合主控台」、修復打卡通訊、祕書裝束改為隨機、語氣專業化 (移除稱謂)。

const { Tray, Menu, nativeImage, Notification, app, BrowserWindow, shell, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const https = require('https');
const { versionService } = require('./versionService');

class TrayManager {
  constructor(appInstance, monitorService, storageService, configManager, apiBridge, setupWindow, reminderService, classificationWindow, adminDashboard) {
    this.app = appInstance;
    this.monitorService = monitorService;
    this.storageService = storageService;
    this.configManager = configManager;
    this.apiBridge = apiBridge || null;
    this.setupWindow = setupWindow || null;
    this.reminderService = reminderService || null;
    this.adminDashboard = adminDashboard || null;
    this.classificationWindow = classificationWindow || null;

    this.tray = null;
    this.statsWindow = null;
    this._registerIpcHandlers();
    console.log(`[Tray] 系統功能已全面還原 (v${versionService.getEffectiveVersion()})`);
  }

  destroy() {
    if (this.tray) {
      this.tray.destroy();
      this.tray = null;
    }
    if (this.statsWindow && !this.statsWindow.isDestroyed()) {
      this.statsWindow.close();
    }
  }

  /**
   * 確保小秘書影像已下載至本地快取
   * @param {string} fname 檔案名稱
   * @returns {Promise<string>} 本地路徑
   */
  async ensureMascotCached(fname) {
    const cacheDir = path.join(this.app.getPath('userData'), 'mascot_cache');
    if (!fs.existsSync(cacheDir)) fs.mkdirSync(cacheDir, { recursive: true });

    const localPath = path.join(cacheDir, fname);
    if (fs.existsSync(localPath)) return localPath;

    // 如果本地不存在，從 GitHub 下載
    const url = `https://raw.githubusercontent.com/nephi4377/TAUpdata/master/client/assets/${fname}`;
    console.log(`[Tray] 正在下載小秘書快取: ${url}`);

    return new Promise((resolve) => {
      const file = fs.createWriteStream(localPath);
      https.get(url, (response) => {
        response.pipe(file);
        file.on('finish', () => {
          file.close();
          console.log(`[Tray] 小秘書快取下載完成: ${fname}`);
          resolve(localPath);
        });
      }).on('error', (err) => {
        fs.unlink(localPath, () => { }); // 失敗則刪除殘缺檔案
        console.error(`[Tray] 快取下載失敗: ${err.message}`);
        resolve(''); // 回傳空字串代表失敗，UI 會降級處理
      });
    });
  }

  _registerIpcHandlers() {
    // 已移回 AppCore 統一處理，防止熱更新衝突
  }

  async init() {
    this.tray = new Tray(this.createTrayIcon());
    this.tray.setToolTip('添心統計中心');
    await this.updateMenu();
    setInterval(() => this.updateMenu(), 60000);
    this.tray.on('click', () => {
      this.monitorService.showStatsWindow(this.configManager, this.reminderService, true);
    });
  }

  createTrayIcon() {
    const size = 16;
    const canvas = Buffer.alloc(size * size * 4);
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const idx = (y * size + x) * 4;
        const dist = Math.sqrt((x - 8) ** 2 + (y - 8) ** 2);
        if (dist < 6) {
          canvas[idx] = 76; canvas[idx + 1] = 175; canvas[idx + 2] = 80; canvas[idx + 3] = 255;
        } else {
          canvas[idx] = 0; canvas[idx + 1] = 0; canvas[idx + 2] = 0; canvas[idx + 3] = 0;
        }
      }
    }
    return nativeImage.createFromBuffer(canvas, { width: size, height: size });
  }

  async updateMenu() {
    if (!this.tray) return;
    const stats = await this.storageService.getTodayStats();
    const v = versionService.getEffectiveVersion();
    const bound = this.configManager.getBoundEmployee();
    const gender = this.configManager.getMascotGender();

    const template = [
      { label: `添心生產力助手 v${v}`, enabled: false },
      { label: `今日效率: ${stats.productivityRate || 0}%`, enabled: false },
      { label: '📊 添心統計中心', click: () => this.monitorService.showStatsWindow(this.configManager, this.reminderService, true) },
      { type: 'separator' }
    ];

    if (bound) {
      template.push({ label: `👤 ${bound.userName}`, enabled: false });
      // [還原] 快速打卡功能
      template.push({
        label: '✅ 快速打卡 (發送至 LINE)',
        click: async () => {
          if (!this.apiBridge) return;
          const res = await this.apiBridge.directCheckin(bound.userId, bound.userName);
          if (res && res.success) {
            new Notification({ title: '打卡成功', body: '已成功發送打卡訊號至 LINE 平台。' }).show();
            // 延遲刷新統計，讓後端有時間更新資料
            setTimeout(() => this.monitorService.showStatsWindow(this.configManager, this.reminderService, false), 2000);
          } else {
            new Notification({ title: '打卡失敗', body: res ? res.message : '通訊錯誤' }).show();
          }
        }
      });
      template.push({ type: 'separator' });
    }

    // [還原] 整合主控台連結
    template.push({ label: '🖥️ 開啟整合主控台', click: () => { shell.openExternal('https://info.tanxin.space/index.html'); } });

    // [v2.5.2.0] 管理員與設定：僅限權限 Level 5 (修復邏輯：主面板按鈕與右鍵選單分離)
    const isAdminUser = bound && parseInt(bound.permission || 0) >= 5;
    if (isAdminUser || this.configManager.isAdmin()) {
      template.push({ label: '⚙️ 管理員面板', click: () => this.adminDashboard?.show() });
    }

    // 性別設定 (僅保留男女大項)
    template.push({
      label: `🎭 祕書性別: ${gender === 'male' ? '🤵 男版' : '👩 女版'}`,
      click: () => { this.configManager.setMascotGender(gender === 'male' ? 'female' : 'male'); this.updateMenu(); }
    });

    template.push({ type: 'separator' });

    template.push({ label: '👤 切換使用者 (重新綁定)', click: () => this.setupWindow('setup') });

    template.push({ type: 'separator' });
    template.push({ label: '🔄 檢查更新', click: () => this.app.emit('check-for-updates-manual') });
    this.tray.setContextMenu(Menu.buildFromTemplate(template));
  }

  formatMinutes(m) { if (!m) return '0分'; if (m < 60) return m + '分'; return Math.floor(m / 60) + 'h ' + (m % 60) + 'm'; }
}

module.exports = { TrayManager };
