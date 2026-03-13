/**
 * monitor_off.js - 存放 monitor.js 中被隱藏或暫不使用的 UI 渲染片段
 * 用途：保持主程式碼整潔，若日後需重啟功能可從此處取出。
 */

const hiddenStatsHtml = `
    <!-- 數據與進度條 區塊 -->
    <div style="display:none; grid-template-columns:1fr 1fr 1fr; gap:8px; text-align:center;">
        <div style="background:#fdfcf9; padding:8px; border-radius:8px; border:1px solid #f9f7f2;"><div style="font-size:18px; font-weight:800;" id="stat-work">\${workTime}</div><div style="font-size:11px; color:#888;">工作</div></div>
        <div style="background:#fdfcf9; padding:8px; border-radius:8px; border:1px solid #f9f7f2;"><div style="font-size:18px; font-weight:800; color:#e91e63;" id="stat-leisure">\${leisureTime}</div><div style="font-size:11px; color:#888;">休閒</div></div>
        <div style="background:#fdfcf9; padding:8px; border-radius:8px; border:1px solid #f9f7f2;"><div style="font-size:18px; font-weight:800; color:#795548;" id="stat-other">\${otherTime}</div><div style="font-size:11px; color:#888;">其他</div></div>
    </div>
    
    <!-- 進度條 區塊 -->
    <div style="height:10px; background:#f0ede8; border-radius:5px; overflow:hidden; display:none;">
        <div id="p-f" style="width:\${rate}%; height:100%; background:linear-gradient(to right, #e67e22, #ffa726);"></div>
    </div>
`;

const hiddenDebugBoxHtml = `
    <!-- Debug 訊息盒 -->
    <div id="debug-box" style="display:none; background:#000; color:#0f0; padding:10px; font-family:monospace; font-size:10px; border-radius:8px; margin-bottom:10px;"></div>
`;

const hiddenAppRankingHtml = `
    <!-- 應用活躍排行 區塊 -->
    <div class="card" style="display:none;">
        <h2>📈 應用活躍排行</h2>
        <div id="app-ranking">\${appRankingHtml}</div>
    </div>
`;

module.exports = { hiddenStatsHtml, hiddenDebugBoxHtml, hiddenAppRankingHtml };
