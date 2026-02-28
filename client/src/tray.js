// v1.11.17 - 2026-02-26 21:05 (Asia/Taipei)
// 修改內容: 還原所有功能、加入「開啟整合主控台」、修復打卡通訊、祕書裝束改為隨機、語氣專業化 (移除稱謂)。

const { Tray, Menu, nativeImage, Notification, app, BrowserWindow, shell, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const https = require('https');
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
      template.push({ label: `👤 ${bound.userName}`, enabled: false });
      // [還原] 快速打卡功能
      template.push({
        label: '✅ 快速打卡 (發送至 LINE)',
        click: async () => {
          if (!this.checkinService) return;
          const res = await this.checkinService.directCheckin(bound.userId, bound.userName);
          if (res && res.success) {
            new Notification({ title: '打卡成功', body: '已成功發送打卡訊號至 LINE 平台。' }).show();
            // 延遲刷新統計，讓後端有時間更新資料
            setTimeout(() => this.showStatsWindow(false), 2000);
          } else {
            new Notification({ title: '打卡失敗', body: res ? res.message : '通訊錯誤' }).show();
          }
        }
      });
      template.push({ type: 'separator' });
    }

    // [還原] 整合主控台連結
    template.push({ label: '🖥️ 開啟整合主控台', click: () => { shell.openExternal('https://info.tanxin.space/index.html'); } });

    // 管理員與設定
    if (this.configManager.isAdmin()) {
      template.push({ label: '⚙️ 管理員主控台', click: () => this.adminDashboard?.show() });
    }

    // 性別設定 (僅保留男女大項)
    template.push({
      label: `🎭 祕書性別: ${gender === 'male' ? '🤵 男版' : '👩 女版'}`,
      click: () => { this.configManager.setMascotGender(gender === 'male' ? 'female' : 'male'); this.updateMenu(); }
    });

    template.push({ type: 'separator' });
    template.push({ label: '👤 切換使用者 (重新綁定)', click: () => this.setupWindow('setup') });

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

    // [v1.11.18 Optimization] 並行獲取數據，且限制圖片快取等待時間
    const dataPromises = [
      this.storageService.getTodayStats(),
      this.storageService.getHourlyStats(),
      this.storageService.getRecentTopApps(1),
      this.storageService.getLocalTasks()
    ];

    // 圖片快取限制在 500ms 內完成，否則先用遠端 URL
    const mascotPromise = Promise.race([
      this.ensureMascotCached(fname),
      new Promise(resolve => setTimeout(() => resolve(null), 500))
    ]);

    const [stats, hourlyStats, topApps, localTasks, localPath] = await Promise.all([...dataPromises, mascotPromise]);
    const mascotPath = localPath ? `file://${localPath.replace(/\\/g, '/')}` : '';

    return {
      stats,
      hourlyStats,
      topApps,
      status: this.monitorService.getStatus(),
      boundEmployee: this.configManager.getBoundEmployee(),
      workInfo: this.configManager.getTodayWorkInfo(),
      localTasks,
      todayReminders: this.reminderService ? this.reminderService.getTodayReminderStatus() : [],
      hasIcloudUrl: !!this.configManager.get('icloudCalendarUrl'), // 新增連結判定
      version: versionService.getEffectiveVersion(),
      mascotUrl: mascotPath || `https://raw.githubusercontent.com/nephi4377/TAUpdata/master/client/assets/${fname}`
    };
  }

  async showStatsWindow(isManual = true) {
    const data = await this.getStatsData();

    // 如果視窗已存在
    if (this.statsWindow && !this.statsWindow.isDestroyed()) {
      this.statsWindow.webContents.send('update-stats-data', data);
      if (isManual) this.statsWindow.focus();
      return;
    }

    // 建立新視窗
    const html = await this.generateStatsHtml(data);
    const temp = path.join(this.app.getPath('userData'), 'stats_stable_v17.html');
    fs.writeFileSync(temp, html, 'utf8');

    this.statsWindow = new BrowserWindow({
      width: 720, height: 880, title: '添心生產力助手 - 詳細統計',
      autoHideMenuBar: true,
      show: false,
      webPreferences: { contextIsolation: true, preload: path.join(__dirname, 'reminderPreload.js') }
    });

    this.statsWindow.loadFile(temp);

    this.statsWindow.once('ready-to-show', () => {
      this.statsWindow.show();
      this.statsWindow.webContents.send('update-stats-data', data);
      this._startAutoRefresh(); // 啟動自動刷新
    });

    // [新增] 置頂/獲得焦點時自動更新
    this.statsWindow.on('focus', async () => {
      console.log('[Tray] 統計視窗獲得焦點，執行即時更新...');
      const latestData = await this.getStatsData();
      if (this.statsWindow && !this.statsWindow.isDestroyed()) {
        this.statsWindow.webContents.send('update-stats-data', latestData);
      }
    });

    // 視窗關閉時清理
    this.statsWindow.on('closed', () => {
      this._stopAutoRefresh();
      this.statsWindow = null;
    });
  }

  /**
   * 啟動 5 分鐘自動刷新計時器
   */
  _startAutoRefresh() {
    this._stopAutoRefresh(); // 確保不會重複建立
    this.refreshTimer = setInterval(async () => {
      if (this.statsWindow && !this.statsWindow.isDestroyed()) {
        console.log('[Tray] 執行 5 分鐘定時統計更新...');
        const data = await this.getStatsData();
        this.statsWindow.webContents.send('update-stats-data', data);
      } else {
        this._stopAutoRefresh();
      }
    }, 5 * 60 * 1000); // 5 分鐘
  }

  _stopAutoRefresh() {
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = null;
    }
  }

  async generateStatsHtml(data) {
    const { version, mascotUrl, stats, hourlyStats, topApps, boundEmployee, workInfo } = data;
    const rate = stats.total > 0 ? Math.round((stats.work / stats.total) * 100) : 0;

    // 準備按鈕區塊
    const checkinBtn = boundEmployee
      ? `<button class="btn ok" onclick="doCheckin()" id="checkin-btn">✅ 打卡發送</button>
         <button class="btn info" onclick="window.reminderAPI.openDashboardWindow()">🖥️ 主控台</button>`
      : `<button class="btn" style="background:#7aa2f7; width:100%;" onclick="window.reminderAPI.openLinkWindow()">📲 前往綁定 (LINE)</button>`;

    return `<!DOCTYPE html><html><head><meta charset="UTF-8"><style>
      * { margin:0; padding:0; box-sizing:border-box; font-family:sans-serif; }
      body { background:#1a1a2e; color:#eee; padding:20px; overflow-x:hidden; }
      .container { max-width: 600px; margin: 0 auto; }
      .mascot-area { display:flex; align-items:center; justify-content:center; gap:20px; margin-bottom:20px; padding:15px; background:rgba(255,255,255,0.05); border-radius:15px; }
      .avatar { width:100px; height:150px; border-radius:10px; background:url('${mascotUrl}') center/cover; border:2px solid #4ecdc4; animation: float 4s infinite ease-in-out; }
      .speech { background:white; color:#333; padding:12px; border-radius:10px; font-size:13px; font-weight:bold; max-width:250px; box-shadow:0 4px 15px rgba(0,0,0,0.2); position:relative; }
      .speech::after { content:''; position:absolute; left:-10px; top:20px; border-width:10px 10px 10px 0; border-style:solid; border-color:transparent white transparent transparent; }
      @keyframes float { 0%, 100% { transform:translateY(0); } 50% { transform:translateY(-6px); } }
      .card { background:rgba(255,255,255,0.08); border-radius:12px; padding:20px; margin-bottom:20px; box-shadow: 0 4px 20px rgba(0,0,0,0.2); }
      .btn { padding:12px; border:none; border-radius:8px; cursor:pointer; font-weight:bold; color:white; transition: all 0.2s; }
      .btn:active { transform: scale(0.95); opacity: 0.8; }
      .btn.ok { background:#4ecdc4; color:#1a1a2e; flex: 2; }
      .btn.info { background:#565f89; flex: 1; }
      .grid2 { display:grid; grid-template-columns:1fr 1fr; gap:10px; margin-top:10px; }
      .summary-grid { display:grid; grid-template-columns:1fr 1fr 1fr; gap:10px; text-align:center; }
      .summary-val { font-size:22px; font-weight:bold; color:#4ecdc4; }
      .hour-row { display:flex; align-items:center; margin-bottom:6px; font-size:11px; }
      .hour-bar-box { flex:1; height:8px; display:flex; background:rgba(255,255,255,0.05); margin:0 10px; border-radius:4px; overflow:hidden; }
      .bar.work { background:#4caf50; } .bar.leis { background:#f7768e; } .bar.othe { background:#999; }
      .app-row { display:flex; justify-content:space-between; padding:8px; border-bottom:1px solid rgba(255,255,255,0.05); font-size:13px; }
      .task-item { display:flex; justify-content:space-between; align-items:center; padding:10px; border-bottom:1px solid rgba(255,255,255,0.05); }
      .task-btn { background: #4ecdc4; border:none; color:#1a1a2e; width:28px; height:28px; border-radius:50%; cursor:pointer; font-weight:bold; }
    </style></head>
    <body>
      <div class="container">
        <div class="mascot-area">
          <div class="avatar"></div>
          <div class="speech" id="msg">正在下載最新行程...</div>
        </div>

        <div class="card">
          <h2 id="user-name-display">👤 正在加載...</h2>
          <div class="grid2" style="margin-bottom:15px;">
            <div>上班: <span id="ck-in">--:--</span></div>
            <div>下班: <span id="ck-out">--:--</span></div>
          </div>
          <div id="user-card-area"></div>
        </div>

        <div class="card" id="task-center-card" style="display:none;">
          <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:10px;">
            <h2>📋 提醒與待辦行程</h2>
            <div style="display:flex; gap:5px;">
               <button class="btn info" style="padding:4px 8px; font-size:11px;" onclick="showAddTask('emergency')">🚨 緊急</button>
               <button class="btn ok" style="padding:4px 8px; font-size:11px;" onclick="showAddTask('normal')">➕ 一般</button>
            </div>
          </div>
          <div id="t-l" style="min-height:100px;">正在下載最新行程...</div>
        </div>

        <script>
        async function showAddTask(mode = 'normal') {
          const title = prompt(mode === 'emergency' ? '🚨 請輸入緊急交辦內容：' : '➕ 請輸入交辦任務名稱：');
          if (!title) return;
          
          let deadline = 0;
          if (mode === 'normal') {
            const hasDead = confirm('需要設定「限時衝刺 (Sprint)」倒數嗎？');
            if (hasDead) {
              const mins = prompt('請輸入限時分鐘數 (例如: 30)：', '30');
              deadline = parseInt(mins) || 0;
            }
          }

          try {
            await window.reminderAPI.addLocalTask(
               title, 
               new Date().toISOString().split('T')[0], 
               null, // dueTime
               0,    // leadMinutes
               'none', // repeat
               deadline,
               mode
            );
            alert('✅ 交辦成功！小秘書會幫您盯著進度的。');
            window.reminderAPI.refreshStats();
          } catch(e) {
            alert('交辦失敗：' + e.message);
          }
        }
        </script>

        <div class="card">
          <h2>⏱️ 今日時間概覽</h2>
          <div class="summary-grid">
            <div style="background:#000; padding:10px; border-radius:8px;"><div id="w-v" class="summary-val">${this.formatMinutes(stats.work)}</div><div>工作</div></div>
            <div style="background:#000; padding:10px; border-radius:8px;"><div id="l-v" class="summary-val" style="color:#f7768e;">${this.formatMinutes(stats.leisure)}</div><div>休閒</div></div>
            <div style="background:#000; padding:10px; border-radius:8px;"><div id="o-v" class="summary-val" style="color:#aaa;">${this.formatMinutes(stats.other)}</div><div>其他</div></div>
          </div>
          <div style="height:12px; background:#333; border-radius:6px; margin:15px 0; overflow:hidden; border:1px solid #444;">
            <div id="p-f" style="height:100%; background:#4caf50; width:${rate}%; transition: width 0.5s;"></div>
          </div>
          <div id="p-t" style="text-align:center; font-size:13px; font-weight:bold;">當前生產力：${rate}%</div>
        </div>

        <div class="card">
          <h2>📅 每小時工作詳情</h2>
          <div id="h-l" style="margin-top:10px;">
            ${(hourlyStats || []).map(r => `
              <div class="hour-row">
                <span>${r.hour}:00</span>
                <div class="hour-bar-box">
                  <div class="bar work" style="width:${r.work_pct || 0}%"></div>
                  <div class="bar leis" style="width:${r.leisure_pct || 0}%"></div>
                  <div class="bar othe" style="width:${r.other_pct || 0}%"></div>
                </div>
                <span>${this.formatMinutes(r.total)}</span>
              </div>
            `).join('')}
          </div>
        </div>

        <div class="card">
          <h2>📋 提醒與待辦行程</h2>
          <div id="t-l" style="margin-top:10px;"></div>
        </div>

        <div class="card">
          <h2>📱 應用排行</h2>
          <div id="a-l">
            ${(topApps || []).map(a => `
              <div class="app-row">
                <span>${a.app_name}</span>
                <span style="color:#4ecdc4; font-weight:bold;">${this.formatMinutes(Math.round(a.total_seconds / 60))}</span>
              </div>
            `).join('')}
          </div>
        </div>
        
        <p style="text-align:center; color:#555; font-size:11px; margin-bottom:20px;">版本：v${version}</p>
      </div>

      <script>
        function fmt(m){ if(!m)return '0分'; if(m<60)return m+'分'; return Math.floor(m/60)+'h '+(m%60)+'m'; }
        
        // [不可變動] 打卡按鈕邏輯
        async function doCheckin(){
           if(!window.reminderAPI) return alert('系統組件加載中，請稍候...');
           const btn = document.getElementById('checkin-btn');
           if(btn) btn.disabled = true;
           try {
             const r = await window.reminderAPI.directCheckin();
             if(r.success) {
               window.reminderAPI.refreshStats();
             } else {
               alert('打卡失敗：' + r.message);
               if(btn) btn.disabled = false;
             }
           } catch(e) {
             alert('通訊錯誤：' + e.message);
             if(btn) btn.disabled = false;
           }
        }

        // [v4.0 專業交辦回饋]
        async function handleReportBlock(id) {
          const reason = prompt('🛠️ 請描述目前遇到的困難 (例如: 缺料、案場施工受阻)：');
          if (!reason) return;
          await window.reminderAPI.reportBlockReason(id, reason, 0);
          window.reminderAPI.refreshStats();
        }

        async function handleCompleteWithNote(id) {
          const note = prompt('✅ 請輸入完成心得或執行摘要 (選填)：', '順利完成');
          if (note === null) return;
          await window.reminderAPI.updateTaskResponse(id, note, 0);
          window.reminderAPI.refreshStats();
        }

        async function toggle(id, s){
          if(!window.reminderAPI) return;
          if (s === 'Completed') {
            return handleCompleteWithNote(id);
          }
          await window.reminderAPI.updateLocalTask({id, status: s});
          window.reminderAPI.refreshStats();
        }

        // [不可變動] 數據更新監聽
        if (window.reminderAPI && window.reminderAPI.onUpdateStats) {
          window.reminderAPI.onUpdateStats((d) => {
            console.log("收到數據更新:", d);
            updateUI(d);
          });
        }

        function updateUI(d) {
          // 更新使用者卡片
          const nameEl = document.getElementById('user-name-display');
          const areaEl = document.getElementById('user-card-area');
          if (d.boundEmployee) {
            nameEl.innerText = '👤 使用者: ' + d.boundEmployee.userName;
            areaEl.innerHTML = '<div style="display:flex; gap:10px; width:100%">' +
                '<button class="btn ok" onclick="doCheckin()" id="checkin-btn" style="flex:2">✅ 打卡發送</button>' +
                '<button class="btn info" onclick="window.reminderAPI.openDashboardWindow()" style="flex:1">🖥️ 主控台</button>' +
              '</div>';
          } else {
            nameEl.innerText = '⚠️ 未連結打卡帳號';
            areaEl.innerHTML = '<button class="btn" style="background:#7aa2f7; width:100%;" onclick="window.reminderAPI.openLinkWindow()">📲 前往綁定 (LINE)</button>';
          }

          if (d.workInfo) {
            if(document.getElementById('ck-in')) document.getElementById('ck-in').innerText = d.workInfo.checkinTime || '--:--';
            if(document.getElementById('ck-out')) document.getElementById('ck-out').innerText = d.workInfo.expectedOffTime || '--:--';
          }

          const r = d.stats.total > 0 ? Math.round((d.stats.work/d.stats.total)*100) : 0;
          document.getElementById('p-f').style.width = r + '%';
          document.getElementById('p-t').innerText = '當前生產力：' + r + '%';

          // 更新對話
          const quotes = [
            "今天的工作進行得如何呢？記得每小時起來拉伸一下喔！🏃‍♂️",
            "看到您這麼專注，我也得更努力幫您打點行程了！💪",
            "穩定發揮中！休息是為了走更長的路，來杯咖啡嗎？☕",
            "只要每天進步一點點，最後都會變成巨大的成就！✨",
            "今天的效率相當不錯喔，保持這個節奏！🚀",
            "累了嗎？閉上眼睛轉動一下眼球，保護好視力喔。👁️",
            "您專注工作的樣子最帥氣，加油！🔥",
            "別忘了多喝水，大腦水分充足會更有創意喔！💧",
            "目前進度穩定，放寬心，我們一項一項來完成。📅",
            "小提醒：您的健康是最高優先級，別太拼命了喔。❤️"
          ];

          const tasks = d.localTasks || [];
          const reminders = d.todayReminders || [];
          const pendingCount = tasks.filter(t => t.status !== 'completed').length + reminders.filter(r => r.status !== 'completed').length;
          
          let m = quotes[Math.floor(Math.random() * quotes.length)];
          const icloudEvents = reminders.filter(r => r.id && r.id.startsWith('icloud_') && r.status !== 'completed');
          const hasIcloud = reminders.some(r => r.id && r.id.startsWith('icloud_'));
          
          if (icloudEvents.length > 0) {
            m = "提醒您，等一下有個「" + icloudEvents[0].title + "」行程，我會幫您留意時間的！📅";
          } else if (pendingCount > 0) {
            m = "今天還有 " + pendingCount + " 項重要待辦行程，我會陪您一起達成！💪";
          } else if (r >= 85) {
            m = "您的專注力驚人！看來今天的進度會超標完成呢！🎖️";
          }
          
          document.getElementById('msg').innerText = m;

          // 更新提醒清單
          let th = '';
          const icloudStatusHtml = hasIcloud 
            ? '<span style="color:#22c55e; font-size:10px; font-weight:bold;">🟢 行事曆已同步</span>'
            : (d.hasIcloudUrl 
               ? '<span style="color:#f59e0b; font-size:10px; font-weight:bold;">🟡 正從 iCloud 同步...</span>'
               : '<span style="color:#ef4444; font-size:10px; font-weight:bold;">🔴 行事曆未連結 (請至手機 LIFF 設定)</span>');
            
          th += '<div style="padding: 5px 10px; border-bottom: 1px solid rgba(255,255,255,0.05); margin-bottom: 10px;">' + icloudStatusHtml + '</div>';

          if (reminders.length === 0 && tasks.length === 0) {
            th = '<div style="text-align:center; color:#666; padding:20px;">今日尚無待辦事項</div>';
          } else {
            reminders.forEach(r => {
                const isC = r.status === 'completed';
                const isI = r.id && r.id.startsWith('icloud_');
                th += '<div style="display:flex; justify-content:space-between; align-items:center; padding:10px; border-bottom:1px solid rgba(255,255,255,0.05); ' + (isC ? 'opacity:0.4;' : '') + '">' +
                    '<span style="' + (isI ? 'color:#4ecdc4; font-weight:bold;' : '') + '">' +
                        (isC ? '✅' : (isI ? '📅' : '⏰')) + ' ' + r.title +
                    '</span>' +
                    (!isC ? '<button class="task-btn" onclick="window.reminderAPI.complete(\'' + r.id + '\')">✓</button>' : '') +
                    '</div>';
            });
            
            tasks.forEach(t => { 
                const isC = t.status === 'Completed' || t.status === 'completed';
                const isB = t.status === 'Blocked';
                const pColor = t.priority_mode === 'emergency' ? '#ff6b6b' : (t.priority_mode === 'sprint' ? '#4ecdc4' : '#fff');
                
                th += '<div class="task-item" style="flex-direction:column; align-items:flex-start; ' + (isC ? 'opacity:0.4;' : '') + '">' +
                    '<div style="display:flex; justify-content:space-between; width:100%; align-items:center;">' +
                        '<span style="' + (t.priority_mode !== 'normal' ? 'font-weight:bold; color:'+pColor+';' : '') + '">' + 
                            (isC ? '✅' : (isB ? '🛠️' : (t.priority_mode === 'emergency' ? '🚨' : '📌'))) + ' ' + t.title + 
                        '</span>' +
                        '<div>' +
                            (!isC ? '<button class="task-btn" style="color:#f59e0b; margin-right:5px;" onclick="handleReportBlock(' + t.id + ')" title="回報困難">⚠️</button>' : '') +
                            '<button class="task-btn" onclick="toggle(' + t.id + ', \''+(isC ? 'pending' : 'Completed')+'\')">' + (isC ? '↺' : '✓') + '</button>' +
                        '</div>' +
                    '</div>';
                
                if (isB && t.block_reason) {
                    th += '<div style="font-size:10px; color:#f59e0b; margin-top:3px; padding-left:22px;">受阻：' + t.block_reason + '</div>';
                }
                if (isC && t.response_note) {
                    th += '<div style="font-size:10px; color:#999; margin-top:3px; padding-left:22px; font-style:italic;">' + t.response_note + '</div>';
                }
                
                th += '</div>';
            });
          }
          document.getElementById('t-l').innerHTML = th;
        }

        // 過場初始化
        window.onload = function() {
          // 增加 100ms 緩衝，確保 IPC 監聽器已由 Preload 腳本掛載完成
          setTimeout(() => {
            if (window.reminderAPI && window.reminderAPI.refreshStats) {
              window.reminderAPI.refreshStats({ isManual: false });
            }
          }, 100);
        };
      </script>
    </body></html>`;
  }

  formatMinutes(m) { if (!m) return '0分'; if (m < 60) return m + '分'; return Math.floor(m / 60) + 'h ' + (m % 60) + 'm'; }
}

module.exports = { TrayManager };
