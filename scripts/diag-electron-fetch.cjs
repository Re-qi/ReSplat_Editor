// Diagnose /api/read-file from a REAL Electron renderer (app://bundle origin),
// replicating main.cjs's app:// protocol + embedded Express server.
const { app, BrowserWindow, protocol } = require('electron');
const path = require('path');
const { net } = require('electron');

const APP_MIME_TYPES = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8'
};

protocol.registerSchemesAsPrivileged([
    { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, allowServiceWorkers: true } }
]);

function registerAppProtocol() {
    const distPath = path.join(__dirname, '..', 'dist');
    protocol.handle('app', async (request) => {
        const url = new URL(request.url);
        const filePath = decodeURIComponent(url.pathname).slice(1);
        const resolved = path.normalize(path.join(distPath, filePath));
        if (resolved !== distPath && !resolved.startsWith(distPath + path.sep)) {
            return new Response('Forbidden', { status: 403 });
        }
        try {
            const fileUrl = 'file://' + resolved.replace(/\\/g, '/');
            const response = await net.fetch(fileUrl);
            const ext = path.extname(resolved).toLowerCase();
            const mimeType = APP_MIME_TYPES[ext];
            if (mimeType) {
                const headers = new Headers(response.headers);
                headers.set('Content-Type', mimeType);
                return new Response(response.body, { status: response.status, headers });
            }
            return response;
        } catch (err) {
            return new Response('Not Found', { status: 404 });
        }
    });
}

const { app: expressApp, PORT } = require('../server.js');

app.whenReady().then(async () => {
    registerAppProtocol();
    await new Promise((resolve, reject) => {
        const srv = expressApp.listen(PORT, () => resolve(srv));
        srv.on('error', reject);
    });
    const win = new BrowserWindow({
        show: false,
        webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: false }
    });
    await win.loadURL('app://bundle/index.html');
    await new Promise(r => setTimeout(r, 1500));

    const dir = 'D:/CodeProjects/ReSplat/数据/LCC/MoShiGongYuan/render/';
    const url = `http://localhost:${PORT}/api/read-file?path=${encodeURIComponent(dir + 'data.bin')}`;
    console.log('origin:', await win.webContents.executeJavaScript('location.origin'));
    const probe = await win.webContents.executeJavaScript(`
        fetch(${JSON.stringify(url)}, { headers: { Range: 'bytes=0-15' } })
            .then(r => ({ ok: r.ok, status: r.status, cr: r.headers.get('content-range'), len: r.headers.get('content-length') }))
            .catch(e => ({ err: String(e) }))
    `);
    console.log('probe fetch result:', JSON.stringify(probe));

    // Full readLccSource path: read meta + index locally, data/shcoef via URL
    const load = await win.webContents.executeJavaScript(`
        (async () => {
            try {
                const st = window.__SPLAT_TEST__;
                return { note: 'module import not exposed', err: null };
            } catch (e) { return { err: String(e) }; }
        })()
    `);
    console.log('load:', JSON.stringify(load));

    app.quit();
}).catch((err) => {
    console.error('DIAG FAILED:', err);
    app.exit(1);
});
