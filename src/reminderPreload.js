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
    onUpdateStats: (callback) => ipcRenderer.on('update-stats-data', (event, data) => callback(data))
});
