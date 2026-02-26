const { BrowserWindow, dialog } = require('electron');

class ClassificationWindow {
    constructor(classifierService) {
        this.classifierService = classifierService;
        this.window = null;
    }

    show() {
        if (this.window) {
            this.window.focus();
            return;
        }

        this.window = new BrowserWindow({
            width: 800,
            height: 700,
            resizable: true,
            minimizable: false,
            maximizable: false,
            title: '分類規則管理',
            autoHideMenuBar: true,
            webPreferences: {
                nodeIntegration: false,
                contextIsolation: false // 為了簡便使用 IPC (console.log pattern)
            }
        });

        const rules = this.classifierService.getRules();
        const htmlContent = this._generateHtml(rules);

        this.window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(htmlContent)}`);

        // IPC: console.log message handler
        this.window.webContents.on('console-message', (event, level, message) => {
            if (message.startsWith('SAVE_RULES:')) {
                try {
                    const jsonStr = message.replace('SAVE_RULES:', '');
                    const newRules = JSON.parse(jsonStr);

                    this.classifierService.updateCustomRules(newRules);

                    dialog.showMessageBox(this.window, {
                        type: 'info',
                        title: '儲存成功',
                        message: '分類規則已更新並儲存！',
                        buttons: ['確定']
                    });
                } catch (err) {
                    console.error('儲存規則失敗:', err);
                    dialog.showErrorBox('儲存失敗', '格式錯誤或無法寫入設定。');
                }
            }
        });

        this.window.on('closed', () => {
            this.window = null;
        });
    }

    _generateHtml(rules) {
        // 定義要顯示的分類群組
        const groups = [
            { key: 'work', label: '💼 工作相關應用程式' },
            { key: 'workWebKeywords', label: '🌐 工作相關網頁 (關鍵字)' },
            { key: 'games', label: '🎮 遊戲應用程式' },
            { key: 'gameKeywords', label: '🎮 遊戲網頁 (關鍵字)' },
            { key: 'videoKeywords', label: '🎬 影片網站 (關鍵字)' },
            { key: 'socialKeywords', label: '📱 社群網站 (關鍵字)' },
            { key: 'shoppingKeywords', label: '🛒 購物網站 (關鍵字)' },
            { key: 'music', label: '🎵 音樂播放器' },
            { key: 'musicKeywords', label: '🎵 音樂網站 (關鍵字)' }
        ];

        // 建置側邊欄 Tabs
        let tabsHtml = '';
        groups.forEach((group, index) => {
            const active = index === 0 ? 'active' : '';
            tabsHtml += `<div class="tab ${active}" onclick="switchTab('${group.key}')" id="tab-${group.key}">${group.label}</div>`;
        });

        // 建置內容區域
        let contentHtml = '';
        groups.forEach((group, index) => {
            const active = index === 0 ? 'active' : '';
            const list = rules[group.key] || [];

            let listHtml = '';
            for (const item of list) {
                listHtml += `
                <div class="keyword-item">
                    <input type="text" value="${this._escapeHtml(item)}">
                    <button class="btn-delete" onclick="this.parentElement.remove()">🗑️</button>
                </div>`;
            }

            contentHtml += `
                <div class="tab-content ${active}" id="content-${group.key}" data-key="${group.key}">
                    <div class="toolbar">
                        <h3>${group.label}</h3>
                        <button class="btn-add" onclick="addItem('${group.key}')">➕ 新增規則</button>
                    </div>
                    <div class="keyword-list" id="list-${group.key}">
                        ${listHtml}
                    </div>
                </div>
            `;
        });

        return `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
        font-family: 'Microsoft JhengHei', sans-serif;
        background: #1e1e2e;
        color: #e0e0e0;
        height: 100vh;
        display: flex;
        overflow: hidden;
    }
    .sidebar {
        width: 240px;
        background: #161625;
        border-right: 1px solid #333;
        overflow-y: auto;
        display: flex;
        flex-direction: column;
    }
    .tab {
        padding: 15px 20px;
        cursor: pointer;
        font-size: 13px;
        border-bottom: 1px solid #222;
        transition: background 0.2s;
        color: #aaa;
    }
    .tab:hover { background: #252535; color: #fff; }
    .tab.active { background: #303045; border-left: 3px solid #6366f1; color: #fff; font-weight: bold; }
    
    .main { flex: 1; display: flex; flex-direction: column; overflow: hidden; }
    .content-area { flex: 1; overflow-y: auto; padding: 20px; }
    .tab-content { display: none; }
    .tab-content.active { display: block; animation: fadeIn 0.3s; }
    
    @keyframes fadeIn { from { opacity: 0; } to { opacity: 1; } }

    .toolbar {
        display: flex;
        justify-content: space-between;
        align-items: center;
        margin-bottom: 20px;
        padding-bottom: 15px;
        border-bottom: 1px solid #333;
        position: sticky;
        top: 0;
        background: #1e1e2e;
        z-index: 10;
    }
    h3 { font-size: 18px; color: #a0a0ff; }
    
    .keyword-list { 
        display: grid; 
        grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); 
        gap: 12px; 
    }
    .keyword-item {
        background: #252535;
        padding: 8px 12px;
        border-radius: 6px;
        display: flex;
        gap: 10px;
        align-items: center;
        border: 1px solid transparent;
        transition: border-color 0.2s;
    }
    .keyword-item:focus-within {
        border-color: #6366f1;
        background: #2a2a3e;
    }
    input {
        flex: 1;
        background: transparent;
        border: none;
        color: #fff;
        padding: 6px;
        font-size: 14px;
        font-family: 'Microsoft JhengHei', sans-serif;
    }
    input:focus { outline: none; }
    
    .btn-delete {
        background: transparent;
        border: none;
        color: #666;
        cursor: pointer;
        font-size: 16px;
        padding: 4px;
        transition: color 0.2s;
        display: flex; align-items: center; justify-content: center;
    }
    .btn-delete:hover { color: #f87171; background: rgba(248,113,113,0.1); border-radius: 4px; }
    
    .btn-add {
        background: #4caf50;
        color: white;
        border: none;
        padding: 8px 16px;
        border-radius: 6px;
        cursor: pointer;
        font-size: 13px;
        font-weight: 600;
        box-shadow: 0 2px 4px rgba(0,0,0,0.2);
    }
    .btn-add:hover { background: #45a049; }

    .footer {
        padding: 15px 24px;
        border-top: 1px solid #333;
        background: #161625;
        display: flex;
        justify-content: flex-end;
        align-items: center;
        gap: 15px;
    }
    .hint { color: #666; font-size: 12px; margin-right: auto; }
    
    .btn-save {
        background: linear-gradient(135deg, #6366f1, #8b5cf6);
        color: white;
        border: none;
        padding: 10px 24px;
        border-radius: 6px;
        cursor: pointer;
        font-weight: bold;
        box-shadow: 0 4px 6px rgba(99,102,241,0.25);
        transition: all 0.2s;
    }
    .btn-save:hover { transform: translateY(-1px); box-shadow: 0 6px 8px rgba(99,102,241,0.3); }
    .btn-save:active { transform: translateY(0); }

    /* 捲軸樣式 */
    ::-webkit-scrollbar { width: 8px; }
    ::-webkit-scrollbar-track { background: #161625; }
    ::-webkit-scrollbar-thumb { background: #444; border-radius: 4px; }
    ::-webkit-scrollbar-thumb:hover { background: #555; }

</style>
</head>
<body>
    <div class="sidebar">
        ${tabsHtml}
    </div>
    <div class="main">
        <div class="content-area">
            ${contentHtml}
        </div>
        <div class="footer">
            <span class="hint">💡 記得點擊儲存，修改才會生效喔！</span>
            <button class="btn-save" onclick="save()">💾 儲存並套用</button>
        </div>
    </div>

    <script>
        function switchTab(key) {
            document.querySelectorAll('.tab').forEach(el => el.classList.remove('active'));
            document.querySelectorAll('.tab-content').forEach(el => el.classList.remove('active'));
            
            document.getElementById('tab-' + key).classList.add('active');
            document.getElementById('content-' + key).classList.add('active');
        }

        function addItem(key) {
            const listEl = document.getElementById('list-' + key);
            const div = document.createElement('div');
            div.className = 'keyword-item';
            div.innerHTML = \`
                <input type="text" placeholder="輸入關鍵字..." autofocus>
                <button class="btn-delete" onclick="this.parentElement.remove()">🗑️</button>
            \`;
            // 插入到最前面
            listEl.insertBefore(div, listEl.firstChild);
        }

        function save() {
            const newRules = {};
            const contents = document.querySelectorAll('.tab-content');
            
            contents.forEach(content => {
                const key = content.getAttribute('data-key');
                const inputs = content.querySelectorAll('input');
                const values = [];
                inputs.forEach(inp => {
                    const v = inp.value.trim();
                    if (v) values.push(v);
                });
                // 去除重複
                newRules[key] = [...new Set(values)];
            });

            console.log('SAVE_RULES:' + JSON.stringify(newRules));
        }
    </script>
</body>
</html>`;
    }

    _escapeHtml(text) {
        if (!text) return '';
        return text.replace(/"/g, '&quot;');
    }
}

module.exports = { ClassificationWindow };
