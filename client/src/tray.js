// v1.11.14 - 2026-02-26 20:50 (Asia/Taipei)
// 修改內容: 還原經典數據佈局 (不改變原本介面)，同時將小秘書作為「置頂外掛組件」插入。
// 影像來源對接 GitHub 以確保 100% 顯示。

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
      { label: '📊 開啟統計', click: () => this.showStatsWindow(true) },
      { type: 'separator' }
    ];

    if (bound) {
      template.push({ label: `👤 ${bound.userName}`, enabled: false });
    }

    template.push({
      label: `🎭 形象: ${gender === 'male' ? '🤵 男版' : '👩 女版'}`,
      click: () => { this.configManager.setMascotGender(gender === 'male' ? 'female' : 'male'); this.updateMenu(); }
    });

    if (gender === 'female') {
      const skin = this.configManager.getMascotSkin();
      const sks = [{ id: 'default', n: '👔 經典黑' }, { id: 'blizzard', n: '❄️ 藍青' }, { id: 'thunder', n: '⚡ 品紅' }, { id: 'boulder', n: '⛰️ 純黃' }, { id: 'sacred', n: '🕊️ 白色' }, { id: 'prism', n: '✨ 棱光' }];
      template.push({
        label: `👕 裝束切換`,
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
    const temp = path.join(this.app.getPath('userData'), 'stats_stable.html');
    fs.writeFileSync(temp, html, 'utf8');
    this.statsWindow = new BrowserWindow({
      width: 720, height: 880, title: '添心生產力助手 - 詳細統計',
      autoHideMenuBar: true,
      webPreferences: { contextIsolation: true, preload: path.join(__dirname, 'reminderPreload.js') }
    });
    this.statsWindow.loadFile(temp);
  }

  async generateStatsHtml(data) {
    const { version, mascotUrl, stats, hourlyStats, topApps, status, boundEmployee, workInfo, localTasks } = data;
    const rate = stats.total > 0 ? Math.round((stats.work / stats.total) * 100) : 0;

    // 經典打卡卡片還原
    const checkinHtml = boundEmployee
      ? `<div class="stats-card checkin-card"><h2>👤 打卡資訊 - ${boundEmployee.userName}</h2><div class="checkin-grid"><div class="checkin-item"><span class="label">打卡時間</span><span class="value">${workInfo?.checkedIn ? (workInfo.checkinTime || '已打卡') : '⚠️ 未打卡'}</span></div><div class="checkin-item"><span class="label">預計下班</span><span class="value">${workInfo?.expectedOffTime || '--:--'}</span></div></div><button class="complete-btn" style="margin-top:15px; background:#4ecdc4; color:#1a1a2e;" onclick="window.reminderAPI.directCheckin().then(r=>r.success && window.reminderAPI.refreshStats())">✅ 立即打卡</button></div>`
      : `<div class="stats-card checkin-card" style="border: 2px dashed #f7768e;"><h2>⚠️ 未連結打卡帳號</h2><button class="complete-btn" style="background:#7aa2f7; width:100%;" onclick="window.reminderAPI.openLinkWindow()">📲 立即前往綁定 (LINE)</button></div>`;

    // 經典小時橫條圖還原
    const hourlyHtml = (hourlyStats || []).map(row => `
      <div class="hour-row">
        <span class="hour-label">${row.hour.toString().padStart(2, '0')}:00</span>
        <div class="hour-bar-container">
          <div class="hour-bar work" style="width: ${row.work_pct || 0}%"></div>
          <div class="hour-bar leisure" style="width: ${row.leisure_pct || 0}%"></div>
          <div class="hour-bar other" style="width: ${row.other_pct || 0}%"></div>
        </div>
        <span class="hour-total">${this.formatMinutes(row.total)}</span>
      </div>`).join('');

    // 經典應用排行還原
    const appsHtml = (topApps || []).map(app => `
      <div class="app-row">
        <span class="app-name">${app.app_name}</span>
        <span class="app-time">${this.formatMinutes(Math.round(app.total_seconds / 60))}</span>
      </div>`).join('');

    return `<!DOCTYPE html><html><head><meta charset="UTF-8"><style>
      * { margin:0; padding:0; box-sizing:border-box; font-family:'Microsoft JhengHei', sans-serif; }
      body { background:#1a1a2e; color:#eee; padding:20px; }
      .container { max-width: 660px; margin: 0 auto; }
      
      /* 小秘書置頂組件 - 外掛式設計 */
      .mascot-overlay { display:flex; align-items:center; justify-content:center; gap:15px; margin-bottom:20px; padding:15px; background:rgba(255,255,255,0.05); border-radius:15px; border:1px solid rgba(78,205,196,0.3); }
      .mascot-img { width:100px; height:150px; border-radius:10px; background:url('${mascotUrl}') center/cover; border:2px solid #4ecdc4; animation: float 4s infinite ease-in-out; }
      .mascot-speech { background:white; color:#333; padding:12px; border-radius:12px; font-size:14px; font-weight:bold; max-width:250px; box-shadow:0 4px 15px rgba(0,0,0,0.2); position:relative; }
      .mascot-speech::after { content:''; position:absolute; left:-10px; top:20px; border-width:10px 10px 10px 0; border-style:solid; border-color:transparent white transparent transparent; }
      @keyframes float { 0%, 100% { transform:translateY(0); } 50% { transform:translateY(-6px); } }

      .stats-card { background:rgba(255,255,255,0.08); border-radius:12px; padding:20px; margin-bottom:20px; }
      h1 { text-align:center; color:#4ecdc4; margin-bottom:15px; }
      .summary-grid { display:grid; grid-template-columns:1fr 1fr 1fr; gap:15px; text-align:center; }
      .summary-val { font-size:24px; font-weight:bold; color:#4ecdc4; }
      .prod-bar { height:12px; background:rgba(255,255,255,0.1); border-radius:6px; margin:15px 0; overflow:hidden; }
      .prod-fill { height:100%; background:#4caf50; transition:width 0.5s; }
      .checkin-grid { display:grid; grid-template-columns:1fr 1fr; gap:10px; margin-top:10px; }
      .hour-row { display:flex; align-items:center; margin-bottom:8px; font-size:12px; }
      .hour-bar-container { flex:1; height:10px; display:flex; background:rgba(255,255,255,0.05); margin:0 10px; border-radius:5px; overflow:hidden; }
      .hour-bar.work { background:#4caf50; } .hour-bar.leisure { background:#f7768e; } .hour-bar.other { background:#999; }
      .complete-btn { padding:10px; border:none; border-radius:8px; cursor:pointer; font-weight:bold; width:100%; }
      .app-row { display:flex; justify-content:space-between; padding:8px; border-bottom:1px solid rgba(255,255,255,0.05); font-size:14px; }
    </style></head>
    <body onload="start()">
      <div class="container">
        <!-- 外掛小秘書 -->
        <div class="mascot-overlay">
          <div class="mascot-img"></div>
          <div class="mascot-speech" id="m-s">主人工作辛苦了！✨</div>
        </div>

        <h1>📊 生產力詳細報表</h1>
        <p style="text-align:center; color:#666; font-size:11px; margin-top:-10px; margin-bottom:15px;">v${version}</p>

        <div id="checkin-area">${checkinHtml}</div>

        <div class="stats-card">
          <h2>⏱️ 今日數據概覽</h2>
          <div class="summary-grid">
            <div style="background:rgba(0,0,0,0.2); padding:10px; border-radius:8px;"><div id="w-v" class="summary-val">${this.formatMinutes(stats.work)}</div><div style="font-size:12px; color:#888;">工作</div></div>
            <div style="background:rgba(0,0,0,0.2); padding:10px; border-radius:8px;"><div id="l-v" class="summary-val" style="color:#f7768e;">${this.formatMinutes(stats.leisure)}</div><div style="font-size:12px; color:#888;">休閒</div></div>
            <div style="background:rgba(0,0,0,0.2); padding:10px; border-radius:8px;"><div id="o-v" class="summary-val" style="color:#aaa;">${this.formatMinutes(stats.other)}</div><div style="font-size:12px; color:#888;">其他</div></div>
          </div>
          <div class="prod-bar"><div id="p-f" class="prod-fill" style="width:${rate}%;"></div></div>
          <div id="p-t" style="text-align:center; font-size:14px; color:#aaa;">生產力指數：${rate}%</div>
        </div>

        <div class="stats-card"><h2>📅 每小時工作量</h2><div id="h-l">${hourlyHtml}</div></div>
        <div class="stats-card"><h2>📋 今日提醒事項</h2><div id="t-l"></div></div>
        <div class="stats-card"><h2>📱 應用排行</h2><div id="a-l">${appsHtml}</div></div>
      </div>
      <script>
        function fmt(m){ if(!m)return '0分'; if(m<60)return m+'分'; return Math.floor(m/60)+'h '+(m%60)+'m'; }
        window.reminderAPI.onUpdateStats((d) => {
          document.getElementById('w-v').innerText = fmt(d.stats.work);
          document.getElementById('l-v').innerText = fmt(d.stats.leisure);
          document.getElementById('o-v').innerText = fmt(d.stats.other);
          const r = d.stats.total > 0 ? Math.round((d.stats.work/d.stats.total)*100) : 0;
          document.getElementById('p-f').style.width = r + '%';
          document.getElementById('p-t').innerText = '生產力指數：' + r + '%';

          if(r>=80) document.getElementById('m-s').innerText = "主人太強了！效率爆炸！🚀";
          else if(r>=50) document.getElementById('m-s').innerText = "工作順利，繼續保持喔！☕";
          else document.getElementById('m-s').innerText = "累了嗎？小秘書陪你休息一下！💪";
          
          let th = '';
          (d.localTasks || []).forEach(t => { th += '<div style="display:flex; justify-content:space-between; padding:8px; border-bottom:1px solid rgba(255,255,255,0.05);"><span>📌 '+t.title+'</span><button onclick="window.reminderAPI.updateLocalTask('+t.id+',\\'completed\\').then(()=>window.reminderAPI.refreshStats())">✅</button></div>'; });
          document.getElementById('t-l').innerHTML = th || '<div style="text-align:center; color:#555;">目前沒有待辦</div>';
        });
        function start(){ setTimeout(()=>window.reminderAPI.refreshStats(), 500); }
      </script>
    </body></html>`;
  }

  formatMinutes(m) { if (!m) return '0分'; if (m < 60) return m + '分'; return Math.floor(m / 60) + 'h ' + (m % 60) + 'm'; }
}

module.exports = { TrayManager };
