const fetch = require('node-fetch');

const API_URL = 'https://script.google.com/macros/s/AKfycbw_OIxQW5OxiQ53v6z9mbJieJxacFmDtoz0PD753M4VmRJD7PYt-obGJW-1pnDOc2aZ/exec';

async function verifyHistoryApi() {
    console.log('Testing get_productivity_history API...');
    try {
        const startDate = '2026-02-01';
        const endDate = '2026-02-28';
        const url = `${API_URL}?action=get_productivity_history&startDate=${startDate}&endDate=${endDate}`;
        console.log(`URL: ${url}`);

        const response = await fetch(url);

        if (response.status !== 200) {
            console.error(`HTTP Status: ${response.status}`);
            const text = await response.text();
            console.error(`Response: ${text.substring(0, 200)}...`);
            return;
        }

        const data = await response.json();
        console.log('Parsed JSON:', JSON.stringify(data, null, 2));

        if (data.success) {
            console.log('History API Verification PASSED');
        } else {
            console.error('History API Verification FAILED:', data.message);
        }

    } catch (error) {
        console.error('API Verification ERROR:', error);
    }
}

verifyHistoryApi();
