// v1.11.17 - 2026-02-26 21:05 (Asia/Taipei)
// 修改內容: 還原所有功能、加入「開啟整合主控台」、修復打卡通訊、祕書裝束改為隨機、語氣專業化 (移除稱謂)。

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
    this.classificationWindow = classificationWindow || null;

    this.tray = null;
    this.statsWindow = null;
    this._registerIpcHandlers();
    console.log('[Tray] 系統功能已全面還原 (v1.11.19)');
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

  _registerIpcHandlers() {
    ipcMain.removeAllListeners('refresh-stats');
    ipcMain.on('refresh-stats', (event, options = {}) => {
      this.showStatsWindow(options && options.isManual === true);
    });

    ipcMain.removeHandler('direct-checkin');
    ipcMain.handle('direct-checkin', async () => {
      if (!this.checkinService) return { success: false, message: '打卡服務未啟動' };
      const bound = this.configManager.getBoundEmployee();
      if (!bound) return { success: false, message: '尚未綁定員工' };
      const res = await this.checkinService.directCheckin(bound.userId, bound.userName);
      if (res && res.success) {
        const info = await this.checkinService.getWorkInfo(bound.userId);
        if (info.success) this.configManager.setTodayWorkInfo(info.data);
      }
      return res;
    });
  }

  async init() {
    this.tray = new Tray(this.createTrayIcon());
    this.tray.setToolTip('添心生產力助手');
    await this.updateMenu();
    setInterval(() => this.updateMenu(), 60000);
    this.tray.on('click', () => this.showStatsWindow(true));
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
      { label: '📊 詳細統計報表', click: () => this.showStatsWindow(true) },
      { type: 'separator' }
    ];

    if (bound) {
      template.push({ label: `👤 ${bound.userName}`, enabled: false }, { type: 'separator' });
    }

    // 恢復整合主控台連結
    template.push({ label: '🖥️ 開啟整合主控台', click: () => { shell.openExternal('https://info.tanxin.space/index.html'); } });

    // 性別設定 (僅保留男女大項)
    template.push({
      label: `🎭 祕書性別: ${gender === 'male' ? '🤵 男版' : '👩 女版'}`,
      click: () => { this.configManager.setMascotGender(gender === 'male' ? 'female' : 'male'); this.updateMenu(); }
    });

    template.push({ type: 'separator' }, { label: '🔄 檢查更新', click: () => this.app.emit('check-for-updates-manual') });
    this.tray.setContextMenu(Menu.buildFromTemplate(template));
  }

  async getStatsData() {
    const gender = this.configManager.getMascotGender();
    let fname = 'secretary.png';

    // 如果是女版，啟用隨機裝束系統 (每次打開隨機切換)
    if (gender === 'female') {
      const skins = ['default', 'blizzard', 'thunder', 'boulder', 'sacred', 'prism'];
      const randomSkin = skins[Math.floor(Math.random() * skins.length)];
      fname = randomSkin === 'default' ? 'secretary.png' : `secretary_${randomSkin}.png`;
    } else {
      fname = 'secretary_male.png';
    }

    return {
      stats: await this.storageService.getTodayStats(),
      hourlyStats: await this.storageService.getHourlyStats(),
      topApps: await this.storageService.getRecentTopApps(1),
      status: this.monitorService.getStatus(),
      boundEmployee: this.configManager.getBoundEmployee(),
      workInfo: this.configManager.getTodayWorkInfo(),
      localTasks: await this.storageService.getLocalTasks(),
      version: versionService.getEffectiveVersion(),
      mascotUrl: `https://raw.githubusercontent.com/nephi4377/TAUpdata/master/client/assets/${fname}`
    };
  }

  async showStatsWindow(isManual = true) {
    const data = await this.getStatsData();
    if (this.statsWindow && !this.statsWindow.isDestroyed()) {
      this.statsWindow.webContents.send('update-stats-data', data);
      if (isManual) this.statsWindow.focus();
      return;
    }
    const html = await this.generateStatsHtml(data);
    const temp = path.join(this.app.getPath('userData'), 'stats_stable_v17.html');
    fs.writeFileSync(temp, html, 'utf8');
    this.statsWindow = new BrowserWindow({
      width: 720, height: 880, title: '添心生產力助手 - 詳細統計',
      autoHideMenuBar: true,
      show: false, // 改為先隱藏，載入完再顯
      webPreferences: { contextIsolation: true, preload: path.join(__dirname, 'reminderPreload.js') }
    });
    this.statsWindow.loadFile(temp);
    this.statsWindow.once('ready-to-show', () => {
      this.statsWindow.show();
      this.statsWindow.webContents.send('update-stats-data', data);
    });
  }

  async generateStatsHtml(data) {
    const { version, mascotUrl, stats, hourlyStats, topApps, boundEmployee, workInfo } = data;
    const rate = stats.total > 0 ? Math.round((stats.work / stats.total) * 100) : 0;

    // 還原完整打卡區塊與主控台按鈕
    const checkinHtml = boundEmployee
      ? `<div class="card"><h2>👤 使用者: ${boundEmployee.userName}</h2><div class="grid2"><div>上班: ${workInfo?.checkinTime || '--:--'}</div><div>下班: ${workInfo?.expectedOffTime || '--:--'}</div></div><div style="display:flex; gap:10px; margin-top:15px;"><button class="btn ok" onclick="doCheckin()">✅ 打卡發送</button><button class="btn info" onclick="window.reminderAPI.openDashboardWindow()">🖥️ 主控台</button></div></div>`
      : `<div class="card" style="border:2px dashed #f7768e; text-align:center;"><h2>⚠️ 未連結打卡帳號</h2><button class="btn" style="background:#7aa2f7; margin-top:10px;" onclick="window.reminderAPI.openLinkWindow()">📲 前往綁定 (LINE)</button></div>`;

    return `<!DOCTYPE html><html><head><meta charset="UTF-8"><style>
      * { margin:0; padding:0; box-sizing:border-box; font-family:sans-serif; }
      body { background:#1a1a2e; color:#eee; padding:20px; }
      .container { max-width: 600px; margin: 0 auto; }
      .mascot-area { display:flex; align-items:center; justify-content:center; gap:20px; margin-bottom:20px; padding:15px; background:rgba(255,255,255,0.05); border-radius:15px; }
      .avatar { width:100px; height:150px; border-radius:10px; background:url('${mascotUrl}') center/cover; border:2px solid #4ecdc4; animation: float 4s infinite ease-in-out; }
      .speech { background:white; color:#333; padding:12px; border-radius:10px; font-size:13px; font-weight:bold; max-width:250px; box-shadow:0 4px 15px rgba(0,0,0,0.2); position:relative; }
      .speech::after { content:''; position:absolute; left:-10px; top:20px; border-width:10px 10px 10px 0; border-style:solid; border-color:transparent white transparent transparent; }
      @keyframes float { 0%, 100% { transform:translateY(0); } 50% { transform:translateY(-6px); } }
      .card { background:rgba(255,255,255,0.08); border-radius:12px; padding:20px; margin-bottom:20px; }
      .btn { flex:1; padding:10px; border:none; border-radius:6px; cursor:pointer; font-weight:bold; color:white; }
      .btn.ok { background:#4ecdc4; color:#1a1a2e; }
      .btn.info { background:#565f89; }
      .grid2 { display:grid; grid-template-columns:1fr 1fr; gap:10px; margin-top:10px; }
      .summary-grid { display:grid; grid-template-columns:1fr 1fr 1fr; gap:10px; text-align:center; }
      .summary-val { font-size:22px; font-weight:bold; color:#4ecdc4; }
      .hour-row { display:flex; align-items:center; margin-bottom:6px; font-size:11px; }
      .hour-bar-box { flex:1; height:8px; display:flex; background:rgba(255,255,255,0.05); margin:0 10px; border-radius:4px; overflow:hidden; }
      .bar.work { background:#4caf50; } .bar.leis { background:#f7768e; } .bar.othe { background:#999; }
      .app-row { display:flex; justify-content:space-between; padding:8px; border-bottom:1px solid rgba(255,255,255,0.05); font-size:13px; }
    </style></head>
    <body onload="init()">
      <div class="container">
        <div class="mascot-area"><div class="avatar"></div><div class="speech" id="msg">工作順利嗎？加油喔！✨</div></div>
        <h1 style="text-align:center; color:#4ecdc4;">📊 生產力統計報表</h1>
        <p style="text-align:center; color:#666; font-size:11px; margin-bottom:15px;">v${version}</p>

        <div id="checkin-box">${checkinHtml}</div>

        <div class="card">
          <h2>⏱️ 今日時間概覽</h2>
          <div class="summary-grid">
            <div style="background:#000; padding:10px; border-radius:8px;"><div id="w-v" class="summary-val">${this.formatMinutes(stats.work)}</div><div>工作</div></div>
            <div style="background:#000; padding:10px; border-radius:8px;"><div id="l-v" class="summary-val" style="color:#f7768e;">${this.formatMinutes(stats.leisure)}</div><div>休閒</div></div>
            <div style="background:#000; padding:10px; border-radius:8px;"><div id="o-v" class="summary-val" style="color:#aaa;">${this.formatMinutes(stats.other)}</div><div>其他</div></div>
          </div>
          <div style="height:10px; background:#333; border-radius:5px; margin:15px 0; overflow:hidden;"><div id="p-f" style="height:100%; background:#4caf50; width:${rate}%;"></div></div>
          <div id="p-t" style="text-align:center; font-size:13px;">當前生產力：${rate}%</div>
        </div>

        <div class="card"><h2>📅 每小時工作詳情</h2><div id="h-l" style="margin-top:10px;">${(hourlyStats || []).map(r => `<div class="hour-row"><span>${r.hour}:00</span><div class="hour-bar-box"><div class="bar work" style="width:${r.work_pct}%"></div><div class="bar leis" style="width:${r.leisure_pct}%"></div><div class="bar othe" style="width:${r.other_pct}%"></div></div><span>${this.formatMinutes(r.total)}</span></div>`).join('')}</div></div>
        <div class="card"><h2>📋 提醒與待辦行程</h2><div id="t-l"></div></div>
        <div class="card"><h2>📱 應用排行</h2><div id="a-l">${(topApps || []).map(a => `<div class="app-row"><span>${a.app_name}</span><span style="color:#4ecdc4;">${this.formatMinutes(Math.round(a.total_seconds / 60))}</span></div>`).join('')}</div></div>
      </div>
      <script>
        function fmt(m){ if(!m)return '0分'; if(m<60)return m+'分'; return Math.floor(m/60)+'h '+(m%60)+'m'; }
        async function doCheckin(){ const r=await window.reminderAPI.directCheckin(); if(r.success) window.reminderAPI.refreshStats(); else alert(r.message); }
        async function toggle(id, s){ await window.reminderAPI.updateLocalTask(id, s); window.reminderAPI.refreshStats(); }

        window.reminderAPI.onUpdateStats((d) => {
          document.getElementById('w-v').innerText = fmt(d.stats.work);
          document.getElementById('l-v').innerText = fmt(d.stats.leisure);
          document.getElementById('o-v').innerText = fmt(d.stats.other);
          const r = d.stats.total > 0 ? Math.round((d.stats.work/d.stats.total)*100) : 0;
          document.getElementById('p-f').style.width = r + '%';
          document.getElementById('p-t').innerText = '當前生產力：' + r + '%';

          // 專業祕書語氣 (移除主人稱謂，加入行程回報)
          const tasks = d.localTasks || [];
          const pendingCount = tasks.filter(t => t.status !== 'completed').length;
          let m = "工作一切順利嗎？加油喔！✨";
          if (pendingCount > 0) m = "今天還有 " + pendingCount + " 項待辦行程需要留意喔，加油！💪";
          else if (r >= 80) m = "今天的效率非常出色，保持這個步調！🚀";
          else if (r >= 50) m = "穩定發揮中，需要休息一下再繼續嗎？☕";
          document.getElementById('msg').innerText = m;

          let th = '';
          tasks.forEach(t => { 
            const isC = t.status === 'completed';
            th += '<div style="display:flex; justify-content:space-between; padding:8px; border-bottom:1px solid rgba(255,255,255,0.05);'+(isC?'opacity:0.4;':'')+'"><span>' + (isC?'✅':'📌') + ' ' + t.title + '</span><button onclick="toggle('+t.id+', \\''+(isC?'pending':'completed')+'\\')">'+(isC?'↩️':'✅')+'</button></div>';
          });
          document.getElementById('t-l').innerHTML = th || '<div style="text-align:center; color:#555;">今日尚無待辦事項</div>';
        });

        function init(){ setTimeout(()=>window.reminderAPI.refreshStats(), 500); }
      </script>
    </body></html>`;
  }

  formatMinutes(m) { if (!m) return '0分'; if (m < 60) return m + '分'; return Math.floor(m / 60) + 'h ' + (m % 60) + 'm'; }
}

module.exports = { TrayManager };
