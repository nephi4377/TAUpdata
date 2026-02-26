const { configManager } = require('./src/config');
const fetch = require('electron-fetch').default;

async function verifyHistory() {
    const url = configManager.getCheckinApiUrl();
    console.log('Target URL:', url);

    const params = new URLSearchParams({
        action: 'get_productivity_history',
        startDate: '2026-02-17',
        endDate: '2026-02-17'
        // No userId -> fetch all
    });

    try {
        const res = await fetch(`${url}?${params}`);
        const json = await res.json();

        if (json.success) {
            console.log('--- History Data (2026-02-17) ---');
            if (json.data.daily.length === 0) {
                console.log('No records found.');
            }
            json.data.daily.forEach(row => {
                console.log(`User: ${row.userName} (${row.userId})`);
                console.log(`  Work: ${row.work}m, Leisure: ${row.leisure}m, Prod: ${row.productivity}%`);
                console.log(`  Anomalies: ${row.anomalies.join(', ')}`);
            });
            console.log('----------------------------------');
            // Check for duplicates
            const users = json.data.daily.map(r => r.userId);
            const uniqueUsers = new Set(users);
            if (users.length !== uniqueUsers.size) {
                console.error('WARNING: Duplicate UserIDs found (Grouping failed?)');
            } else {
                console.log('Data Grouping: OK (No duplicates)');
            }
        } else {
            console.error('API Error:', json.message);
        }
    } catch (e) {
        console.error('Fetch Error:', e);
    }
}

verifyHistory();
