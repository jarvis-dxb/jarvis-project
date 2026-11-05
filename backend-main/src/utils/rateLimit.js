import { rateLimit } from 'express-rate-limit';

export const limiter = rateLimit({
    windowMs: 1 * 60 * 1000, // 1 minute
    limit: 1000, // 1000 requests per minute
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    validate: {
        xForwardedForHeader: false,
        default: false,
    },
    handler: (req, res, next, options) => {
        res.status(options.statusCode).json({
            status: 'fail',
            message: 'Too many requests, please try again in a minute.'
        });
    }
});