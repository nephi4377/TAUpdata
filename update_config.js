const fs = require('fs');
const path = require('path');
const configPath = 'C:\\Users\\a9999\\AppData\\Roaming\\tienxin-productivity-assistant\\tienxin-productivity-config.json';
const url = 'https://p52-caldav.icloud.com/published/2/MTM3ODUzOTcxODEzNzg1MxlJYrZiTNUahbeWTuVjJ4-_4RYG-qsSNnxt1_4QT8h4';

try {
    let config = {};
    if (fs.existsSync(configPath)) {
        const data = fs.readFileSync(configPath, 'utf8');
        if (data.trim()) {
            config = JSON.parse(data);
        }
    }
    config.icloudCalendarUrl = url;
    fs.writeFileSync(configPath, JSON.stringify(config, null, 4), 'utf8');
    console.log('---SUCCESS---');
} catch (err) {
    console.error(err);
}
