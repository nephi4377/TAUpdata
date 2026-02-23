// v1.0 - 2026-02-23 15:15 (Asia/Taipei)
// 修改內容: 建立版本管理服務，統一處理基礎版本與補丁版本的判定，避免主程式硬編碼瑕疵

const { app } = require('electron');
const path = require('path');
const fs = require('fs');

class VersionService {
    /**
     * 取得當前有效的版本號 (基礎版本或補丁版本)
     */
    getEffectiveVersion() {
        const baseVersion = app.getVersion();
        try {
            const userDataPath = app.getPath('userData');
            const patchVersionFile = path.join(userDataPath, 'patch_version.json');

            if (fs.existsSync(patchVersionFile)) {
                const content = fs.readFileSync(patchVersionFile, 'utf8').trim();
                const data = JSON.parse(content);

                // 強制將 patch version 轉為字串並進行嚴格比對
                const patchVersion = data.version ? data.version.toString() : null;

                if (patchVersion && this.compareVersions(patchVersion, baseVersion) > 0) {
                    return patchVersion;
                }
            }
        } catch (e) {
            console.error('[Version] 讀取補丁版本失敗:', e.message);
        }
        return baseVersion;
    }

    /**
     * 取得主要包版本 (asar 內的版本)
     */
    getBaseVersion() {
        return app.getVersion();
    }

    /**
     * 比對版號 (v1, v2)
     * 回傳: 1 (v1 > v2), -1 (v1 < v2), 0 (相等)
     */
    compareVersions(v1, v2) {
        if (!v1) return -1;
        if (!v2) return 1;

        // 移除非數字前綴 (例如 v1.0.0 -> 1.0.0)
        const cleanV1 = v1.toString().replace(/^v/i, '');
        const cleanV2 = v2.toString().replace(/^v/i, '');

        const parts1 = cleanV1.split('.').map(part => parseInt(part, 10) || 0);
        const parts2 = cleanV2.split('.').map(part => parseInt(part, 10) || 0);

        const length = Math.max(parts1.length, parts2.length);
        for (let i = 0; i < length; i++) {
            const p1 = parts1[i] || 0;
            const p2 = parts2[i] || 0;
            if (p1 > p2) return 1;
            if (p1 < p2) return -1;
        }
        return 0;
    }
}

module.exports = {
    versionService: new VersionService()
};
