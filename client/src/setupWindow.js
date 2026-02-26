// v1.0 - 2026-02-14 14:20 (Asia/Taipei)
// 修改內容: 建立首次設定 / 切換使用者視窗

const { BrowserWindow, dialog } = require('electron');
const path = require('path');

class SetupWindow {
    constructor(configManager, checkinService) {
        this.config = configManager;
        this.checkinService = checkinService;
        this.window = null;
    }

    // 顯示設定視窗（首次設定或切換使用者）
    // mode: 'setup'（首次）| 'switch'（切換）
    async show(mode = 'setup') {
        // 如果是切換模式，先驗證密碼
        if (mode === 'switch') {
            const passwordValid = await this._promptPassword();
            if (!passwordValid) return null;
        }

        // 取得員工列表
        const employeeResult = await this.checkinService.getEmployeeList();
        if (!employeeResult.success) {
            dialog.showErrorBox('連線失敗', `無法取得員工列表：\n${employeeResult.message}\n\n請檢查網路連線後重試。`);
            return null;
        }

        const employees = employeeResult.data || [];
        if (employees.length === 0) {
            dialog.showErrorBox('無員工資料', '後端沒有員工資料，請先在 CheckinSystem 的「員工資料」工作表中新增員工。');
            return null;
        }

        // [v2.2.8.2] 確保只有權限 >= 2 的正式員工能出現在小助手中 (過濾廠商與離職)
        const activeEmployees = employees.filter(emp => {
            const perm = parseInt(emp.permission || 0);
            return emp.status !== '離職' && perm >= 2;
        });

        return new Promise((resolve) => {
            this.window = new BrowserWindow({
                width: 480,
                height: 580,
                resizable: false,
                minimizable: false,
                maximizable: false,
                alwaysOnTop: true,
                center: true,
                frame: false,
                transparent: false,
                backgroundColor: '#1e1e2e',
                webPreferences: {
                    nodeIntegration: false,
                    contextIsolation: false
                }
            });

            const htmlContent = this._generateHtml(activeEmployees, mode);
            this.window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(htmlContent)}`);

            // 處理從視窗傳回的選擇結果
            this.window.webContents.on('console-message', async (event, level, message) => {
                // 用 console.log 做簡易 IPC（避免額外設定 preload）
                if (message.startsWith('EMPLOYEE_SELECTED:')) {
                    const selectedData = JSON.parse(message.replace('EMPLOYEE_SELECTED:', ''));
                    console.log(`[SetupWindow] 使用者選擇: ${selectedData.userName}`);

                    // 綁定到後端
                    const bindResult = await this.checkinService.bindPcToEmployee(selectedData.userId);
                    if (bindResult.success) {
                        // 儲存到本地
                        this.config.bindEmployee(selectedData);
                        this.config.markFirstRunComplete();
                        console.log(`[SetupWindow] 綁定成功: ${selectedData.userName}`);
                    } else {
                        console.error(`[SetupWindow] 後端綁定失敗: ${bindResult.message}`);
                        // 即使後端綁定失敗，仍然先儲存本地（下次啟動會重試）
                        this.config.bindEmployee(selectedData);
                        this.config.markFirstRunComplete();
                    }

                    if (this.window && !this.window.isDestroyed()) {
                        this.window.close();
                    }
                    resolve(selectedData);
                } else if (message === 'SETUP_CANCELLED') {
                    console.log('[SetupWindow] 使用者取消設定');
                    if (this.window && !this.window.isDestroyed()) {
                        this.window.close();
                    }
                    resolve(null);
                }
            });

            this.window.on('closed', () => {
                this.window = null;
                resolve(null);
            });
        });
    }

    // 密碼驗證對話框
    async _promptPassword() {
        return new Promise((resolve) => {
            const passwordWindow = new BrowserWindow({
                width: 360,
                height: 220,
                resizable: false,
                minimizable: false,
                maximizable: false,
                alwaysOnTop: true,
                center: true,
                frame: false,
                transparent: false,
                backgroundColor: '#1e1e2e',
                webPreferences: {
                    nodeIntegration: false,
                    contextIsolation: false
                }
            });

            const html = `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
        font-family: 'Microsoft JhengHei', sans-serif;
        background: linear-gradient(135deg, #1e1e2e, #2d2d44);
        color: #e0e0e0;
        padding: 24px;
        user-select: none;
        -webkit-app-region: drag;
    }
    h3 { font-size: 16px; margin-bottom: 16px; color: #a0a0ff; }
    input {
        width: 100%;
        padding: 10px 14px;
        border: 1px solid #444;
        border-radius: 8px;
        background: #2a2a3e;
        color: #fff;
        font-size: 14px;
        outline: none;
        -webkit-app-region: no-drag;
    }
    input:focus { border-color: #6366f1; }
    .error { color: #f87171; font-size: 12px; margin-top: 6px; display: none; }
    .buttons {
        display: flex;
        gap: 10px;
        margin-top: 20px;
        -webkit-app-region: no-drag;
    }
    button {
        flex: 1;
        padding: 10px;
        border: none;
        border-radius: 8px;
        font-size: 14px;
        cursor: pointer;
        font-weight: 600;
    }
    .btn-confirm {
        background: linear-gradient(135deg, #6366f1, #8b5cf6);
        color: #fff;
    }
    .btn-confirm:hover { opacity: 0.9; }
    .btn-cancel {
        background: #3a3a4e;
        color: #aaa;
    }
    .btn-cancel:hover { background: #4a4a5e; }
</style>
</head>
<body>
    <h3>🔒 請輸入管理者密碼</h3>
    <input type="password" id="pwd" placeholder="請輸入密碼..." autofocus
           onkeyup="if(event.key==='Enter')verify()">
    <div class="error" id="err">密碼錯誤，請重試</div>
    <div class="buttons">
        <button class="btn-cancel" onclick="console.log('PWD_CANCEL')">取消</button>
        <button class="btn-confirm" onclick="verify()">確認</button>
    </div>
    <script>
        function verify() {
            const pwd = document.getElementById('pwd').value;
            console.log('PWD_CHECK:' + pwd);
        }
    </script>
</body>
</html>`;

            passwordWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);

            passwordWindow.webContents.on('console-message', (event, level, message) => {
                if (message.startsWith('PWD_CHECK:')) {
                    const inputPwd = message.replace('PWD_CHECK:', '');
                    if (this.config.verifyAdminPassword(inputPwd)) {
                        passwordWindow.close();
                        resolve(true);
                    } else {
                        // 顯示錯誤提示
                        passwordWindow.webContents.executeJavaScript(
                            'document.getElementById("err").style.display="block";document.getElementById("pwd").value="";document.getElementById("pwd").focus();'
                        );
                    }
                } else if (message === 'PWD_CANCEL') {
                    passwordWindow.close();
                    resolve(false);
                }
            });

            passwordWindow.on('closed', () => {
                resolve(false);
            });
        });
    }

    // 生成設定視窗的 HTML
    _generateHtml(employees, mode) {
        const title = mode === 'setup' ? '首次設定 - 選擇您的身份' : '切換使用者';
        const currentBound = this.config.getBoundEmployee();
        const currentInfo = currentBound ? `目前綁定：${currentBound.userName}` : '';

        // 按組別分組
        const groups = {};
        employees.forEach(emp => {
            const group = emp.group || '未分類';
            if (!groups[group]) groups[group] = [];
            groups[group].push(emp);
        });

        // 生成員工列表 HTML
        let employeeListHtml = '';
        for (const [groupName, emps] of Object.entries(groups)) {
            employeeListHtml += `<div class="group-label">${groupName}</div>`;
            emps.forEach(emp => {
                const isCurrentUser = currentBound && currentBound.userId === emp.userId;
                const badge = isCurrentUser ? '<span class="current-badge">目前</span>' : '';
                // [v2.2.8 Fix] 補上 permission 參數
                employeeListHtml += `
                    <div class="employee-item ${isCurrentUser ? 'current' : ''}" 
                         onclick="selectEmployee('${emp.userId}', '${emp.userName}', '${emp.shiftStart || ''}', '${emp.shiftEnd || ''}', ${emp.flexibleMinutes || 0}, '${emp.group || ''}', '${emp.permission || 0}')">
                        <div class="emp-info">
                            <span class="emp-name">${emp.userName}</span>
                            ${badge}
                        </div>
                        <span class="emp-shift">${emp.shiftStart || '?'} - ${emp.shiftEnd || '?'}</span>
                    </div>`;
            });
        }

        return `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
        font-family: 'Microsoft JhengHei', sans-serif;
        background: linear-gradient(135deg, #1e1e2e, #2d2d44);
        color: #e0e0e0;
        height: 100vh;
        display: flex;
        flex-direction: column;
        user-select: none;
    }
    .header {
        padding: 20px 24px 12px;
        -webkit-app-region: drag;
    }
    .header h2 {
        font-size: 18px;
        color: #a0a0ff;
        margin-bottom: 4px;
    }
    .header .subtitle {
        font-size: 12px;
        color: #888;
    }
    .current-info {
        padding: 0 24px;
        font-size: 12px;
        color: #fbbf24;
        margin-bottom: 8px;
    }
    .employee-list {
        flex: 1;
        overflow-y: auto;
        padding: 0 24px 12px;
    }
    .employee-list::-webkit-scrollbar { width: 6px; }
    .employee-list::-webkit-scrollbar-track { background: transparent; }
    .employee-list::-webkit-scrollbar-thumb { background: #444; border-radius: 3px; }
    .group-label {
        font-size: 11px;
        color: #6366f1;
        font-weight: 600;
        text-transform: uppercase;
        padding: 10px 0 4px;
        border-bottom: 1px solid #333;
        margin-bottom: 4px;
    }
    .employee-item {
        display: flex;
        justify-content: space-between;
        align-items: center;
        padding: 10px 12px;
        border-radius: 8px;
        cursor: pointer;
        transition: all 0.15s;
        -webkit-app-region: no-drag;
    }
    .employee-item:hover {
        background: rgba(99, 102, 241, 0.15);
    }
    .employee-item.selected {
        background: rgba(99, 102, 241, 0.25);
        border: 1px solid #6366f1;
    }
    .employee-item.current {
        border-left: 3px solid #fbbf24;
    }
    .emp-info { display: flex; align-items: center; gap: 8px; }
    .emp-name { font-size: 14px; font-weight: 500; }
    .emp-shift { font-size: 12px; color: #888; }
    .current-badge {
        font-size: 10px;
        background: #fbbf24;
        color: #1e1e2e;
        padding: 1px 6px;
        border-radius: 4px;
        font-weight: 600;
    }
    .footer {
        padding: 12px 24px 16px;
        border-top: 1px solid #333;
        display: flex;
        gap: 10px;
        -webkit-app-region: no-drag;
    }
    button {
        flex: 1;
        padding: 10px;
        border: none;
        border-radius: 8px;
        font-size: 14px;
        cursor: pointer;
        font-weight: 600;
        transition: all 0.15s;
    }
    .btn-confirm {
        background: linear-gradient(135deg, #6366f1, #8b5cf6);
        color: #fff;
    }
    .btn-confirm:hover { opacity: 0.9; }
    .btn-confirm:disabled {
        background: #3a3a4e;
        color: #666;
        cursor: not-allowed;
    }
    .btn-cancel {
        background: #3a3a4e;
        color: #aaa;
    }
    .btn-cancel:hover { background: #4a4a5e; }
</style>
</head>
<body>
    <div class="header">
        <h2>🏢 ${title}</h2>
        <div class="subtitle">添心室內裝修設計 - 生產力助手</div>
    </div>
    ${currentInfo ? `<div class="current-info">⚡ ${currentInfo}</div>` : ''}
    <div class="employee-list">
        ${employeeListHtml}
    </div>
    <div class="footer">
        <button class="btn-cancel" onclick="cancel()">取消</button>
        <button class="btn-confirm" id="confirmBtn" disabled onclick="confirm()">請選擇員工</button>
    </div>

    <script>
        let selectedEmployee = null;

        function selectEmployee(userId, userName, shiftStart, shiftEnd, flexibleMinutes, group, permission) {
            // 移除其他選中狀態
            document.querySelectorAll('.employee-item').forEach(el => el.classList.remove('selected'));
            // 標記當前選中
            event.currentTarget.classList.add('selected');
            
            selectedEmployee = { userId, userName, shiftStart, shiftEnd, flexibleMinutes, group, permission };
            
            const btn = document.getElementById('confirmBtn');
            btn.disabled = false;
            btn.textContent = '確認選擇：' + userName;
        }

        function confirm() {
            if (selectedEmployee) {
                console.log('EMPLOYEE_SELECTED:' + JSON.stringify(selectedEmployee));
            }
        }

        function cancel() {
            console.log('SETUP_CANCELLED');
        }
    </script>
</body>
</html>`;
    }
}

module.exports = { SetupWindow };
