import { env } from './env.js';
import { errors } from '../utils/error.js';

// Log only the origin, never userinfo, paths or query strings from bad headers.
export function safeOriginLabel(origin) {
    if (origin === 'null') return 'null (opaque origin)';
    if (typeof origin !== 'string' || origin.length > 2048) return '[invalid origin]';
    try {
        const parsed = new URL(origin);
        return ['http:', 'https:'].includes(parsed.protocol) ? parsed.origin : '[invalid origin]';
    } catch {
        return '[invalid origin]';
    }
}

export const corsConfig = {
    origin: (origin, callback) => {
        if (!origin || env.CORS_ORIGINS.includes(origin)) {
            callback(null, true);
        } else {
            callback(errors.forbidden(`CORS origin not allowed: ${safeOriginLabel(origin)}`));
        }
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS', 'PATCH'],
}
