const fs = require('fs');
const path = require('path');

const idPath = 'c:\\Users\\a9999\\Dropbox\\CodeBackups\\backend\\CheckinSystem\\id_v2.1.txt';
const configPath = 'c:\\Users\\a9999\\Dropbox\\CodeBackups\\添心生產力助手\\client\\src\\config.js';

try {
    const validId = fs.readFileSync(idPath, 'utf8').trim();
    console.log('Valid ID (from file):', validId);

    const configContent = fs.readFileSync(configPath, 'utf8');
    const match = configContent.match(/const CHECKIN_API_URL = 'https:\/\/script\.google\.com\/macros\/s\/([^/]+)\/exec';/);

    if (!match) {
        console.log('Config API URL not found or format mismatch.');
    } else {
        const configId = match[1];
        console.log('Config ID (in file):', configId);

        if (validId === configId) {
            console.log('MATCH: True. Config is correct.');
        } else {
            console.log('MATCH: False. IDs differ.');
            // Compare character by character
            for (let i = 0; i < Math.max(validId.length, configId.length); i++) {
                if (validId[i] !== configId[i]) {
                    console.log(`Difference at index ${i}: Valid='${validId[i]}' vs Config='${configId[i]}'`);
                    break;
                }
            }
        }
    }

} catch (e) {
    console.error(e);
}
