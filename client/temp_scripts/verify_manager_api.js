const fs = require('fs');
const path = require('path');
const https = require('https');
const { URL } = require('url');

// Read ID from backend folder
const idPath = 'c:\\Users\\a9999\\Dropbox\\CodeBackups\\backend\\CheckinSystem\\id.txt';
let DEPLOY_ID = 'AKfycbx0Yxm_9hWCAGJNyJDQK5uYMpwzmwYY623yG1cx4e_jeFwdFZWQNHREisjj7k54UDWd'; // Default fallback
try {
    DEPLOY_ID = fs.readFileSync(idPath, 'utf8').trim();
    console.log('Using Deployment ID:', DEPLOY_ID);
} catch (e) {
    console.warn('Could not read id.txt, using fallback.');
}

const API_URL = `https://script.google.com/macros/s/${DEPLOY_ID}/exec`;

function request(action, params = {}) {
    return new Promise((resolve) => {
        const urlObj = new URL(API_URL);
        urlObj.searchParams.append('action', action);
        // Clean params
        for (const key in params) {
            if (params[key] !== undefined && params[key] !== null) {
                urlObj.searchParams.append(key, params[key]);
            }
        }

        console.log(`\n[${action}] Requesting...`);

        const doRequest = (url) => {
            https.get(url, (res) => {
                if (res.statusCode === 302 || res.statusCode === 301) {
                    // console.log(`[${action}] Redirecting...`);
                    doRequest(res.headers.location);
                    return;
                }
                let data = '';
                res.on('data', chunk => data += chunk);
                res.on('end', () => {
                    try {
                        const json = JSON.parse(data);
                        resolve(json);
                    } catch (e) {
                        console.log(`[${action}] Parse Error: ${data.substring(0, 100)}...`);
                        resolve({ success: false, message: 'Parse Error' });
                    }
                });
            }).on('error', e => {
                console.log(`[${action}] Network Error: ${e.message}`);
                resolve({ success: false, message: e.message });
            });
        };
        doRequest(urlObj.toString());
    });
}

async function run() {
    // 1. Test Team Status (Should list ALL employees)
    const team = await request('get_team_status');
    console.log('[TeamStatus] Full Response:', JSON.stringify(team, null, 2));

    if (team.success) {
        console.log(`[TeamStatus] Count: ${team.data.length}`);
        const offline = team.data.filter(u => u.status === 'offline');
        const leave = team.data.filter(u => u.status === 'leave');
        console.log(`[TeamStatus] Offline: ${offline.length}, Leave: ${leave.length}`);
        if (team.data.length > 0) {
            console.log('[TeamStatus] Sample User:', JSON.stringify(team.data[0]));
        }
    } else {
        console.error('[TeamStatus] Failed:', team.message);
    }

    // 2. Test History (Check Formula & Anomalies)
    const history = await request('get_productivity_history', {
        startDate: '2026-02-17',
        endDate: '2026-02-17'
    });

    if (history.success) {
        const d = history.data;
        console.log(`[History] Records: ${d.daily.length}`);
        if (d.daily.length > 0) {
            const r = d.daily[0];
            console.log(`[History] Sample Record:`);
            console.log(`  Date: ${r.date}`);
            console.log(`  Work: ${r.work}, Idle: ${r.idle}, Leisure: ${r.leisure}, Other: ${r.other}`);
            console.log(`  Productivity: ${r.productivity}%`);

            // Validate Formula: (Work+Other) / (Work+Other+Leisure)
            const effective = r.work; // Backend v2 logic: effective = work + other (already summed? or raw?)
            // Wait, logic says: effectiveWork = work + other.
            // Let's verify if 'work' in response meant 'effectiveWork' or raw 'work'.
            // Checking logic: dailyMap.set(..., work: effectiveWork ...) -> So 'work' IS effective.

            const totalActive = r.work + r.leisure; // Since 'work' includes 'other'
            const calcProd = totalActive > 0 ? Math.round((r.work / totalActive) * 100) : 0;
            console.log(`  Calc Check: ${calcProd}% (Should match ${r.productivity})`);

            console.log(`  Anomalies: ${JSON.stringify(r.anomalies)}`);
        }
    } else {
        console.error('[History] Failed:', history.message);
    }
}

run();
