/**
 * =============================================================================
 * 檔案名稱: taskCenterService.js
 * 專案名稱: 添心行動交辦中心 (Task-Center API) v5.0
 * 說明: 統一的任務管理 API。負責處理本地任務邏輯與後端 (GAS) 之非同步同步。
 * =============================================================================
 */

const axios = require('axios');

class TaskCenterService {
    constructor(storage, config) {
        this.db = storage.db;
        this.storage = storage;
        this.config = config;
        this.syncQueue = [];
    }

    /**
     * 發起新任務
     */
    async createTask(data) {
        const { title, deadline, priority = 'normal' } = data;
        return await this.storage.addLocalTask(
            title,
            new Date().toISOString().split('T')[0],
            null, 0, 'none',
            deadline || 0,
            priority
        );
    }

    /**
     * 回報困難 (Blocked)
     */
    async reportBlocked(taskId, reason, duration = 0) {
        console.log(`[TaskCenter] 任務受阻: ${taskId}, 原因: ${reason}`);

        // 1. 本地更新
        await this.db.run(
            `UPDATE local_tasks SET status = 'Blocked', block_reason = ?, actual_duration = actual_duration + ?, is_synced = 0 WHERE id = ?`,
            [reason, duration, taskId]
        );

        // 2. 觸發背景同步 (Fire and forget)
        this.sync();
    }

    /**
     * 完成任務 (Completed)
     */
    async completeTask(taskId, note = '', duration = 0) {
        console.log(`[TaskCenter] 任務完成: ${taskId}`);

        // 1. 本地更新
        await this.db.run(
            `UPDATE local_tasks SET status = 'Completed', response_note = ?, actual_duration = actual_duration + ?, is_synced = 0 WHERE id = ?`,
            [note, duration, taskId]
        );

        // 2. 觸發背景同步
        this.sync();
    }

    /**
     * 核心同步邏輯 (方案 A: JSON 封裝)
     */
    async sync() {
        const tasks = await this.storage.getLocalTasks();
        const pending = tasks.filter(t => (t.status === 'Completed' || t.status === 'Blocked' || t.status === 'completed') && !t.is_synced);

        if (pending.length === 0) return;

        const apiUrl = this.config.getCheckinApiUrl();
        const bound = this.config.getBoundEmployee();

        for (const task of pending) {
            // [方案 A] 封裝資料入 ActionPayload
            const payloadData = {
                blockReason: task.block_reason || "",
                responseNote: task.response_note || "",
                duration: task.actual_duration || 0,
                clientVersion: "v5.0"
            };

            const body = {
                action: 'syncTaskUpdate',
                NotificationID: task.id, // 對應 Sheet 的 NotificationID
                userId: bound?.userId,
                userName: bound?.userName,
                Status: task.status,
                ActionPayload: JSON.stringify(payloadData),
                Timestamp: new Date().toISOString()
            };

            axios.post(apiUrl, body)
                .then(() => {
                    this.db.run(`UPDATE local_tasks SET is_synced = 1 WHERE id = ?`, [task.id]);
                    console.log(`[TaskCenter] 任務 ${task.id} 雲端同步成功 (已封裝 ActionPayload)`);
                })
                .catch(e => console.error(`[TaskCenter] 同步失敗: ${e.message}`));
        }
    }
}

module.exports = { TaskCenterService };
