// v1.11.10 - 2026-02-26 20:18 (Asia/Taipei)
// 修改內容: 徹底修復模板語法字串錯誤 (移除所有錯誤的反斜線)，確保數據與小秘書顯示正常。

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
    this._registerIpcHandlers();

    console.log('[Tray] 托盤管理服務已建立');
  }

  _registerIpcHandlers() {
    ipcMain.removeAllListeners('refresh-stats');
    ipcMain.on('refresh-stats', (event, options = {}) => {
      const isManual = options && options.isManual === true;
      this.showStatsWindow(isManual);
    });

    ipcMain.removeHandler('direct-checkin');
    ipcMain.handle('direct-checkin', async () => {
      if (this.checkinService) {
        const boundEmployee = this.configManager.getBoundEmployee();
        if (boundEmployee) {
          const res = await this.checkinService.directCheckin(boundEmployee.userId, boundEmployee.userName);
          if (res && res.success) {
            const workInfoRes = await this.checkinService.getWorkInfo(boundEmployee.userId);
            if (workInfoRes.success) {
              this.configManager.setTodayWorkInfo(workInfoRes.data);
            }
            this.monitorService.showToast('打卡成功', res.message || '已經成功送出打卡紀錄');
          }
          return res;
        } else {
          return { success: false, message: '尚未綁定員工' };
        }
      }
      return { success: false, message: '打卡服務未啟動' };
    });
  }

  async init() {
    const allWindows = BrowserWindow.getAllWindows();
    for (const win of allWindows) {
      if (!win.isDestroyed() && win.getTitle() === '添心生產力助手 - 詳細統計') {
        win.destroy();
      }
    }

    const icon = this.createTrayIcon();
    this.tray = new Tray(icon);
    this.tray.setToolTip('添心生產力助手');

    await this.updateMenu();

    this.updateInterval = setInterval(async () => {
      await this.updateMenu();
    }, 60 * 1000);

    this.tray.on('click', () => { this.showStatsWindow(); });
    this.tray.on('double-click', () => { this.showStatsWindow(); });

    console.log('[Tray] 系統托盤已初始化');
  }

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
          canvas[idx] = 76; canvas[idx + 1] = 175; canvas[idx + 2] = 80; canvas[idx + 3] = 255;
        } else {
          canvas[idx] = 0; canvas[idx + 1] = 0; canvas[idx + 2] = 0; canvas[idx + 3] = 0;
        }
      }
    }
    return nativeImage.createFromBuffer(canvas, { width: size, height: size });
  }

  getEffectiveVersion() {
    return versionService.getEffectiveVersion();
  }

  async updateMenu() {
    const status = this.monitorService.getStatus();
    const stats = await this.storageService.getTodayStats();
    let statusLabel = status.isLunchBreak ? '🍴 午休時間' : (status.idleTime >= status.idleThreshold ? `💤 閒置中 (${Math.floor(status.idleTime / 60)}分鐘)` : '🟢 監測中');
    const productivityRate = stats.productivityRate || 0;
    const effectiveVersion = this.getEffectiveVersion();

    const template = [
      { label: `添心生產力助手 v${effectiveVersion} (${statusLabel})`, enabled: false },
      { label: `今日工作: ${this.formatMinutes(stats.work)} (${productivityRate}%)`, enabled: false },
      { label: '📊 詳細統計 (歷史)', click: () => this.showStatsWindow() },
      { type: 'separator' },
    ];

    let boundEmployee = this.configManager.getBoundEmployee();
    if (boundEmployee) {
      template.push({ label: `👤 使用者: ${boundEmployee.userName}`, enabled: false }, { type: 'separator' });
    } else {
      template.push({ label: '⚠️ 未綁定員工', enabled: false }, { type: 'separator' });
    }

    template.push({ label: '🖥️ 開啟整合主控台', click: () => { shell.openExternal('https://info.tanxin.space/index.html'); } });

    if (this.reminderService) {
      const reminderStatus = this.reminderService.getTodayReminderStatus();
      if (reminderStatus.length > 0) {
        template.push({ type: 'separator' });
        template.push({
          label: `📋 今日提醒 (✅${this.reminderService.getCompletedCount()} / ⬜${this.reminderService.getPendingCount()})`,
          submenu: reminderStatus.map(item => ({ label: `${item.status === 'completed' ? '✅' : (item.status === 'snoozed' ? '⏰' : '⬜')} ${item.icon} ${item.title}`, enabled: false }))
        });
      }
    }

    if (status.lastAppName) {
      template.push({ type: 'separator' }, { label: `📍 當前: ${status.lastAppName}`, enabled: false }, { label: `🏷️ 分類: ${this.getCategoryLabel(status.lastCategory)}`, enabled: false });
    }

    template.push({ type: 'separator' });
    template.push({
      label: '⬆️ 手動上傳今日報告',
      enabled: !!boundEmployee,
      click: async () => {
        if (this.checkinService) {
          const result = await this.checkinService.submitTodayReport(this.storageService, this.reminderService);
          if (result && result.success) this.monitorService.showToast('上傳成功', '今日報告已上傳 ✅');
          else if (result) this.monitorService.showToast('上傳失敗', result.message);
        }
      }
    });

    const userRole = boundEmployee ? (Number(boundEmployee.permission) || 0) : 0;
    const isBoss = boundEmployee && (boundEmployee.group === 'BOSS' || boundEmployee.userName === '管理者' || boundEmployee.userName === '黃俊豪');
    if (userRole === 5 || isBoss) {
      template.push({ label: '🔧 分類管理', click: () => this.classificationWindow?.show() });
      template.push({ label: '📊 管理員面板', click: () => this.adminDashboard?.show() });
    }

    template.push({ label: '🔄 切換使用者', click: async () => { if (this.setupWindow) { const sel = await this.setupWindow.show('switch'); if (sel) { this.monitorService?.showToast('切換成功', `使用者已切換為: ${sel.userName}`); this.updateMenu(); } } } });

    // [v1.11.10] 切換秘書性別
    const currentGender = this.configManager.getMascotGender();
    template.push({
      label: `🎭 秘書形象: ${currentGender === 'male' ? '🤵 韓系帥哥' : '👩 幹練美女'}`,
      click: () => {
        const next = currentGender === 'male' ? 'female' : 'male';
        this.configManager.setMascotGender(next);
        this.monitorService.showToast('形象切換', `小秘書已變身為: ${next === 'male' ? '帥哥秘書' : '美女秘書'}`);
        this.updateMenu();
      }
    });
    template.push({
      label: '🗓️ 設定 iCloud 行事曆', click: async () => {
        const url = await this._promptIcloudUrl();
        if (url !== null) {
          let cleanUrl = url.trim();
          if (cleanUrl.startsWith('webcal://')) cleanUrl = 'https://' + cleanUrl.substring(9);
          else if (cleanUrl !== '' && !cleanUrl.startsWith('http')) cleanUrl = 'https://' + cleanUrl;
          this.configManager.setIcloudCalendarUrl(cleanUrl);
          this.monitorService.showToast('設定成功', 'iCloud 連結已存檔。');
          this.reminderService?.stop(); this.reminderService?.start();
        }
      }
    });

    template.push({ type: 'separator' }, { label: '🔄 檢查更新', click: () => this.app.emit('check-for-updates-manual') });

    const contextMenu = Menu.buildFromTemplate(template);
    this.tray.setContextMenu(contextMenu);
    this.tray.setToolTip(`添心生產力助手 v${this.getEffectiveVersion()} - ${boundEmployee?.userName || ''}`);
  }

  async showStatsWindow(isManual = true) {
    if (this.checkinService && isManual) this.checkinService.refreshWorkInfo().catch(() => { });
    const statsData = await this.getStatsData();
    if (this.statsWindow && !this.statsWindow.isDestroyed()) {
      if (isManual) this.statsWindow.focus();
      this.statsWindow.webContents.send('update-stats-data', statsData);
      return;
    }
    const tempPath = path.join(this.app.getPath('userData'), 'stats.html');
    const html = await this.generateStatsHtml(statsData);
    fs.writeFileSync(tempPath, html, 'utf8');
    this.statsWindow = new BrowserWindow({
      width: 700, height: 850, title: '添心生產力助手 - 詳細統計',
      resizable: true, autoHideMenuBar: true,
      webPreferences: { nodeIntegration: false, contextIsolation: true, preload: path.join(__dirname, 'reminderPreload.js') }
    });
    this.statsWindow.loadFile(tempPath);
    this.statsWindow.on('closed', () => { this.statsWindow = null; });
  }

  async getStatsData() {
    return {
      stats: await this.storageService.getTodayStats(),
      hourlyStats: await this.storageService.getHourlyStats(),
      topApps: await this.storageService.getRecentTopApps(1),
      browserHistory: await this.storageService.getBrowserHistory(),
      status: this.monitorService.getStatus(),
      boundEmployee: this.configManager.getBoundEmployee(),
      workInfo: this.configManager.getTodayWorkInfo(),
      reminderStatus: this.reminderService ? this.reminderService.getTodayReminderStatus() : [],
      localTasks: await this.storageService.getLocalTasks(),
      version: this.getEffectiveVersion()
    };
  }

  async generateStatsHtml(data) {
    const { stats, hourlyStats, topApps, browserHistory, status, boundEmployee, workInfo, reminderStatus, localTasks, version } = data;
    const rate = stats.total > 0 ? Math.round((stats.work / stats.total) * 100) : 0;

    // 動態讀取小秘書圖片並轉為 Base64
    let secretaryBase64 = '';
    try {
      const gender = this.configManager.getMascotGender();
      const fileName = gender === 'male' ? 'secretary_male.png' : 'secretary.png';
      const imgPath = path.join(__dirname, '../assets', fileName);
      if (fs.existsSync(imgPath)) {
        secretaryBase64 = `data:image/png;base64,${fs.readFileSync(imgPath).toString('base64')}`;
      }
    } catch (e) { console.error('讀取小秘書圖片失敗', e); }

    let hourlyHtml = hourlyStats.map(row => `
      <div class="hour-row">
        <span class="hour-label">${row.hour.toString().padStart(2, '0')}:00</span>
        <div class="hour-bar-container">
          <div class="hour-bar work" style="width: ${row.work_pct}%"></div>
          <div class="hour-bar leisure" style="width: ${row.leisure_pct}%"></div>
          <div class="hour-bar other" style="width: ${row.other_pct}%"></div>
        </div>
        <span class="hour-total">${this.formatMinutes(row.total)}</span>
      </div>`).join('');

    let appsHtml = topApps.map(app => `
      <div class="app-row">
        <span class="app-name">${this.escapeHtml(app.app_name)}</span>
        <span class="app-category ${app.category || 'other'}">${this.getCategoryLabel(app.category)}</span>
        <span class="app-time">${this.formatMinutes(Math.round(app.total_seconds / 60))}</span>
      </div>`).join('');

    let checkinHtml = boundEmployee
      ? `<div class="stats-card checkin-card"><h2>👤 打卡資訊 - ${this.escapeHtml(boundEmployee.userName)}</h2><div class="checkin-grid"><div class="checkin-item"><span class="label">打卡時間</span><span class="value">${workInfo?.checkedIn ? workInfo.checkinTime : '⚠️ 未打卡'}</span></div><div class="checkin-item"><span class="label">預計下班</span><span class="value">${workInfo?.expectedOffTime || '--:--'}</span></div></div><div style="margin-top:15px; display:flex; gap:10px;"><button id="directCheckinBtn" class="complete-btn" style="flex:1; background:#4ecdc4; color:#1a1a2e; font-weight:bold;" onclick="performDirectCheckin()">✅ 立即打卡</button><button class="complete-btn" style="flex:1; background:#bb9af7;" onclick="window.reminderAPI.openDashboardWindow()">📊 主控台</button></div></div>`
      : `<div class="stats-card checkin-card" style="border: 2px dashed #f7768e;"><h2>⚠️ 未連結帳號</h2><button class="complete-btn" style="background:#7aa2f7; width:100%;" onclick="window.reminderAPI.openLinkWindow()">📲 立即前往打卡 (LINE)</button></div>`;

    return `<!DOCTYPE html><html><head><meta charset="UTF-8"><style>
      * { margin:0; padding:0; box-sizing:border-box; font-family:'Microsoft JhengHei', sans-serif; }
      body { background:#1a1a2e; color:#eee; padding:20px; overflow-x:hidden; }
      .container { position: relative; max-width: 660px; margin: 0 auto; }
      .secretary-box { display: flex; align-items: center; justify-content: center; gap: 15px; margin-bottom: 25px; animation: fadeInDown 0.8s ease-out; }
      .secretary-avatar { width: 100px; height: 160px; border-radius: 12px; background: url(${secretaryBase64}) center/cover; border: 2px solid #4ecdc4; box-shadow: 0 4px 15px rgba(0,0,0,0.3); animation: float 4s ease-in-out infinite; }
      .secretary-speech { background: white; color: #333; padding: 12px 18px; border-radius: 15px 15px 15px 0; position: relative; font-size: 14px; font-weight: bold; max-width: 250px; box-shadow: 0 4px 15px rgba(0,0,0,0.2); margin-top: -60px; animation: speechFloat 4s ease-in-out infinite 0.5s; }
      .secretary-speech::after { content: ''; position: absolute; left: -10px; bottom: 0; border-width: 10px 10px 0 0; border-style: solid; border-color: white transparent; }
      @keyframes float { 0%, 100% { transform: translateY(0); } 50% { transform: translateY(-8px); } }
      @keyframes speechFloat { 0%, 100% { transform: translateY(0); } 50% { transform: translateY(-4px); } }
      @keyframes fadeInDown { from { opacity: 0; transform: translateY(-20px); } to { opacity: 1; transform: translateY(0); } }
      .stats-card { background:rgba(255,255,255,0.1); border-radius:12px; padding:20px; margin-bottom:20px; }
      h1 { text-align:center; color:#4ecdc4; margin-bottom:5px; font-size: 22px; }
      .status-badge { display:inline-block; padding:4px 12px; border-radius:12px; font-size:12px; margin-bottom:15px; }
      .status-badge.running { background:#4caf50; } .status-badge.paused { background:#ff9800; }
      .summary-grid { display:grid; grid-template-columns:1fr 1fr 1fr; gap:15px; text-align:center; }
      .summary-item { background:rgba(255,255,255,0.05); padding:15px; border-radius:8px; }
      .summary-value { font-size:24px; font-weight:bold; color:#4ecdc4; }
      .productivity-bar { height:12px; background:rgba(255,255,255,0.1); border-radius:6px; overflow:hidden; margin:15px 0; }
      .productivity-fill { height:100%; background:#4caf50; transition:width 0.5s; }
      .reminder-row { display:flex; align-items:center; padding:10px; border-bottom:1px solid rgba(255,255,255,0.1); }
      .reminder-row.completed { opacity:0.6; text-decoration:line-through; }
      .complete-btn { padding:6px 12px; border-radius:6px; border:none; cursor:pointer; font-weight:bold; font-size:12px; }
      .hour-row { display:flex; align-items:center; margin-bottom:8px; font-size:12px; }
      .hour-bar-container { flex:1; height:12px; display:flex; background:rgba(255,255,255,0.05); margin:0 10px; border-radius:3px; overflow:hidden; }
      .hour-bar.work { background:#4caf50; } .hour-bar.leisure { background:#f7768e; } .hour-bar.other { background:#9e9e9e; }
    </style>
    <script>
      function formatMinutes(m) { if(!m) return '0分'; if(m<60) return m+'分'; return Math.floor(m/60)+'h '+(m%60)+'m'; }
      async function toggleTaskStatus(id, s) { await window.reminderAPI.updateLocalTask(id, s); window.reminderAPI.refreshStats(); }
      async function deleteTask(id) { if(confirm('確定刪除？')){ await window.reminderAPI.deleteLocalTask(id); window.reminderAPI.refreshStats(); } }
      async function doAddLocalTask() {
        const t = document.getElementById('local-task-input').value.trim();
        const d = document.getElementById('reminder-dt').value;
        const tm = document.getElementById('reminder-tm').value;
        if(t){ await window.reminderAPI.addLocalTask(t, d, tm, parseInt(document.getElementById('reminder-ld').value), document.getElementById('reminder-rp').value); window.reminderAPI.refreshStats(); }
      }
      async function performDirectCheckin() { const b=document.getElementById('directCheckinBtn'); b.disabled=true; b.innerText='打卡中...'; const r=await window.reminderAPI.directCheckin(); if(r?.success) setTimeout(()=>window.reminderAPI.refreshStats(), 1000); else { b.disabled=false; b.innerText='重試打卡'; alert(r?.message); } }

      if(window.reminderAPI?.onUpdateStats) {
        window.reminderAPI.onUpdateStats((data) => {
          document.querySelector('.status-badge').className = 'status-badge ' + (data.status.isPaused ? 'paused' : 'running');
          document.querySelector('.status-badge').innerText = (data.status.isPaused ? '⏸️ 暫停中' : '🟢 監測中') + ' · 已取樣 ' + data.status.sampleCount;
          document.getElementById('work-val').innerText = formatMinutes(data.stats.work);
          document.getElementById('leisure-val').innerText = formatMinutes(data.stats.leisure);
          document.getElementById('other-val').innerText = formatMinutes(data.stats.other);
          const r = data.stats.total > 0 ? Math.round((data.stats.work/data.stats.total)*100) : 0;
          document.querySelector('.productivity-fill').style.width = r + '%';
          document.getElementById('prod-txt').innerText = '生產力指數：' + r + '%';
          
          const msgEl = document.getElementById('secretary-msg');
          if (msgEl) {
            if (r >= 80) msgEl.innerText = "太厲害了！今天的你是生產力大神！🚀";
            else if (r >= 50) msgEl.innerText = "做得好！穩定保持這個節奏喔！✨";
            else if (r >= 30) msgEl.innerText = "加油加油，小秘書會一直陪著你的！💪";
            else msgEl.innerText = "累了嗎？起來動一動，等下再繼續吧～🍃";
          }

          const list = document.getElementById('local-tasks-list');
          if(list && data.localTasks) {
            (async () => {
              let h = '';
              const icloud = await window.reminderAPI.getIcloudEvents().catch(()=>[]);
              icloud.forEach(ev => { h += '<div class="reminder-row" style="border-left:4px solid #4caf50;"><span style="margin-right:10px;">🍏</span><div style="flex:1;"><b>[雲端] ' + ev.title.replace('[Apple行事曆] ', '') + '</b><br><small>' + ev.timeStr + '</small></div></div>'; });
              data.localTasks.forEach(t => { 
                const isC = t.status === 'completed';
                h += '<div class="reminder-row ' + (isC ? 'completed' : '') + '"><span>📌</span><div style="flex:1;">' + t.title + '<br><small>' + (t.due_date || '') + ' ' + (t.due_time || '') + '</small></div><button class="complete-btn" onclick="toggleTaskStatus(' + t.id + ', \'' + (isC ? 'pending' : 'completed') + '\')">' + (isC ? '↩️' : '✅') + '</button><button class="complete-btn" style="background:#f7768e; margin-left:5px;" onclick="deleteTask(' + t.id + ')">🗑️</button></div>';
              });
              list.innerHTML = h || '<div style="text-align:center; padding:10px; color:#888;">尚無待辦事項</div>';
            })();
          }
        });
      }
    </script></head><body>
      <div class="container">
        <div class="secretary-box">
          <div class="secretary-avatar"></div>
          <div class="secretary-speech" id="secretary-msg">工作辛苦了，喝杯咖啡休息一下吧！☕</div>
        </div>
        <h1>📊 今日生產力報告</h1>
        <div style="text-align:center; color:#888; font-size:12px; margin-bottom:15px;">v${version || '1.11.10'} (Latest)</div>
        <div style="text-align:center;"><div class="status-badge ${status.isPaused ? 'paused' : 'running'}">${status.isPaused ? '⏸️ 暫停中' : '🟢 監測中'} · 已取樣 ${status.sampleCount}</div></div>
        ${checkinHtml}
        <div class="stats-card">
          <h2>⏱️ 時間統計</h2>
          <div class="summary-grid">
            <div class="summary-item"><div class="summary-value" id="work-val">${this.formatMinutes(stats.work)}</div><div style="color:#888;font-size:12px;">工作</div></div>
            <div class="summary-item"><div class="summary-value" id="leisure-val" style="color:#f7768e;">${this.formatMinutes(stats.leisure)}</div><div style="color:#888;font-size:12px;">休閒</div></div>
            <div class="summary-item"><div class="summary-value" id="other-val" style="color:#9e9e9e;">${this.formatMinutes(stats.other)}</div><div style="color:#888;font-size:12px;">其他</div></div>
          </div>
          <div class="productivity-bar"><div class="productivity-fill" style="width: ${rate}%"></div></div>
          <div id="prod-txt" style="text-align:center; font-size:14px; color:#888;">生產力指數：${rate}%</div>
        </div>
        <div class="stats-card">
          <h2>📋 進階提醒事項</h2>
          <div style="background:rgba(255,255,255,0.05); padding:15px; border-radius:8px; margin-bottom:15px;">
            <input type="text" id="local-task-input" placeholder="提醒內容..." style="width:100%; padding:8px; background:#1a1b26; border:1px solid #3d59a1; color:white; border-radius:4px; margin-bottom:10px;">
            <div style="display:flex; gap:10px; font-size:12px; margin-bottom:10px;">
              🗓️ <input type="date" id="reminder-dt" value="${new Date().toISOString().split('T')[0]}" style="background:#1a1b26; color:white; border:1px solid #3d59a1; padding:2px;">
              ⏰ <input type="time" id="reminder-tm" value="${new Date().toTimeString().split(' ')[0].substring(0, 5)}" style="background:#1a1b26; color:white; border:1px solid #3d59a1; padding:2px;">
            </div>
            <div style="display:flex; gap:10px; font-size:12px; margin-bottom:10px;">
              🔔 <select id="reminder-ld" style="background:#1a1b26; color:white;"><option value="0">準時</option><option value="10" selected>10分</option></select>
              🔄 <select id="reminder-rp" style="background:#1a1b26; color:white;"><option value="none" selected>不重複</option><option value="daily">每天</option></select>
            </div>
            <button class="complete-btn" style="width:100%; height:36px; background:#4caf50;" onclick="doAddLocalTask()">➕ 新增提醒</button>
          </div>
          <div id="local-tasks-list">
            ${localTasks.map(t => {
      const isC = t.status === 'completed';
      return `<div class="reminder-row ${isC ? 'completed' : ''}"><span>📌</span><div style="flex:1;">${t.title}<br><small>${t.due_date || ''} ${t.due_time || ''}</small></div><button class="complete-btn" onclick="toggleTaskStatus(${t.id}, '${isC ? 'pending' : 'completed'}')">${isC ? '↩️' : '✅'}</button></div>`;
    }).join('')}
          </div>
        </div>
        <div class="stats-card"><h2>📱 應用排行</h2>${appsHtml || '<div style="text-align:center; color:#888;">尚無資料</div>'}</div>
        <div style="text-align:center; margin-top:10px;"><button class="complete-btn" style="background:#3d59a1; width:50%;" onclick="window.reminderAPI.refreshStats()">� 刷新數據</button></div>
      </div>
    </body></html>`;
  }

  escapeHtml(t) { return t ? t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;') : ''; }
  getCategoryLabel(c) { const l = { 'work': '💼 工作', 'leisure': '🔴 休閒', 'idle': '💤 閒置', 'other': '❓ 其他' }; return l[c] || '其他'; }
  formatMinutes(m) { if (!m) return '0分'; if (m < 60) return m + '分'; return Math.floor(m / 60) + 'h ' + (m % 60) + 'm'; }
  destroy() { if (this.updateInterval) clearInterval(this.updateInterval); if (this.statsWindow) this.statsWindow.destroy(); if (this.tray) this.tray.destroy(); }
  async _promptIcloudUrl() {
    return new Promise((resolve) => {
      const cur = this.configManager.getIcloudCalendarUrl() || '';
      const win = new BrowserWindow({ width: 450, height: 260, frame: false, alwaysOnTop: true, backgroundColor: '#1e1e2e', webPreferences: { nodeIntegration: true, contextIsolation: false } });
      const h = `<!DOCTYPE html><html><body style="background:#1e1e2e; color:#eee; font-family:sans-serif; padding:20px; overflow:hidden;">
        <h3>🗓️ iCloud 行事曆設定</h3>
        <p style="font-size:12px; color:#aaa;">貼上您的公開 iCloud webcal 網址</p>
        <input id="u" value="${cur}" style="width:100%; padding:10px; background:#2a2a3e; color:white; border:1px solid #444; border-radius:4px; margin-bottom:15px; outline:none;">
        <div style="display:flex; gap:10px;">
          <button onclick="require('electron').ipcRenderer.send('p-cal-ok', '')" style="flex:1; padding:10px; background:#f7768e; border:none; color:white; border-radius:4px; cursor:pointer;">清除</button>
          <button onclick="require('electron').ipcRenderer.send('p-cal-ok', document.getElementById('u').value)" style="flex:1; padding:10px; background:#6366f1; border:none; color:white; border-radius:4px; cursor:pointer;">儲存</button>
          <button onclick="window.close()" style="flex:1; padding:10px; background:#444; border:none; color:white; border-radius:4px; cursor:pointer;">取消</button>
        </div><script>document.getElementById('u').focus();</script></body></html>`;
      win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(h)}`);
      ipcMain.once('p-cal-ok', (e, v) => { win.close(); resolve(v); });
    });
  }
}

module.exports = { TrayManager };
