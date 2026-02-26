// v1.11.13 - 2026-02-26 20:46 (Asia/Taipei)
// 修改內容: 修正完整功能、對接 GitHub 遠端圖片服務、修復 UI 資料顯示異常。

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
    this.classificationWindow = classificationWindow || null;
    this.adminDashboard = adminDashboard || null;

    this.tray = null;
    this.statsWindow = null;
    this._registerIpcHandlers();
    console.log('[Tray] 托盤管理服務已修復完成 (v1.11.13)');
  }

  _registerIpcHandlers() {
    ipcMain.removeAllListeners('refresh-stats');
    ipcMain.on('refresh-stats', (event, options = {}) => {
      this.showStatsWindow(options && options.isManual === true);
    });

    ipcMain.removeHandler('direct-checkin');
    ipcMain.handle('direct-checkin', async () => {
      if (!this.checkinService) return { success: false, message: '打卡服務未啟動' };
      const boundEmployee = this.configManager.getBoundEmployee();
      if (!boundEmployee) return { success: false, message: '尚未綁定員工' };
      const res = await this.checkinService.directCheckin(boundEmployee.userId, boundEmployee.userName);
      if (res && res.success) {
        const info = await this.checkinService.getWorkInfo(boundEmployee.userId);
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
    for (let i = 0; i < size * size; i++) {
      const idx = i * 4;
      canvas[idx] = 76; canvas[idx + 1] = 175; canvas[idx + 2] = 80; canvas[idx + 3] = 255;
    }
    return nativeImage.createFromBuffer(canvas, { width: size, height: size });
  }

  async updateMenu() {
    if (!this.tray) return;
    const stats = await this.storageService.getTodayStats();
    const v = versionService.getEffectiveVersion();
    const gender = this.configManager.getMascotGender();
    const bound = this.configManager.getBoundEmployee();

    const template = [
      { label: `添心生產力助手 v${v}`, enabled: false },
      { label: `今日工作: ${this.formatMinutes(stats.work)} (${stats.productivityRate || 0}%)`, enabled: false },
      { label: '📊 詳細統計 (歷史)', click: () => this.showStatsWindow(true) },
      { type: 'separator' },
      { label: bound ? `👤 使用者: ${bound.userName}` : '⚠️ 未綁定員工', enabled: false },
      { type: 'separator' }
    ];

    // 性別與形象切換
    template.push({
      label: `🎭 形象: ${gender === 'male' ? '🤵 男版' : '👩 女版'}`,
      click: () => { this.configManager.setMascotGender(gender === 'male' ? 'female' : 'male'); this.updateMenu(); }
    });

    if (gender === 'female') {
      const skin = this.configManager.getMascotSkin();
      const sks = [{ id: 'default', n: '🏙️ 預設黑系' }, { id: 'blizzard', n: '❄️ 暴雪藍青' }, { id: 'thunder', n: '⚡ 雷電品紅' }, { id: 'boulder', n: '⛰️ 巨岩純黃' }, { id: 'sacred', n: '🕊️ 神聖之白' }, { id: 'prism', n: '✨ 天星棱光' }];
      template.push({
        label: `👕 裝束: ${sks.find(s => s.id === skin)?.n || '預設'}`,
        submenu: sks.map(s => ({
          label: s.n, type: 'radio', checked: skin === s.id,
          click: () => { this.configManager.setMascotSkin(s.id); this.updateMenu(); }
        }))
      });
    }

    template.push({ type: 'separator' }, { label: '🔄 檢查更新', click: () => this.app.emit('check-for-updates-manual') });
    this.tray.setContextMenu(Menu.buildFromTemplate(template));
  }

  async getStatsData() {
    const gender = this.configManager.getMascotGender();
    const skin = this.configManager.getMascotSkin();
    let fname = 'secretary.png';
    if (gender === 'male') fname = 'secretary_male.png';
    else if (skin !== 'default') fname = `secretary_${skin}.png`;

    // 關鍵修復: 使用 GitHub 遠端圖片 URL 作為後備並優先，解決本機路徑消失問題
    const remoteUrl = `https://raw.githubusercontent.com/nephi4377/TAUpdata/main/client/assets/${fname}`;

    return {
      stats: await this.storageService.getTodayStats(),
      hourlyStats: await this.storageService.getHourlyStats(),
      topApps: await this.storageService.getRecentTopApps(1),
      status: this.monitorService.getStatus(),
      boundEmployee: this.configManager.getBoundEmployee(),
      workInfo: this.configManager.getTodayWorkInfo(),
      localTasks: await this.storageService.getLocalTasks(),
      version: versionService.getEffectiveVersion(),
      mascotUrl: remoteUrl
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
    const temp = path.join(this.app.getPath('userData'), 'stats_v13.html');
    fs.writeFileSync(temp, html, 'utf8');
    this.statsWindow = new BrowserWindow({
      width: 750, height: 900, title: '添心生產力助手 - 詳細統計',
      autoHideMenuBar: true,
      webPreferences: { contextIsolation: true, preload: path.join(__dirname, 'reminderPreload.js') }
    });
    this.statsWindow.loadFile(temp);
  }

  async generateStatsHtml(data) {
    const { version, mascotUrl, stats, boundEmployee, workInfo, localTasks } = data;
    const rate = stats.total > 0 ? Math.round((stats.work / stats.total) * 100) : 0;

    // 生成打卡 HTML (預渲染)
    const checkinHtml = boundEmployee
      ? `<div class="card"><h3>👤 使用者: ${boundEmployee.userName}</h3><div style="display:flex; justify-content:space-between; margin-top:10px;"><span>上班: ${workInfo?.checkinTime || '--:--'}</span><span>下班: ${workInfo?.expectedOffTime || '--:--'}</span></div><button class="btn" style="background:#4ecdc4; color:#1a1a2e; margin-top:15px;" onclick="doCheckin()">✅ 打卡發送</button></div>`
      : `<div class="card" style="border:2px dashed #f7768e; text-align:center;"><h3>⚠️ 未連結帳號</h3><button class="btn" style="background:#7aa2f7; margin-top:10px;" onclick="window.reminderAPI.openLinkWindow()">📲 前往綁定 (LINE)</button></div>`;

    return `<!DOCTYPE html><html><head><meta charset="UTF-8"><style>
      body { background:#1a1a2e; color:#eee; font-family:sans-serif; padding:20px; }
      .container { max-width: 600px; margin: 0 auto; }
      .mascot-area { display:flex; align-items:center; justify-content:center; gap:20px; margin-bottom:25px; }
      .avatar { width:120px; height:180px; border-radius:12px; border:2px solid #4ecdc4; background: url('${mascotUrl}') center/cover; box-shadow: 0 4px 15px rgba(0,0,0,0.5); animation: float 4s infinite ease-in-out; }
      .speech { background:white; color:#333; padding:15px; border-radius:12px; font-size:14px; font-weight:bold; max-width:250px; box-shadow:0 4px 15px rgba(0,0,0,0.2); margin-top:-60px;}
      @keyframes float { 0%, 100% { transform:translateY(0); } 50% { transform:translateY(-8px); } }
      .card { background:rgba(255,255,255,0.08); border-radius:12px; padding:20px; margin-bottom:20px; }
      .btn { width:100%; padding:10px; border:none; border-radius:6px; cursor:pointer; font-weight:bold; color:white; }
      .grid { display:grid; grid-template-columns:1fr 1fr 1fr; gap:10px; text-align:center; margin-top:15px; }
      .val { font-size:20px; font-weight:bold; color:#4ecdc4; }
    </style></head>
    <body onload="init()">
      <div class="container">
        <div class="mascot-area"><div class="avatar"></div><div class="speech" id="msg">今天也要加油喔！✨</div></div>
        <h1 style="text-align:center; color:#4ecdc4;">📊 今日生產力報告</h1>
        <p style="text-align:center; color:#888; font-size:12px;">v${version} (Stable)</p>
        <div id="checkin-box">${checkinHtml}</div>
        <div class="card"><h2>⏱️ 時間統計</h2><div class="grid">
          <div style="background:#000; padding:10px; border-radius:8px;"><div id="w-v" class="val">${this.formatMinutes(stats.work)}</div><div>工作</div></div>
          <div style="background:#000; padding:10px; border-radius:8px;"><div id="l-v" class="val" style="color:#f7768e;">${this.formatMinutes(stats.leisure)}</div><div>休閒</div></div>
          <div style="background:#000; padding:10px; border-radius:8px;"><div id="o-v" class="val" style="color:#aaa;">${this.formatMinutes(stats.other)}</div><div>其他</div></div>
        </div><div style="height:12px; background:#333; border-radius:6px; margin:15px 0; overflow:hidden;"><div id="p-f" style="height:100%; background:#4caf50; width:${rate}%;"></div></div>
        <div id="p-t" style="text-align:center;">生產力指數: ${rate}%</div></div>
        <div class="card"><h2>📋 提醒事項</h2><div id="t-l"></div></div>
        <div class="card"><h2>📱 應用排行</h2><div id="a-l"></div></div>
      </div>
      <script>
        function fmt(m) { if(!m) return '0分'; if(m<60) return m+'分'; return Math.floor(m/60)+'h '+(m%60)+'m'; }
        async function doCheckin() { const r=await window.reminderAPI.directCheckin(); if(r.success) window.reminderAPI.refreshStats(); else alert(r.message); }
        async function toggle(id, s) { await window.reminderAPI.updateLocalTask(id, s); window.reminderAPI.refreshStats(); }

        window.reminderAPI.onUpdateStats((d) => {
          document.getElementById('w-v').innerText = fmt(d.stats.work);
          document.getElementById('l-v').innerText = fmt(d.stats.leisure);
          document.getElementById('o-v').innerText = fmt(d.stats.other);
          const r = d.stats.total > 0 ? Math.round((d.stats.work/d.stats.total)*100) : 0;
          document.getElementById('p-f').style.width = r + '%';
          document.getElementById('p-t').innerText = '生產力指數: ' + r + '%';
          
          if (r >= 80) document.getElementById('msg').innerText = "你太優秀了！效率滿分！🚀";
          else if (r >= 50) document.getElementById('msg').innerText = "穩定發揮，繼續加油！✨";
          else document.getElementById('msg').innerText = "休息一下也沒關係，小秘書陪你！💪";

          let th = '';
          (d.localTasks || []).forEach(t => { th += '<div style="display:flex; justify-content:space-between; padding:8px; border-bottom:1px solid rgba(255,255,255,0.05);"><span>'+t.title+'</span><button onclick="toggle('+t.id+', \\'completed\\')">✅</button></div>'; });
          document.getElementById('t-l').innerHTML = th || '<div style="text-align:center; color:#666;">尚無事項</div>';
          
          let ah = '';
          (d.topApps || []).forEach(a => { ah += '<div style="display:flex; justify-content:space-between; padding:8px; border-bottom:1px solid rgba(255,255,255,0.05);"><span>'+a.app_name+'</span><span style="color:#4ecdc4;">'+fmt(Math.round(a.total_seconds/60))+'</span></div>'; });
          document.getElementById('a-l').innerHTML = ah;
        });

        function init() { setTimeout(() => { if(window.reminderAPI.refreshStats) window.reminderAPI.refreshStats(); }, 300); }
      </script>
    </body></html>`;
  }

  formatMinutes(m) { if (!m) return '0分'; if (m < 60) return m + '分'; return Math.floor(m / 60) + 'h ' + (m % 60) + 'm'; }
}

module.exports = { TrayManager };
