import helmet from 'helmet';

export const helmetConfig = {
    contentSecurityPolicy: {
        directives: {
            ...helmet.contentSecurityPolicy.getDefaultDirectives(),
            // The chart's same-origin blob iframe sets its base to library_path.
            // It inherits this policy, so both that base and its CDN styles/fonts
            // must be permitted for cross-origin chart-library hosting.
            "base-uri": ["'self'", "https://cdn.jsdelivr.net"],
            "script-src-attr": ["'unsafe-inline'"], // Is se onclick allow ho jayega
            "script-src": ["'self'", "'unsafe-inline'", "https://cdnjs.cloudflare.com", "https://cdn.jsdelivr.net"],
            "style-src": ["'self'", "'unsafe-inline'", "blob:", "https://fonts.googleapis.com", "https://cdn.jsdelivr.net"],
            "font-src": ["'self'", "data:", "https://fonts.gstatic.com", "https://cdn.jsdelivr.net"],
            "img-src": ["'self'", "data:", "blob:", "https://ico.hugeicons.com", "https://cdn.jsdelivr.net", "https://s3-symbol-logo.tradingview.com"],
            "media-src": ["'self'", "https://cdn.jsdelivr.net"],
            "connect-src": ["'self'", "https://cdn.jsdelivr.net", "https://demo-feed-data.tradingview.com", "https://saveload.tradingview.com", "https://fapi.binance.com", "https://demo-fapi.binance.com", "wss:"],
            "worker-src": ["'self'", "blob:"],
            "frame-src": ["'self'", "blob:", "https://*.tradingview-widget.com", "https://s.tradingview.com"],
        },
    },
}
