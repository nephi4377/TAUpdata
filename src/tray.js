// v1.6 - 2026-02-14 16:45 (Asia/Taipei)
// 修改內容: 重構 TrayManager，修復語法錯誤，優化操作流程

const { Tray, Menu, nativeImage, Notification, app, BrowserWindow, shell, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const { versionService } = require('./versionService');

class TrayManager {
  constructor(appInstance, monitorService, storageService, configManager, checkinService, setupWindow, reminderService, classificationWindow, adminDashboard) {
    this.app = appInstance;
    this.monitorService = monitorService;
    this.storageService = storageService;
    this.configManager = configManager;
    this.checkinService = checkinService || null;
    this.setupWindow = setupWindow || null;
    this.reminderService = reminderService || null;
    this.adminDashboard = adminDashboard || null;

    this.tray = null;
    this.statsWindow = null;
    this.updateInterval = null;
    this.lastPermissionCheck = 0; // [v1.8.9] 權限補齊冷卻時間
    this._registerIpcHandlers();

    console.log('[Tray] 托盤管理服務已建立');
  }

  // 註冊 IPC 監聽器 (避免熱更新累積)
  _registerIpcHandlers() {
    ipcMain.removeAllListeners('refresh-stats');
    ipcMain.on('refresh-stats', (event, options = {}) => {
      // 確保自動刷新時不調用 focus (options.isManual 設為 false)
      const isManual = options && options.isManual === true;
      this.showStatsWindow(isManual);
    });
  }

  // 初始化托盤
  async init() {
    // 清除舊版或軟重啟遺留的孤兒視窗
    const allWindows = BrowserWindow.getAllWindows();
    for (const win of allWindows) {
      if (!win.isDestroyed() && win.getTitle() === '添心生產力助手 - 詳細統計') {
        win.destroy();
      }
    }

    // 建立托盤圖示
    const icon = this.createTrayIcon();

    this.tray = new Tray(icon);
    this.tray.setToolTip('添心生產力助手');

    // 建立選單
    await this.updateMenu();

    // 定時更新選單（每分鐘）
    this.updateInterval = setInterval(async () => {
      await this.updateMenu();
    }, 60 * 1000);

    // 點擊托盤圖示直接顯示詳細統計（最直覺的操作）
    this.tray.on('click', () => {
      this.showStatsWindow();
    });

    // 雙擊也顯示詳細統計（兼容舊習慣）
    this.tray.on('double-click', () => {
      this.showStatsWindow();
    });

    console.log('[Tray] 系統托盤已初始化');
  }

  // 建立托盤圖示（綠色圓點）
  createTrayIcon() {
    const size = 16;
    const canvas = Buffer.alloc(size * size * 4);

    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const idx = (y * size + x) * 4;
        const cx = size / 2;
        const cy = size / 2;
        const dist = Math.sqrt((x - cx) ** 2 + (y - cy) ** 2);

        if (dist < 6) {
          // 綠色圓形
          canvas[idx] = 76;     // R
          canvas[idx + 1] = 175; // G
          canvas[idx + 2] = 80;  // B
          canvas[idx + 3] = 255; // A
        } else {
          // 透明
          canvas[idx] = 0;
          canvas[idx + 1] = 0;
          canvas[idx + 2] = 0;
          canvas[idx + 3] = 0;
        }
      }
    }

    return nativeImage.createFromBuffer(canvas, { width: size, height: size });
  }

  // 取得當前真實運作版本 (含熱更新補丁)
  getEffectiveVersion() {
    return versionService.getEffectiveVersion();
  }

  // 更新選單
  async updateMenu() {
    const status = this.monitorService.getStatus();
    const stats = await this.storageService.getTodayStats();

    // 狀態標籤
    let statusLabel = '🟢 監測中';
    if (status.isLunchBreak) {
      statusLabel = '🍴 午休時間';
    } else if (status.idleTime >= status.idleThreshold) {
      statusLabel = `💤 閒置中 (${Math.floor(status.idleTime / 60)}分鐘)`;
    }

    // 使用新的生產力計算
    const productivityRate = stats.productivityRate || 0;
    const effectiveVersion = this.getEffectiveVersion();

    const template = [
      { label: `添心生產力助手 v${effectiveVersion} (${statusLabel})`, enabled: false },
      { label: `今日工作: ${this.formatMinutes(stats.work)} (${productivityRate}%)`, enabled: false },
      {
        label: '📊 詳細統計 (歷史)',
        click: () => this.showStatsWindow()
      },
      { type: 'separator' },
    ];

    let boundEmployee = this.configManager.getBoundEmployee();

    // [v1.8.9] 降低權限補齊頻率 (冷卻時間 10 分鐘)
    const now = Date.now();
    const isCoolingDown = (now - this.lastPermissionCheck) < 10 * 60 * 1000;
    const needRefreshPermission = !isCoolingDown && boundEmployee && (
      boundEmployee.permission == null ||
      boundEmployee.permission === undefined ||
      boundEmployee.permission === '' ||
      Number(boundEmployee.permission) === 0
    );

    if (needRefreshPermission && this.checkinService && !status.isBoss) {
      this.lastPermissionCheck = now;
      try {
        let permission = null;
        let group = boundEmployee.group;
        const pcResult = await this.checkinService.getEmployeeByPcName();
        if (pcResult && pcResult.success && pcResult.data && (pcResult.data.permission != null && pcResult.data.permission !== '')) {
          permission = Number(pcResult.data.permission);
          if (pcResult.data.group != null) group = pcResult.data.group;
        }
        // 若依電腦名稱查不到權限（例如尚未綁定 pcName），改從員工列表以 userId 取得
        if (permission == null && boundEmployee.userId) {
          const listResult = await this.checkinService.getEmployeeList();
          if (listResult && listResult.success && Array.isArray(listResult.data)) {
            const emp = listResult.data.find(e => e.userId === boundEmployee.userId);
            if (emp && (emp.permission != null && emp.permission !== '')) {
              permission = Number(emp.permission);
              if (emp.group != null) group = emp.group;
            }
          }
        }
        if (permission != null && !isNaN(permission)) {
          const updated = { ...boundEmployee, permission, group };
          this.configManager.bindEmployee(updated);
          boundEmployee = updated;
          console.log('[Tray] 已從後端補齊權限:', boundEmployee.userName, 'permission=', permission);
        }
      } catch (e) {
        console.warn('[Tray] 無法從後端補齊權限:', e && e.message);
      }
    }

    if (boundEmployee) {
      template.push(
        { label: `👤 使用者: ${boundEmployee.userName}`, enabled: false },
        { type: 'separator' }
      );
    } else {
      template.push(
        { label: '⚠️ 未綁定員工', enabled: false },
        { type: 'separator' }
      );
    }



    // 整合主控台捷徑
    template.push({
      label: '🖥️ 開啟整合主控台',
      click: () => {
        const dashboardUrl = 'https://info.tanxin.space/index.html';
        shell.openExternal(dashboardUrl).catch(err => {
          console.error('無法開啟主控台:', err);
        });
      }
    });

    // ═══ 今日提醒事項 ═══
    if (this.reminderService) {
      const reminderStatus = this.reminderService.getTodayReminderStatus();
      const pendingCount = this.reminderService.getPendingCount();
      const completedCount = this.reminderService.getCompletedCount();
      const totalCount = reminderStatus.length;

      if (totalCount > 0) {
        const reminderSubmenu = reminderStatus.map(item => {
          let statusIcon;
          if (item.status === 'completed') {
            statusIcon = '✅';
          } else if (item.status === 'snoozed') {
            statusIcon = '⏰';
          } else {
            statusIcon = '⬜';
          }
          return {
            label: `${statusIcon} ${item.icon} ${item.title}`,
            enabled: false
          };
        });

        template.push(
          { type: 'separator' },
          {
            label: `📋 今日提醒 (✅${completedCount} / ⬜${pendingCount})`,
            submenu: reminderSubmenu
          }
        );
      }
    }

    // 顯示當前應用程式和分類
    if (status.lastAppName) {
      template.push({ type: 'separator' });
      const categoryLabel = this.getCategoryLabel(status.lastCategory);
      template.push({
        label: `📍 當前: ${status.lastAppName}`,
        enabled: false
      });
      template.push({
        label: `🏷️ 分類: ${categoryLabel}`,
        enabled: false
      });
    }

    // [DEBUG] Ensure menu items are added
    console.log('[Tray] Adding menu items...');

    template.push({ type: 'separator' });

    template.push({
      label: '⬆️ 手動上傳今日報告',
      enabled: !!boundEmployee,
      click: async () => {
        if (this.checkinService) {
          const result = await this.checkinService.submitTodayReport(this.storageService, this.reminderService);
          if (result && result.success) {
            this.monitorService.showToast('上傳成功', '今日報告已上傳 ✅');
          } else {
            this.monitorService.showToast('上傳失敗', result ? result.message : '未知錯誤');
          }
        }
      }
    });

    // [v1.8.6] 權限控管：確保核心管理者權限與選單顯示
    const userRole = boundEmployee ? (Number(boundEmployee.permission) || 0) : 0;
    const userGroup = boundEmployee ? (boundEmployee.group || '').toUpperCase() : '';
    const isBoss = userGroup === 'BOSS' || (boundEmployee && (boundEmployee.userName === '管理者' || boundEmployee.userName === '黃俊豪'));
    const isAdmin = userRole === 5 || isBoss;
    if (boundEmployee) {
      console.log('[Tray] 權限判定:', boundEmployee.userName, 'userRole=', userRole, 'group=', userGroup, 'isAdmin=', isAdmin);
    }

    if (isAdmin) {
      template.push({
        label: '🔧 分類管理',
        click: () => {
          if (this.classificationWindow) {
            this.classificationWindow.show();
          } else {
            console.error('[Tray] ClassificationWindow not initialized');
          }
        }
      });
      template.push({
        label: '📊 管理員面板',
        click: () => {
          if (this.adminDashboard) {
            this.adminDashboard.show();
          } else {
            console.error('[Tray] AdminDashboard not initialized');
          }
        }
      });
    }

    template.push({
      label: '🔄 切換使用者',
      click: async () => {
        if (this.setupWindow) {
          const selectedEmployee = await this.setupWindow.show('switch');
          if (selectedEmployee) {
            if (this.monitorService) {
              this.monitorService.showToast('切換成功', `使用者已切換為: ${selectedEmployee.userName}`);
            }
            this.updateMenu();
          }
        }
      }
    });

    template.push({
      label: '📲 開啟網頁打卡 (LINE)',
      click: () => {
        shell.openExternal('https://liff.line.me/2007974938-jVxn6y37?source=hub');
      }
    });

    template.push({ type: 'separator' });


    template.push({
      label: '🔄 檢查更新',
      click: () => {
        this.app.emit('check-for-updates-manual');
      }
    });

    template.push({ type: 'separator' });

    console.log('[Tray] Menu template length:', template.length);

    const contextMenu = Menu.buildFromTemplate(template);
    this.tray.setContextMenu(contextMenu);

    // 更新 tooltip
    const tooltipParts = [`添心生產力助手 v${this.getEffectiveVersion()}`];
    if (boundEmployee) {
      tooltipParts.push(boundEmployee.userName);
    }
    if (status.isPaused) {
      tooltipParts.push('暫停中');
    } else {
      tooltipParts.push(`工作 ${this.formatMinutes(stats.work)} (${productivityRate}%)`);
    }
    const workInfo = this.configManager.getTodayWorkInfo();
    if (workInfo && workInfo.expectedOffTime) {
      tooltipParts.push(`下班 ${workInfo.expectedOffTime}`);
    }
    this.tray.setToolTip(tooltipParts.join(' - '));
  }

  // 顯示詳細統計視窗
  async showStatsWindow(isManual = true) {
    // [v1.9.1 Fix] 僅在使用者主動開啟 (isManual=true) 時更新後端。自動刷新只更新 UI 時間。
    if (this.checkinService && isManual) {
      this.checkinService.refreshWorkInfo().catch(err => { });
    }

    // 準備數據
    const statsData = await this.getStatsData();

    if (this.statsWindow && !this.statsWindow.isDestroyed()) {
      if (isManual) this.statsWindow.focus();
      // 推送數據給前端自定義處理 (消滅閃動)
      this.statsWindow.webContents.send('update-stats-data', statsData);
      return;
    }

    const tempPath = path.join(this.app.getPath('userData'), 'stats.html');
    const html = await this.generateStatsHtml(statsData);
    fs.writeFileSync(tempPath, html, 'utf8');

    this.statsWindow = new BrowserWindow({
      width: 700,
      height: 850,
      title: '添心生產力助手 - 詳細統計',
      resizable: true,
      minimizable: true,
      maximizable: false,
      autoHideMenuBar: true, // 隱藏上方無用的選單列
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        preload: path.join(__dirname, 'reminderPreload.js')
      }
    });

    this.statsWindow.loadFile(tempPath);

    this.statsWindow.on('closed', () => {
      this.statsWindow = null;
    });
  }

  /**
   * 取得統計數據 JSON (用於 IPC 更新)
   */
  async getStatsData() {
    const stats = await this.storageService.getTodayStats();
    const hourlyStats = await this.storageService.getHourlyStats();
    const topApps = await this.storageService.getRecentTopApps(1);
    const browserHistory = await this.storageService.getBrowserHistory();
    const status = this.monitorService.getStatus();
    const boundEmployee = this.configManager.getBoundEmployee();
    const workInfo = this.configManager.getTodayWorkInfo();
    const reminderStatus = this.reminderService ? this.reminderService.getTodayReminderStatus() : [];

    return {
      stats,
      hourlyStats,
      topApps,
      browserHistory,
      status,
      boundEmployee,
      workInfo,
      reminderStatus,
      version: this.getEffectiveVersion()
    };
  }

  // 生成統計頁面 HTML
  async generateStatsHtml(data = null) {
    if (!data) data = await this.getStatsData();
    const { stats, hourlyStats, topApps, browserHistory, status, boundEmployee, workInfo, reminderStatus } = data;

    const productivityRate = stats.total > 0
      ? Math.round((stats.work / stats.total) * 100)
      : 0;

    // 生成小時統計列表
    let hourlyHtml = '';
    for (const row of hourlyStats) {
      const hour = row.hour;
      const displayHour = `${hour.toString().padStart(2, '0')}:00`;
      hourlyHtml += `
        <div class="hour-row">
          <span class="hour-label">${displayHour}</span>
          <div class="hour-bar-container">
            <div class="hour-bar work" style="width: ${row.work_pct}%"></div>
            <div class="hour-bar leisure" style="width: ${row.leisure_pct}%"></div>
            <div class="hour-bar other" style="width: ${row.other_pct}%"></div>
          </div>
          <span class="hour-total">${this.formatMinutes(row.total)}</span>
        </div>
      `;
    }

    // 生成應用程式排行
    let appsHtml = '';
    for (const app of topApps) {
      const minutes = Math.round(app.total_seconds / 60);
      const categoryClass = app.category || 'other';
      appsHtml += `
        <div class="app-row">
          <span class="app-name">${this.escapeHtml(app.app_name)}</span>
          <span class="app-category ${categoryClass}">${this.getCategoryLabel(categoryClass)}</span>
          <span class="app-time">${this.formatMinutes(minutes)}</span>
        </div>
      `;
    }

    // 取得打卡資訊
    let checkinHtml = '';

    if (boundEmployee) {
      checkinHtml = `
        <div class="stats-card checkin-card">
          <h2><span class="icon">👤</span> 打卡資訊 - ${this.escapeHtml(boundEmployee.userName)}</h2>
          <div class="checkin-grid">
            <div class="checkin-item">
              <span class="label">打卡時間</span>
              <span class="value">${workInfo && workInfo.checkedIn ? workInfo.checkinTime : '⚠️ 未打卡'}</span>
            </div>
            <div class="checkin-item">
              <span class="label">預計下班</span>
              <span class="value">${workInfo && workInfo.expectedOffTime ? workInfo.expectedOffTime : '--:--'}</span>
            </div>
          </div>
        </div>
      `;
    } else {
      checkinHtml = `
        <div class="stats-card checkin-card" style="border: 2px dashed #f7768e;">
          <h2><span class="icon">⚠️</span> 尚未打卡 / 尚未連結帳號</h2>
          <div style="text-align:center; padding: 10px;">
            <p style="margin-bottom: 5px; font-size: 14px; color: #f7768e;">💡 提示：請點擊下方連結進行打卡</p>
            <p style="margin-bottom: 15px; font-size: 11px; color: #888;">打卡後，本視窗將自動同步狀態</p>
            <button class="complete-btn" style="background:#7aa2f7; padding: 10px 20px;" onclick="window.reminderAPI.openLinkWindow()">📲 立即前往打卡 (LINE)</button>
          </div>
        </div>
      `;
    }

    // 取得提醒事項
    let remindersHtml = '';
    if (this.reminderService) {
      if (reminderStatus.length > 0) {
        let reminderList = '';
        for (const item of reminderStatus) {
          let statusClass = '';
          let statusText = '';

          if (item.status === 'completed') {
            statusClass = 'completed';
            statusText = '✅ 已完成';
          } else if (item.status === 'snoozed') {
            statusClass = 'snoozed';
            statusText = '⏰ 稍後';
          } else {
            statusClass = 'pending';
            statusText = `<button class="complete-btn" onclick="completeReminder('${item.id}')">✅ 完成</button>`;
          }

          reminderList += `
            <div class="reminder-row ${statusClass}">
              <span class="reminder-icon">${item.icon}</span>
              <span class="reminder-title">${this.escapeHtml(item.title)}</span>
              <span class="reminder-status">${statusText}</span>
            </div>
          `;
        }

        remindersHtml = `
          <div class="stats-card">
            <h2><span class="icon">📋</span> 今日提醒事項</h2>
            <div class="reminders-list">
              ${reminderList}
            </div>
          </div>
        `;
      }
    }

    // 生成網頁瀏覽記錄
    let browserHtml = '';
    for (const item of browserHistory) {
      const minutes = Math.round(item.totalSeconds / 60);
      const categoryClass = item.category || 'other';
      const displayTitle = item.title.length > 50
        ? item.title.substring(0, 50) + '...'
        : item.title;
      browserHtml += `
        <div class="browser-row ${categoryClass}">
          <span class="browser-title" title="${this.escapeHtml(item.title)}">${this.escapeHtml(displayTitle)}</span>
          <span class="browser-category ${categoryClass}">${this.getCategoryLabel(categoryClass)}</span>
          <span class="browser-time">${this.formatMinutes(minutes)}</span>
        </div>
      `;
    }

    // 狀態補充資訊（已移除休閒警示顯式顯示）
    const alertInfo = '';

    return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <title>詳細統計</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: 'Microsoft JhengHei', 'Segoe UI', sans-serif;
      background: linear-gradient(135deg, #1a1a2e 0%, #16213e 100%);
      color: #eee;
      padding: 20px;
      min-height: 100vh;
    }
    .container { max-width: 660px; margin: 0 auto; }
    h1 {
      font-size: 24px;
      margin-bottom: 20px;
      text-align: center;
      color: #4ecdc4;
    }
    .status-badge {
      display: inline-block;
      padding: 4px 12px;
      border-radius: 12px;
      font-size: 12px;
      margin-bottom: 20px;
    }
    .status-badge.running { background: #4caf50; }
    .status-badge.paused { background: #ff9800; }
    
    .stats-card {
      background: rgba(255,255,255,0.1);
      border-radius: 12px;
      padding: 20px;
      margin-bottom: 20px;
    }
    .stats-card h2 {
      font-size: 16px;
      color: #aaa;
      margin-bottom: 15px;
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .stats-card h2 .icon { font-size: 18px; }
    
    .summary-grid {
      display: grid;
      grid-template-columns: repeat(3, 1fr);
      gap: 15px;
      text-align: center;
    }
    .summary-item {
      background: rgba(255,255,255,0.05);
      border-radius: 8px;
      padding: 15px 10px;
    }
    .summary-value {
      font-size: 24px;
      font-weight: bold;
      color: #4ecdc4;
    }
    .summary-label {
      font-size: 12px;
      color: #888;
      margin-top: 5px;
    }
    .summary-item.work .summary-value { color: #4caf50; }
    .summary-item.leisure .summary-value { color: #ff5722; }
    .summary-item.other .summary-value { color: #9e9e9e; }
    
    .productivity-bar {
      height: 20px;
      background: rgba(255,255,255,0.1);
      border-radius: 10px;
      overflow: hidden;
      margin-top: 15px;
    }
    .productivity-fill {
      height: 100%;
      background: linear-gradient(90deg, #4caf50, #8bc34a);
      transition: width 0.3s;
    }
    .productivity-text {
      text-align: center;
      margin-top: 8px;
      font-size: 14px;
      color: #888;
    }
    
    .hour-row {
      display: flex;
      align-items: center;
      margin-bottom: 8px;
    }
    .hour-label {
      width: 50px;
      font-size: 12px;
      color: #888;
    }
    .hour-bar-container {
      flex: 1;
      height: 16px;
      background: rgba(255,255,255,0.05);
      border-radius: 4px;
      overflow: hidden;
      display: flex;
    }
    .hour-bar {
      height: 100%;
      transition: width 0.3s;
    }
    .hour-bar.work { background: #4caf50; }
    .hour-bar.leisure { background: #ff5722; }
    .hour-bar.other { background: #9e9e9e; }
    .hour-total {
      width: 70px;
      text-align: right;
      font-size: 12px;
      color: #888;
    }
    
    .app-row {
      display: flex;
      align-items: center;
      padding: 10px 0;
      border-bottom: 1px solid rgba(255,255,255,0.1);
    }
    .app-row:last-child { border-bottom: none; }
    .app-name {
      flex: 1;
      font-size: 14px;
    }
    .app-category, .browser-category {
      padding: 2px 8px;
      border-radius: 4px;
      font-size: 11px;
      margin-right: 10px;
    }
    .app-category.work, .browser-category.work { background: rgba(76,175,80,0.3); color: #4caf50; }
    .app-category.leisure, .browser-category.leisure { background: rgba(255,87,34,0.3); color: #ff5722; }
    .app-category.other, .browser-category.other { background: rgba(158,158,158,0.3); color: #9e9e9e; }
    .app-time, .browser-time {
      font-size: 13px;
      color: #888;
      min-width: 60px;
      text-align: right;
    }
    
    /* 網頁瀏覽記錄樣式 */
    .browser-row {
      display: flex;
      align-items: center;
      padding: 8px 12px;
      margin-bottom: 6px;
      border-radius: 8px;
      background: rgba(255,255,255,0.05);
      border-left: 3px solid #666;
    }
    .browser-row.work { border-left-color: #4caf50; }
    .browser-row.leisure { border-left-color: #ff5722; }
    .browser-row.other { border-left-color: #9e9e9e; }
    .browser-title {
      flex: 1;
      font-size: 13px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    
    /* 打卡資訊樣式 */
    .checkin-grid {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 15px;
    }
    .checkin-item {
      background: rgba(255,255,255,0.05);
      padding: 12px;
      border-radius: 8px;
      display: flex;
      flex-direction: column;
      align-items: center;
    }
    .checkin-item .label {
      font-size: 12px;
      color: #888;
      margin-bottom: 4px;
    }
    .checkin-item .value {
      font-size: 16px;
      font-weight: bold;
      color: #fff;
    }

    /* 提醒事項樣式 */
    .reminder-row {
      display: flex;
      align-items: center;
      padding: 10px;
      border-bottom: 1px solid rgba(255,255,255,0.1);
    }
    .reminder-row:last-child { border-bottom: none; }
    .reminder-icon { margin-right: 10px; font-size: 16px; }
    .reminder-title { flex: 1; font-size: 14px; }
    .reminder-status { font-size: 12px; padding: 2px 8px; border-radius: 10px; }
    
    .reminder-row.completed .reminder-title { color: #888; text-decoration: line-through; }
    .reminder-row.completed .reminder-status { background: rgba(76,175,80,0.2); color: #4caf50; }
    
    .reminder-row.snoozed .reminder-status { background: rgba(255,152,0,0.2); color: #ff9800; }
    
    .reminder-row.pending .reminder-status { background: rgba(255,255,255,0.1); color: #aaa; }

    .legend {
      display: flex;
      justify-content: center;
      gap: 20px;
      margin-top: 10px;
      font-size: 12px;
    }
    .legend-item {
      display: flex;
      align-items: center;
      gap: 5px;
    }
    .legend-dot {
      width: 10px;
      height: 10px;
      border-radius: 50%;
    }
    .legend-dot.work { background: #4caf50; }
    .legend-dot.leisure { background: #ff5722; }
    .legend-dot.other { background: #9e9e9e; }
    
    .refresh-note {
      text-align: center;
      font-size: 11px;
      color: #666;
      margin-top: 20px;
    }
    
    .empty-state {
      color: #888;
      text-align: center;
      padding: 20px;
      font-size: 14px;
    }
    
    .complete-btn {
      background: #4caf50;
      color: white;
      border: none;
      padding: 4px 10px;
      border-radius: 4px;
      cursor: pointer;
      font-size: 12px;
      transition: background 0.2s;
    }
    .complete-btn:hover {
      background: #45a049;
    }
  </style>
  <script>
    async function completeReminder(id) {
      if (window.reminderAPI) {
        try {
          await window.reminderAPI.complete(id);
          // 請求主進程重新生成並載入 HTML
          window.reminderAPI.refreshStats();
        } catch (err) {
          console.error('完成提醒失敗:', err);
          alert('操作失敗，請稍後再試');
        }
      }
    }

    // [v2.0] 消滅閃動：接收 IPC 動態更新 DOM
    if (window.reminderAPI && window.reminderAPI.onUpdateStats) {
      window.reminderAPI.onUpdateStats((data) => {
        console.log('[Stats] 收到動態數據更新', data);
        
        // 1. 更新狀態標籤
        const badge = document.querySelector('.status-badge');
        if (badge) {
          badge.className = 'status-badge ' + (data.status.isPaused ? 'paused' : 'running');
          badge.innerHTML = (data.status.isPaused ? '⏸️ 暫停中' : '🟢 監測中') + ' · 已取樣 ' + (data.status.sampleCount || 0) + ' 次';
        }

        // 2. 更新時間統計
        document.querySelector('.summary-item.work .summary-value').innerText = formatMinutes(data.stats.work);
        document.querySelector('.summary-item.leisure .summary-value').innerText = formatMinutes(data.stats.leisure);
        document.querySelector('.summary-item.other .summary-value').innerText = formatMinutes(data.stats.other);
        
        const rate = data.stats.total > 0 ? Math.round((data.stats.work / data.stats.total) * 100) : 0;
        document.querySelector('.productivity-fill').style.width = rate + '%';
        document.querySelector('.productivity-text').innerText = '生產力指數：' + rate + '%';

        // 3. 更新小時分佈與排行 (簡單處理：保留原狀或重新注入部分 HTML)
        // 這裡為了極致流暢，我們只在有數據變動時靜默更新，不頻繁刷新列表以防閃爍
      });
    }

    function formatMinutes(minutes) {
      if (!minutes || minutes === 0) return '0 分';
      if (minutes < 60) return minutes + ' 分';
      const hours = Math.floor(minutes / 60);
      const mins = minutes % 60;
      return mins > 0 ? hours + 'h ' + mins + 'm' : hours + ' 小時';
    }

    // [v1.7] 自動定期重新整理 (改為靜默請求，不重載頁面)
    setInterval(() => {
      if (window.reminderAPI) {
        window.reminderAPI.refreshStats({ isManual: false });
      }
    }, 60 * 1000); 
  </script>
  </head>
<body>
  <div class="container">
    <h1>📊 今日生產力報告</h1>
    <div style="text-align: center; color: #888; font-size: 14px; margin-top: -10px; margin-bottom: 20px;">v${this.getEffectiveVersion()}</div>
    
    <div style="text-align: center; margin-bottom: 20px;">
      <span class="status-badge ${status.isPaused ? 'paused' : 'running'}">
        ${status.isPaused ? '⏸️ 暫停中' : '🟢 監測中'} · 已取樣 ${status.sampleCount || 0} 次
      </span>
      ${alertInfo}
      <span style="font-size: 12px; color: #666; margin-left: 10px;">(每 5 分鐘自動更新)</span>
    </div>
    
    ${checkinHtml}

    ${remindersHtml}
    
    <div class="stats-card">
      <h2><span class="icon">⏱️</span> 時間統計</h2>
      <div class="summary-grid">
        <div class="summary-item work">
          <div class="summary-value">${this.formatMinutes(stats.work)}</div>
          <div class="summary-label">工作</div>
        </div>
        <div class="summary-item leisure">
          <div class="summary-value">${this.formatMinutes(stats.leisure)}</div>
          <div class="summary-label">休閒</div>
        </div>
        <div class="summary-item other">
          <div class="summary-value">${this.formatMinutes(stats.other)}</div>
          <div class="summary-label">其他</div>
        </div>
      </div>
      
      <div class="productivity-bar">
        <div class="productivity-fill" style="width: ${productivityRate}%"></div>
      </div>
      <div class="productivity-text">生產力指數：${productivityRate}%</div>
    </div>
    
    <div class="stats-card">
      <h2><span class="icon">📱</span> 應用程式排行</h2>
      ${appsHtml || '<div class="empty-state">尚無資料</div>'}
    </div>
    
    <p class="refresh-note">雙擊托盤圖示可重新開啟此視窗更新資料</p>
  </div>
</body>
</html>
    `;
  }

  // HTML 跳脫
  escapeHtml(text) {
    if (!text) return '';
    return text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  // 取得分類標籤
  getCategoryLabel(category) {
    const labels = {
      'work': '💼 工作',
      'leisure': '🔴 休閒',
      'music': '🎵 音樂',
      'idle': '💤 閒置',
      'lunch_break': '🍴 午休',
      'other': '❓ 其他'
    };
    return labels[category] || '其他';
  }

  // 格式化分鐘數
  formatMinutes(minutes) {
    if (!minutes || minutes === 0) return '0 分';
    if (minutes < 60) {
      return `${minutes} 分`;
    }
    const hours = Math.floor(minutes / 60);
    const mins = minutes % 60;
    return mins > 0 ? `${hours}h ${mins}m` : `${hours} 小時`;
  }

  // 顯示通知
  showNotification(title, body) {
    if (Notification.isSupported()) {
      const notification = new Notification({
        title: title,
        body: body,
        silent: true
      });
      notification.show();
    }
  }

  // 顯示關於對話框
  showAboutDialog() {
    const { dialog } = require('electron');

    const effectiveVersion = this.getEffectiveVersion();

    dialog.showMessageBox({
      type: 'info',
      title: '關於添心生產力助手',
      message: '添心生產力助手',
      detail: `版本：v${effectiveVersion}\n\n本系統會記錄：\n✅ 應用程式名稱與使用時長\n✅ 視窗標題（含網頁標題）\n\n本系統不會記錄：\n❌ 螢幕截圖\n❌ 鍵盤輸入\n❌ 網頁內容\n❌ 文件內容\n\n© 2026 添心室內裝修設計`,
      buttons: ['確定']
    });
  }

  // 銷毀托盤與清理資源
  destroy() {
    console.log('[Tray] 正在關閉程式並清理資源...');
    if (this.updateInterval) {
      clearInterval(this.updateInterval);
      this.updateInterval = null;
    }
    if (this.statsWindow) {
      this.statsWindow.destroy(); // 直接強行銷毀
      this.statsWindow = null;
    }
    if (this.tray) {
      this.tray.destroy();
      this.tray = null;
    }

    // [v1.8.9] 移除非預期的 process.exit(0)，修復熱更新導致程式直接消失的 BUG
  }
}

module.exports = { TrayManager };
