// v1.0 - 2026-02-14 16:00 (Asia/Taipei)
// 修改內容: 提醒視窗預載腳本（將 IPC 方法暴露給渲染端）

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('reminderAPI', {
    // 標記提醒為已完成
    complete: (reminderId) => ipcRenderer.invoke('reminder-complete', reminderId),
    // 稍後再提醒
    snooze: (reminderId) => ipcRenderer.invoke('reminder-snooze', reminderId),
    // 請求刷新統計視窗
    refreshStats: () => ipcRenderer.send('refresh-stats'),
    // 監聽數據更新 (用於消滅閃動的動態 DOM 更新)
    onUpdateStats: (callback) => ipcRenderer.on('update-stats-data', (event, data) => callback(data)),
    // 開啟連結帳號視窗
    openLinkWindow: () => ipcRenderer.invoke('open-link-window'),
    // 開啟整合主控台
    openDashboardWindow: () => ipcRenderer.invoke('open-dashboard-window'),
    // 個人待辦事項
    getLocalTasks: () => ipcRenderer.invoke('get-local-tasks'),
    addLocalTask: (title) => ipcRenderer.invoke('add-local-task', title),
    updateLocalTask: (id, status, title) => ipcRenderer.invoke('update-local-task', { id, status, title }),
    deleteLocalTask: (id) => ipcRenderer.invoke('delete-local-task', id),
    // 桌機直接打卡
    directCheckin: () => ipcRenderer.invoke('direct-checkin')
});
