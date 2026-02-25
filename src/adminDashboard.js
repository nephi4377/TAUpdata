const { BrowserWindow, ipcMain, screen } = require('electron');
const path = require('path');

class AdminDashboard {
    constructor(configManager, checkinService) {
        this.config = configManager;
        this.checkinService = checkinService;
        this.window = null;
    }

    show(skipLogin = false) {
        if (this.window && !this.window.isDestroyed()) {
            this.window.show();
            this.window.focus();
            if (skipLogin) {
                this.window.webContents.send('auto-login-success');
            }
            return;
        }

        this._createWindow(skipLogin);
    }

    _createWindow(skipLogin = false) {
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

        this._loadUI();

        if (skipLogin) {
            this.window.webContents.on('did-finish-load', () => {
                this.window.webContents.send('auto-login-success');
            });
        }
    }

    _loadUI() {
        const htmlContent = `
<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <title>管理員報表中心</title>
    <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
    <style>
        :root { --primary-color: #1890ff; --success-color: #52c41a; --warning-color: #faad14; --error-color: #ff4d4f; --bg-color: #f0f2f5; --card-bg: #ffffff; --text-main: #333333; --text-secondary: #666666; --border-color: #f0f0f0; }
        body { font-family: 'Segoe UI', 'Microsoft JhengHei', sans-serif; margin: 0; padding: 0; background-color: var(--bg-color); color: var(--text-main); }
        .container { padding: 24px; max-width: 1400px; margin: 0 auto; transition: opacity 0.3s; }
        .header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 24px; }
        .title { font-size: 28px; font-weight: 700; color: #1a1a1a; letter-spacing: -0.5px; }
        
        .controls { background: var(--card-bg); padding: 20px; border-radius: 12px; margin-bottom: 24px; display: flex; gap: 16px; align-items: center; box-shadow: 0 4px 12px rgba(0,0,0,0.05); }
        input[type="date"], input[type="text"] { padding: 8px 12px; border: 1px solid #d9d9d9; border-radius: 6px; outline: none; }
        
        .btn { padding: 10px 24px; background-color: var(--primary-color); color: white; border: none; border-radius: 6px; cursor: pointer; font-weight: 600; transition: 0.2s; }
        .btn:hover { background-color: #40a9ff; }
        .btn-outline { background-color: transparent; border: 1px solid #d9d9d9; color: var(--text-main); transition: 0.2s; font-weight: 500; cursor: pointer; border-radius: 6px; padding: 10px 20px; }
        .btn-outline:hover { border-color: var(--primary-color); color: var(--primary-color); }

        .summary-cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 24px; margin-bottom: 24px; }
        .card { background: var(--card-bg); padding: 20px; border-radius: 12px; box-shadow: 0 4px 12px rgba(0,0,0,0.05); position: relative; }
        .card h4 { margin: 0 0 8px 0; color: var(--text-secondary); font-size: 13px; }
        .card .value { font-size: 28px; font-weight: 700; color: var(--primary-color); }
        
        .chart-row { display: grid; grid-template-columns: 1fr 2fr; gap: 24px; margin-bottom: 24px; }
        .chart-box { background: var(--card-bg); padding: 24px; border-radius: 12px; box-shadow: 0 4px 12px rgba(0,0,0,0.05); min-height: 320px; }

        .table-container { background: var(--card-bg); border-radius: 12px; overflow: hidden; box-shadow: 0 4px 12px rgba(0,0,0,0.05); }
        table { width: 100%; border-collapse: collapse; }
        th { background-color: #fafafa; padding: 16px; text-align: left; font-weight: 600; color: var(--text-secondary); border-bottom: 2px solid var(--border-color); }
        td { padding: 16px; border-bottom: 1px solid var(--border-color); font-size: 14px; }
        tr:hover { background-color: #f0f7ff; cursor: pointer; }
        tr.selected { background-color: #e6f7ff; border-left: 4px solid var(--primary-color); }
        tr.anomaly-row { background-color: #fff1f0; }

        .tag { padding: 4px 8px; border-radius: 4px; font-size: 11px; font-weight: 600; margin-right: 4px; color: white; }
        .tag-danger { background: #ff4d4f; }
        .tag-warning { background: #faad14; }

        /* Modal Styles */
        #modal-overlay { position: fixed; top: 0; left: 0; right: 0; bottom: 0; background: rgba(0,0,0,0.5); backdrop-filter: blur(4px); display: none; justify-content: center; align-items: center; z-index: 2000; }
        .modal-box { background: white; border-radius: 16px; width: 640px; max-height: 80vh; overflow: hidden; display: flex; flex-direction: column; box-shadow: 0 20px 40px rgba(0,0,0,0.2); }
        .modal-header { padding: 20px; border-bottom: 1px solid #f0f0f0; display: flex; justify-content: space-between; align-items: center; background: #fafafa; }
        .modal-body { padding: 24px; overflow-y: auto; line-height: 1.8; white-space: pre-wrap; font-size: 15px; color: #444; }

        #login-overlay { position: fixed; top: 0; left: 0; right: 0; bottom: 0; background: rgba(255,255,255,0.9); backdrop-filter: blur(8px); display: flex; justify-content: center; align-items: center; z-index: 1000; }
        .login-box { background: white; padding: 40px; border-radius: 16px; width: 340px; box-shadow: 0 20px 40px rgba(0,0,0,0.1); text-align: center; }
        .login-box input { width: 100%; padding: 12px; margin: 16px 0; border: 1px solid #d9d9d9; border-radius: 8px; text-align: center; }
        .login-box button { width: 100%; padding: 12px; background: var(--primary-color); color: white; border: none; border-radius: 8px; font-size: 16px; cursor: pointer; }

        .text-danger { color: var(--error-color); font-weight: 600; }
        .text-success { color: var(--success-color); font-weight: 600; }
        .scrollbar::-webkit-scrollbar { width: 6px; }
        .scrollbar::-webkit-scrollbar-thumb { background: #d9d9d9; border-radius: 3px; }
    </style>
</head>
<body>
    <div id="login-overlay">
        <div class="login-box">
            <div style="font-size: 40px; margin-bottom: 12px;">🛡️</div>
            <h3>管理員登入</h3>
            <input type="password" id="password-input" placeholder="••••••••" onkeyup="if(event.key==='Enter') verifyPassword()">
            <button onclick="verifyPassword()">安全登入</button>
            <div id="login-msg" style="color: var(--error-color); margin-top: 16px;"></div>
        </div>
    </div>

    <div id="modal-overlay" onclick="closeModal()">
        <div class="modal-box" onclick="event.stopPropagation()">
            <div class="modal-header">
                <h3 id="modal-title" style="margin: 0;">詳細日誌內容</h3>
                <div style="cursor:pointer; font-size:24px; line-height:1" onclick="closeModal()">&times;</div>
            </div>
            <div class="modal-body" id="modal-content"></div>
            <div style="padding:16px; border-top:1px solid #f0f0f0; text-align:right">
                <button class="btn btn-outline" onclick="closeModal()">關閉視窗</button>
            </div>
        </div>
    </div>

    <div class="container" style="display: none; opacity: 0;" id="main-content">
        <div class="header">
            <div class="title">管理員報表中心 🚀</div>
            <div id="status-text" style="font-size: 13px; color: var(--text-secondary);">顯示當前篩選範圍內全部概觀</div>
        </div>

        <div class="controls">
            <input type="date" id="start-date">
            <span>至</span>
            <input type="date" id="end-date">
            <input type="text" id="history-filter" placeholder="搜尋姓名..." oninput="filterHistoryTable()">
            <button class="btn" onclick="loadHistory()">🔍 查詢報表</button>
            <button class="btn btn-outline" onclick="resetFocus()" style="margin-left:auto">🌍 顯示全部概觀</button>
        </div>

        <div class="summary-cards">
            <div class="card"><h4>總工時 (min)</h4><div class="value" id="val-work">0</div></div>
            <div class="card"><h4>總閒置 (min)</h4><div class="value" id="val-idle">0</div></div>
            <div class="card"><h4>平均生產力</h4><div class="value" id="val-prod">0%</div></div>
            <div class="card"><h4>紀錄天數</h4><div class="value" id="val-count">0</div></div>
        </div>

        <div class="chart-row">
            <div class="chart-box"><canvas id="chart-pie"></canvas></div>
            <div class="chart-box"><canvas id="chart-bar"></canvas></div>
        </div>

        <div class="table-container">
            <table>
                <thead>
                    <tr><th>日期</th><th>員工</th><th>工時</th><th>休閒</th><th>生產力</th><th>日誌細目 (點此放大)</th><th>標籤</th></tr>
                </thead>
                <tbody id="history-body"></tbody>
            </table>
        </div>
    </div>

    <script>
        const { ipcRenderer } = require('electron');
        let charts = {};
        let rawData = null;
        let selectedKey = null;

        function verifyPassword() {
            ipcRenderer.send('admin-login-verify', document.getElementById('password-input').value);
        }
        ipcRenderer.on('admin-login-result', (e, success) => {
            success ? handleLoginSuccess() : (document.getElementById('login-msg').innerText = '密碼錯誤');
        });
        ipcRenderer.on('auto-login-success', handleLoginSuccess);

        function handleLoginSuccess() {
            document.getElementById('login-overlay').style.display = 'none';
            const content = document.getElementById('main-content');
            content.style.display = 'block';
            setTimeout(() => content.style.opacity = '1', 50);
            initDefaults();
            loadHistory();
        }

        function initDefaults() {
            const today = new Date().toISOString().split('T')[0];
            document.getElementById('end-date').value = today;
            const weekAgo = new Date(); weekAgo.setDate(weekAgo.getDate() - 7);
            document.getElementById('start-date').value = weekAgo.toISOString().split('T')[0];
        }

        function loadHistory() {
            ipcRenderer.send('fetch-history-data', { 
                startDate: document.getElementById('start-date').value, 
                endDate: document.getElementById('end-date').value 
            });
        }

        ipcRenderer.on('history-data-result', (e, res) => {
            if (!res.success) return alert(res.message);
            rawData = res.data;
            resetFocus();
        });

        function resetFocus() {
            if (!rawData) return;
            selectedKey = null;
            document.querySelectorAll('#history-body tr').forEach(r => r.classList.remove('selected'));
            updateUI(rawData.summary, rawData.categoryStats, rawData.daily);
            document.getElementById('status-text').innerText = '顯示全部總計數據';
        }

        function focusRow(idx) {
            if (!rawData) return;
            const row = rawData.daily[idx];
            selectedKey = idx;
            document.querySelectorAll('#history-body tr').forEach((r, i) => {
                r.classList.toggle('selected', i === idx);
            });
            const focusedSummary = {
                totalWork: row.work,
                totalIdle: row.idle,
                avgProductivity: row.productivity,
                records: 1
            };
            const focusedCatStats = {
                work: row.work,
                idle: row.idle,
                leisure: row.leisure,
                other: row.other || 0
            };
            updateUI(focusedSummary, focusedCatStats, rawData.daily, true);
            document.getElementById('status-text').innerText = '正在查看 ' + row.userName + ' (' + row.date + ') 的單日產能焦點';
        }

        function updateUI(summary, catStats, daily, isFocused = false) {
            document.getElementById('val-work').innerText = Math.round(summary.totalWork);
            document.getElementById('val-idle').innerText = Math.round(summary.totalIdle);
            document.getElementById('val-prod').innerText = summary.avgProductivity + '%';
            document.getElementById('val-count').innerText = summary.records;
            renderCharts(catStats, daily);
            if (!isFocused) renderHistoryTable(daily);
        }

        function renderHistoryTable(data) {
            const tbody = document.getElementById('history-body');
            tbody.innerHTML = data.map((r, i) => {
                let tags = '';
                if (r.anomalies?.includes('low_score')) tags += '<span class="tag tag-danger">低生產力</span>';
                if (r.anomalies?.includes('high_leisure')) tags += '<span class="tag tag-warning">高休閒</span>';
                const isSelected = selectedKey === i;
                
                // [v1.8.4 FIX] 改用 encodeURIComponent 處理跳脫問題，並強制轉義單引號，避免 inline onClick 參數解析引發 Syntax Error
                const cleanDet = encodeURIComponent(r.detailText || '').replace(/'/g, "%27");

                let rowHtml = '<tr data-name="' + r.userName + '" class="' + (isSelected ? 'selected' : '') + ' ' + (r.anomalies?.length ? 'anomaly-row' : '') + '" onclick="focusRow(' + i + ')">';
                rowHtml += '<td>' + r.date + '</td>';
                rowHtml += '<td style="font-weight:600">' + r.userName + '</td>';
                rowHtml += '<td>' + r.work + '</td>';
                rowHtml += '<td>' + r.leisure + '</td>';
                rowHtml += '<td class="' + (r.productivity < 60 ? 'text-danger' : 'text-success') + '">' + r.productivity + '%</td>';
                rowHtml += '<td><div class="scrollbar" style="max-height:45px; overflow-y:auto; font-size:12px; cursor:zoom-in" onclick="event.stopPropagation(); showDetailModal(\'' + r.date + '\', \'' + r.userName + '\', decodeURIComponent(\'' + cleanDet + '\'))">';
                rowHtml += (r.detailText ? r.detailText.substring(0, 45).replace(/</g, "&lt;").replace(/>/g, "&gt;") + '...' : '點擊放大內容');
                rowHtml += '</div></td>';
                rowHtml += '<td>' + (tags || '-') + '</td>';
                rowHtml += '</tr>';
                return rowHtml;
            }).join('');
            filterHistoryTable();
        }

function filterHistoryTable() {
    const q = document.getElementById('history-filter').value.toLowerCase();
    document.querySelectorAll('#history-body tr').forEach(r => {
        const name = r.getAttribute('data-name') || '';
        r.style.display = name.toLowerCase().includes(q) ? '' : 'none';
    });
}

function renderCharts(catStats, daily) {
    if (charts.pie) charts.pie.destroy();
    if (charts.bar) charts.bar.destroy();
    charts.pie = new Chart(document.getElementById('chart-pie'), {
        type: 'doughnut',
        data: {
            labels: ['工作', '閒置', '休閒', '其他'],
            datasets: [{ data: [catStats.work, catStats.idle, catStats.leisure, catStats.other], backgroundColor: ['#52c41a', '#faad14', '#ff4d4f', '#8c8c8c'] }]
        },
        options: { maintainAspectRatio: false, plugins: { title: { display: true, text: '產能占比比例分析' } } }
    });
    charts.bar = new Chart(document.getElementById('chart-bar'), {
        type: 'bar',
        data: {
            labels: daily.map(x => x.date.split('-').slice(1).join('/')),
            datasets: [{ label: '工作時間', data: daily.map(x => x.work), backgroundColor: '#52c41a' }, { label: '閒置時間', data: daily.map(x => x.idle), backgroundColor: '#faad14' }]
        },
        options: { maintainAspectRatio: false, scales: { x: { stacked: true }, y: { stacked: true } }, plugins: { title: { display: true, text: '每日產能趨勢 (分)' } } }
    });
}

function showDetailModal(date, name, content) {
    document.getElementById('modal-title').innerText = name + ' - ' + date + ' 工作日誌詳情';
    document.getElementById('modal-content').innerText = content;
    document.getElementById('modal-overlay').style.display = 'flex';
}

function closeModal() { document.getElementById('modal-overlay').style.display = 'none'; }
    </script >
</body >
</html >
    `;
        this.window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(htmlContent)}`);
    }

    _stopAutoUpdate() { }
}

module.exports = { AdminDashboard };
