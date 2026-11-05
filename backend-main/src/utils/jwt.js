import jwt from 'jsonwebtoken';
import { env } from '../config/index.js';

/**
 * Generates an access token for a user or admin.
 * @param {Object} payload - The data to encode in the JWT.
 * @returns {string} The signed JWT.
 */
export const signToken = (payload) => {
    return jwt.sign(payload, env.AUTH_SECRET, {
        expiresIn: `${env.JWT_ACCESS_EXPIRE_IN_MINUTES}m`,
    });
};

/**
 * Verifies an access token.
 * @param {string} token - The token to verify.
 * @returns {Object|null} The decoded payload or null if invalid.
 */
export const verifyToken = (token) => {
    try {
        return jwt.verify(token, env.AUTH_SECRET);
    } catch (error) {
        return null;
    }
};
