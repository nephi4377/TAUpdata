const https = require('https');
const { URL } = require('url');

// Hardcoded for verification
const API_URL = 'https://script.google.com/macros/s/AKfycbx0Yxm_9hWCAGJNyJDQK5uYMpwzmwYY623yG1cx4e_jeFwdFZWQNHREisjj7k54UDWd/exec';
console.log('Testing API URL:', API_URL);

async function testHistory(params, label) {
    return new Promise((resolve) => {
        const urlObj = new URL(API_URL);
        urlObj.searchParams.append('action', 'get_productivity_history');
        if (params.startDate) urlObj.searchParams.append('startDate', params.startDate);
        if (params.endDate) urlObj.searchParams.append('endDate', params.endDate);
        if (params.userId) urlObj.searchParams.append('userId', params.userId);

        console.log(`\n[${label}] Requesting...`);

        const doRequest = (url) => {
            https.get(url, (res) => {
                // Handle Redirects
                if (res.statusCode === 302 || res.statusCode === 301) {
                    console.log(`[${label}] Redirecting...`);
                    doRequest(res.headers.location);
                    return;
                }

                let data = '';
                res.on('data', chunk => data += chunk);
                res.on('end', () => {
                    try {
                        const json = JSON.parse(data);
                        if (json.success) {
                            console.log(`[${label}] Success! Records: ${json.data.summary.records}`);
                            console.log(`[${label}] Total Work: ${json.data.summary.totalWork}`);
                        } else {
                            console.log(`[${label}] Failed: ${json.message}`);
                        }
                        resolve(json);
                    } catch (e) {
                        console.log(`[${label}] Parse Error: ${data.substring(0, 100)}...`);
                        resolve(null);
                    }
                });
            }).on('error', e => {
                console.log(`[${label}] Network Error: ${e.message}`);
                resolve(null);
            });
        };

        doRequest(urlObj.toString());
    });
}

async function run() {
    // Test 1: No User ID (Mimics current Dashboard)
    await testHistory({
        startDate: '2026-02-10',
        endDate: '2026-02-17'
    }, 'No-UserID');

    // Test 2: Specific User ID (From user provided data)
    await testHistory({
        startDate: '2026-02-10',
        endDate: '2026-02-17',
        userId: 'Ud58333430513b7527106fa71d2e30151'
    }, 'With-UserID');
}

run();
