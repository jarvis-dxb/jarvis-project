import express from 'express';
import cors from 'cors';
import path from 'node:path';

// Vite bundles contain public code/styles/fonts, not account data. Serve them
// before credentialed API CORS so previews with a different/opaque origin can
// load the UI. Never extend this policy to API, auth or Socket.IO routes.
export function mountFrontendAssets(app, frontendDistDirectory) {
    const assets = express.Router();
    assets.use((req, res, next) => {
        if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next('router');
        next();
    });
    assets.use(cors({ origin: '*', methods: ['GET', 'HEAD'], credentials: false }));
    assets.use((_req, res, next) => {
        res.set('Cross-Origin-Resource-Policy', 'cross-origin');
        next();
    });
    assets.use(express.static(path.join(frontendDistDirectory, 'assets'), {
        index: false, redirect: false, fallthrough: false, dotfiles: 'deny',
    }));
    // An absent bundle is not an SPA route. Keep filesystem paths and development
    // stacks out of these public responses, including malformed/traversal URLs.
    assets.use((err, _req, res, _next) => {
        const status = [400, 403, 404].includes(err.status) ? err.status : 500;
        res.status(status).type('text/plain').send(status === 500 ? 'Asset unavailable' : 'Asset not found');
    });
    app.use('/assets', assets);
}
