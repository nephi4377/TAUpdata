// v1.11.12 - 2026-02-26 20:41 (Asia/Taipei)
// 修改內容: 全動態渲染加固 (打卡/頭像/提醒)，路徑搜尋算法優化。

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
    this.updateInterval = null;
    this._registerIpcHandlers();
    console.log('[Tray] 托盤管理服務已建立');
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
        this.monitorService.showToast('打卡成功', res.message || '打卡紀錄已送出');
      }
      return res;
    });
  }

  async init() {
    this.tray = new Tray(this.createTrayIcon());
    this.tray.setToolTip('添心生產力助手');
    await this.updateMenu();
    this.updateInterval = setInterval(() => this.updateMenu(), 60000);
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

  getEffectiveVersion() { return versionService.getEffectiveVersion(); }

  async updateMenu() {
    if (!this.tray) return;
    const stats = await this.storageService.getTodayStats();
    const v = this.getEffectiveVersion();
    const currentGender = this.configManager.getMascotGender();

    const template = [
      { label: `添心生產力助手 v${v}`, enabled: false },
      { label: `今日工作: ${this.formatMinutes(stats.work)} (${stats.productivityRate || 0}%)`, enabled: false },
      { label: '📊 詳細統計 (歷史)', click: () => this.showStatsWindow(true) },
      { type: 'separator' }
    ];

    const bound = this.configManager.getBoundEmployee();
    template.push({ label: bound ? `👤 使用者: ${bound.userName}` : '⚠️ 未綁定員工', enabled: false });
    template.push({ type: 'separator' });

    // 性別與裝束
    template.push({
      label: `🎭 秘書形象: ${currentGender === 'male' ? '🤵 帥哥' : '👩 美女'}`,
      click: () => {
        this.configManager.setMascotGender(currentGender === 'male' ? 'female' : 'male');
        this.updateMenu();
        if (this.statsWindow) this.showStatsWindow(false);
      }
    });

    if (currentGender === 'female') {
      const skin = this.configManager.getMascotSkin();
      const sks = [{ id: 'default', n: '🏙️ 黑系' }, { id: 'blizzard', n: '❄️ 藍青' }, { id: 'thunder', n: '⚡ 品紅' }, { id: 'boulder', n: '⛰️ 純黃' }, { id: 'sacred', n: '🕊️ 白色' }, { id: 'prism', n: '✨ 棱光' }];
      template.push({
        label: `👕 裝束: ${sks.find(s => s.id === skin)?.n || '預設'}`,
        submenu: sks.map(s => ({ label: s.n, type: 'radio', checked: skin === s.id, click: () => { this.configManager.setMascotSkin(s.id); this.updateMenu(); if (this.statsWindow) this.showStatsWindow(false); } }))
      });
    }

    template.push({ type: 'separator' }, { label: '🔄 檢查更新', click: () => this.app.emit('check-for-updates-manual') });
    this.tray.setContextMenu(Menu.buildFromTemplate(template));
  }

  async getStatsData() {
    // 頭像路徑加固算法
    const gender = this.configManager.getMascotGender();
    const skin = this.configManager.getMascotSkin();
    let fname = 'secretary.png';
    if (gender === 'male') fname = 'secretary_male.png';
    else if (skin !== 'default') fname = `secretary_${skin}.png`;

    const searchPaths = [
      path.join(__dirname, '..', 'assets', fname),
      path.join(app.getAppPath(), 'assets', fname),
      path.join(app.getAppPath(), 'client', 'assets', fname),
      path.join(process.cwd(), 'client', 'assets', fname),
      path.join(process.cwd(), 'assets', fname)
    ];

    let b64 = '';
    for (const p of searchPaths) {
      if (fs.existsSync(p)) { b64 = `data:image/png;base64,${fs.readFileSync(p).toString('base64')}`; break; }
    }

    return {
      stats: await this.storageService.getTodayStats(),
      hourlyStats: await this.storageService.getHourlyStats(),
      topApps: await this.storageService.getRecentTopApps(1),
      status: this.monitorService.getStatus(),
      boundEmployee: this.configManager.getBoundEmployee(),
      workInfo: this.configManager.getTodayWorkInfo(),
      localTasks: await this.storageService.getLocalTasks(),
      version: this.getEffectiveVersion(),
      mascotBase64: b64
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
    const temp = path.join(this.app.getPath('userData'), 'stats_v12.html');
    fs.writeFileSync(temp, html, 'utf8');
    this.statsWindow = new BrowserWindow({
      width: 750, height: 900, title: '添心生產力助手 - 詳細統計',
      autoHideMenuBar: true,
      webPreferences: { contextIsolation: true, preload: path.join(__dirname, 'reminderPreload.js') }
    });
    this.statsWindow.loadFile(temp);
    this.statsWindow.on('closed', () => { this.statsWindow = null; });
  }

  async generateStatsHtml(data) {
    return `<!DOCTYPE html><html><head><meta charset="UTF-8"><style>
      body { background:#1a1a2e; color:#eee; font-family:sans-serif; padding:20px; }
      .container { max-width: 600px; margin: 0 auto; }
      .mascot-area { display: flex; align-items: center; justify-content: center; gap: 20px; margin-bottom: 25px; }
      #avatar { width: 120px; height: 180px; border-radius: 12px; border: 2px solid #4ecdc4; box-shadow: 0 4px 15px rgba(0,0,0,0.5); background-size: cover; background-position: center; animation: float 4s ease-in-out infinite; }
      #speech { background: white; color: #333; padding: 15px; border-radius: 12px; font-size: 14px; font-weight: bold; max-width: 250px; box-shadow: 0 4px 15px rgba(0,0,0,0.2); }
      @keyframes float { 0%, 100% { transform: translateY(0); } 50% { transform: translateY(-8px); } }
      .stats-card { background:rgba(255,255,255,0.08); border-radius:12px; padding:20px; margin-bottom:20px; }
      .complete-btn { padding:10px; border:none; border-radius:6px; cursor:pointer; font-weight:bold; color:white; width:100%; margin-top:10px; }
      .grid3 { display:grid; grid-template-columns:1fr 1fr 1fr; gap:10px; text-align:center; margin-top:10px; }
      .rem-row { display:flex; justify-content:space-between; padding:8px; border-bottom:1px solid rgba(255,255,255,0.05); }
    </style></head>
    <body onload="initUI()">
      <div class="container">
        <div class="mascot-area">
          <div id="avatar"></div>
          <div id="speech">載入中...</div>
        </div>
        <h1 style="text-align:center; color:#4ecdc4;">📊 今日生產力報告</h1>
        <p style="text-align:center; color:#888; font-size:12px;">v${data.version} (v12 Engine)</p>
        
        <div id="checkin-card" class="stats-card"></div>
        
        <div class="stats-card">
          <h2>⏱️ 時間統計</h2>
          <div class="grid3">
            <div style="background:#000; padding:10px; border-radius:8px;"><div id="work-v" style="font-size:20px; color:#4ecdc4;">--</div><div>工作</div></div>
            <div style="background:#000; padding:10px; border-radius:8px;"><div id="leis-v" style="font-size:20px; color:#f7768e;">--</div><div>休閒</div></div>
            <div style="background:#000; padding:10px; border-radius:8px;"><div id="othe-v" style="font-size:20px; color:#aaa;">--</div><div>其他</div></div>
          </div>
          <div style="height:12px; background:#333; border-radius:6px; margin:15px 0; overflow:hidden;"><div id="prod-f" style="height:100%; background:#4caf50; width:0%; transition:width 0.5s;"></div></div>
          <div id="prod-t" style="text-align:center;">生產力指數: --%</div>
        </div>

        <div class="stats-card">
          <h2>📋 提醒事項</h2>
          <div style="display:flex; gap:8px; margin-bottom:12px;"><input id="t-i" style="flex:1; padding:10px; background:#222; color:white; border:1px solid #444;" placeholder="輸入新提醒..."><button onclick="addTask()" style="background:#4caf50; border:none; color:white; padding:0 15px; border-radius:4px; cursor:pointer;">➕</button></div>
          <div id="t-l"></div>
        </div>

        <div class="stats-card"><h2>📱 應用排行</h2><div id="app-l"></div></div>
      </div>

      <script>
        function fmt(m) { if(!m) return '0分'; if(m<60) return m+'分'; return Math.floor(m/60)+'h '+(m%60)+'m'; }
        async function addTask() { const v = document.getElementById('t-i').value; if(v){ await window.reminderAPI.addLocalTask(v); window.reminderAPI.refreshStats(); document.getElementById('t-i').value=''; } }
        async function toggle(id, s) { await window.reminderAPI.updateLocalTask(id, s); window.reminderAPI.refreshStats(); }
        async function checkin() { const b=event.target; b.innerText='處理中...'; const r=await window.reminderAPI.directCheckin(); if(r.success) window.reminderAPI.refreshStats(); else alert(r.message); }

        function render(data) {
          // 1. 頭像影像
          if(data.mascotBase64) document.getElementById('avatar').style.backgroundImage = 'url("'+data.mascotBase64+'")';
          else document.getElementById('avatar').style.background = '#333';

          // 2. 對話
          const r = data.stats.total > 0 ? Math.round((data.stats.work/data.stats.total)*100) : 0;
          let m = "今天也要努力工作喔！✨";
          if(r >= 80) m = "太優秀了！今天的效率完美！🚀";
          else if(r >= 50) m = "穩定發揮，繼續保持！☕";
          else if(r > 0) m = "休息一下，喝口水再繼續吧？💪";
          document.getElementById('speech').innerText = m;

          // 3. 打卡資訊 (全動態)
          const b = data.boundEmployee;
          const w = data.workInfo;
          let ch = b ? '<h3>👤 ' + b.userName + '</h3>' : '<h3 style="color:#f7768e;">⚠️ 未連結帳號</h3>';
          if(b) ch += '<div style="display:flex; justify-content:space-between; margin:10px 0;"><span>上班: '+(w?.checkinTime||'--:--')+'</span><span>預計下班: '+(w?.expectedOffTime||'--:--')+'</span></div><button class="complete-btn" style="background:#4ecdc4; color:#1a1a2e;" onclick="checkin()">✅ 傳送打卡</button>';
          else ch += '<button class="complete-btn" style="background:#7aa2f7;" onclick="window.reminderAPI.openLinkWindow()">📲 立即前往綁定 (LINE)</button>';
          document.getElementById('checkin-card').innerHTML = ch;

          // 4. 時間統計
          document.getElementById('work-v').innerText = fmt(data.stats.work);
          document.getElementById('leis-v').innerText = fmt(data.stats.leisure);
          document.getElementById('othe-v').innerText = fmt(data.stats.other);
          document.getElementById('prod-f').style.width = r + '%';
          document.getElementById('prod-t').innerText = '生產力指數: ' + r + '%';

          // 5. 提醒清單
          let th = '';
          (data.localTasks || []).forEach(t => {
            const isC = t.status === 'completed';
            th += '<div class="rem-row" style="'+(isC?'opacity:0.4;':'')+'"><span>'+(isC?'✅':'📌')+' '+t.title+'</span><button onclick="toggle('+t.id+', \\''+(isC?'pending':'completed')+'\\')">'+(isC?'↪️':'OK')+'</button></div>';
          });
          document.getElementById('t-l').innerHTML = th || '<div style="text-align:center; color:#666;">尚無事項</div>';

          // 6. 應用清單
          let ah = '';
          (data.topApps || []).forEach(a => { ah += '<div class="rem-row"><span>'+a.app_name+'</span><span style="color:#4ecdc4;">'+fmt(Math.round(a.total_seconds/60))+'</span></div>'; });
          document.getElementById('app-l').innerHTML = ah;
        }

        function initUI() {
          window.reminderAPI.onUpdateStats((d) => render(d));
          // 主動請求一次資料
          setTimeout(() => { if(window.reminderAPI.refreshStats) window.reminderAPI.refreshStats(); }, 300);
        }
      </script>
    </body></html>`;
  }

  formatMinutes(m) { if (!m) return '0分'; if (m < 60) return m + '分'; return Math.floor(m / 60) + 'h ' + (m % 60) + 'm'; }
}

module.exports = { TrayManager };
