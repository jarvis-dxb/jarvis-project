import { getSession } from "@auth/express";
import { errors, verifyToken } from '../utils/index.js';
import { userAuthConfig } from "../config/index.js";

export const authenticateUser = async (req, res, next) => {
  try {
    // Auth.js session ko request se nikaalta hai (Cookies ke zariye)
    let session = await getSession(req, userAuthConfig);

    // FALLBACK: Agar session cookie nahi mili (e.g. production cross-domain)
    // to Authorization header (Bearer token) check karein
    if (!session || !session.user) {
      const authHeader = req.headers.authorization;
      if (authHeader && authHeader.startsWith('Bearer ')) {
        const token = authHeader.split(' ')[1];
        try {
          const decoded = verifyToken(token);
          if (decoded) {
            session = { user: decoded };
          }
        } catch (err) {
          // User JWT Verification Failed (silent in logs for clean production)
        }
      }
    }

    if (!session || !session.user) {
      return next(errors.unauthorized('Unauthorized: Please login first'));
    }

    // Request object mein user data save kar dena taake controllers use kar sakein
    req.user = {
      id: session.user.id,
      email: session.user.email,
      role: session.user.role
    };

    next();
  } catch (error) {
    console.error("User Auth Middleware Error:", error);
    return next(errors.serverError('Internal Server Error in User Authentication'));
  }
};