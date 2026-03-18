const https = require('https');

const options = {
    hostname: 'api.github.com',
    path: '/repos/nephi4377/TAUpdata/releases/latest',
    method: 'GET',
    headers: {
        'User-Agent': 'Tienxin-App-Debug'
    }
};

https.get(options, (res) => {
    let data = '';
    res.on('data', chunk => data += chunk);
    res.on('end', () => {
        console.log(data);
    });
}).on('error', (e) => {
    console.error(e);
});
