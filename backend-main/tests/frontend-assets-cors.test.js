import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { mountFrontendAssets } from '../src/middlewares/frontend-assets.middleware.js';

process.env.CORS_ORIGINS = 'https://cp.shopshealth.com';
process.env.AUTH_SECRET = 'isolated-public-asset-cors-tests';
const { corsConfig, safeOriginLabel } = await import('../src/config/cors.config.js');
const temp = mkdtempSync(path.join(os.tmpdir(), 'jarvis-public-assets-'));
mkdirSync(path.join(temp, 'assets'));
writeFileSync(path.join(temp, 'assets', 'bundle.js'), 'export const loaded = true;');
writeFileSync(path.join(temp, 'assets', 'bundle.css'), 'body{color:blue}');
writeFileSync(path.join(temp, 'assets', '.private'), 'not public');
writeFileSync(path.join(temp, 'outside.txt'), 'not public');
let server, base, writes = 0;
before(async () => {
    const app = express();
    app.use(helmet());
    mountFrontendAssets(app, temp);
    app.use(cors(corsConfig));
    app.get('/api/private', (_req, res) => res.status(401).json({ message: 'Login required' }));
    app.post('/api/write', (_req, res) => { writes++; res.sendStatus(200); });
    app.get('*', (_req, res) => res.type('html').send('<div id="root"></div>'));
    app.use((err, _req, res, _next) => res.status(err.statusCode || 500).json({ message: err.message }));
    server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    base = 'http://127.0.0.1:' + server.address().port;
});
after(async () => {
    await new Promise(resolve => server.close(resolve));
    rmSync(temp, { recursive: true });
});

test('public JS and CSS load for same, foreign, opaque and absent Origin without credentials', async () => {
    for (const origin of [undefined, 'https://cp.shopshealth.com', 'https://preview.example', 'null']) {
        for (const file of ['bundle.js', 'bundle.css']) {
            const response = await fetch(base + '/assets/' + file, { headers: origin ? { Origin: origin } : {} });
            assert.equal(response.status, 200);
            assert.equal(response.headers.get('access-control-allow-origin'), '*');
            assert.equal(response.headers.get('access-control-allow-credentials'), null);
            assert.equal(response.headers.get('cross-origin-resource-policy'), 'cross-origin');
            assert.ok(response.headers.get('content-security-policy'));
            assert.equal(await response.text(), file.endsWith('.js') ? 'export const loaded = true;' : 'body{color:blue}');
        }
    }
});
test('public HEAD and preflight requests stay read-only', async () => {
    const response = await fetch(base + '/assets/bundle.js', { method: 'HEAD', headers: { Origin: 'null' } });
    assert.equal(response.status, 200); assert.equal(await response.text(), '');
    const options = await fetch(base + '/assets/bundle.js', { method: 'OPTIONS', headers: { Origin: 'null', 'Access-Control-Request-Method': 'GET' } });
    assert.equal(options.status, 204);
    assert.equal(options.headers.get('access-control-allow-methods'), 'GET,HEAD');
    assert.equal(options.headers.get('access-control-allow-credentials'), null);
});
test('missing, dotfile and traversal asset requests never return SPA or private content', async () => {
    for (const suffix of ['missing.js', '.private', '..%2foutside.txt', '%2e%2e%2foutside.txt']) {
        const response = await fetch(base + '/assets/' + suffix, { headers: { Origin: 'null' } });
        assert.ok([403, 404].includes(response.status), suffix + ': ' + response.status);
        const body = await response.text(); assert.equal(body, 'Asset not found');
        assert.ok(!body.includes(temp)); assert.ok(!body.includes('id="root"'));
    }
});
test('foreign and opaque API requests fail with 403 before handlers can change anything', async () => {
    for (const origin of ['https://preview.example', 'null']) {
        for (const [route, method] of [['/api/private', 'GET'], ['/api/write', 'POST'], ['/assets/bundle.js', 'POST']]) {
            const response = await fetch(base + route, { method, headers: { Origin: origin } });
            assert.equal(response.status, 403);
            assert.equal(response.headers.get('access-control-allow-origin'), null);
            assert.match((await response.json()).message, /CORS origin not allowed/);
        }
    }
    assert.equal(writes, 0);
});
test('allowed API retains credentialed CORS and login requirement', async () => {
    for (const origin of [undefined, 'https://cp.shopshealth.com']) {
        const response = await fetch(base + '/api/private', { headers: origin ? { Origin: origin } : {} });
        assert.equal(response.status, 401);
        assert.equal(response.headers.get('access-control-allow-credentials'), 'true');
        if (origin) assert.equal(response.headers.get('access-control-allow-origin'), origin);
        assert.equal(response.headers.get('cross-origin-resource-policy'), 'same-origin');
    }
    for (const origin of ['https://cp.shopshealth.com', 'null']) {
        const response = await fetch(base + '/api/write', { method: 'OPTIONS', headers: { Origin: origin, 'Access-Control-Request-Method': 'POST' } });
        assert.equal(response.status, origin === 'null' ? 403 : 204);
    }
    assert.equal(writes, 0);
});
test('rejected-origin diagnostics omit credentials, paths and query strings', () => {
    assert.equal(safeOriginLabel('https://user:secret@example.com:8443/path?token=secret#private'), 'https://example.com:8443');
    assert.equal(safeOriginLabel('null'), 'null (opaque origin)');
    for (const origin of ['data:secret', 'bad\r\nheader', 'x'.repeat(3000), undefined]) assert.equal(safeOriginLabel(origin), '[invalid origin]');
});
