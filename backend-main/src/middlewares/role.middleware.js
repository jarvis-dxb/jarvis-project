import { errors } from '../utils/index.js';

export const authorize = (...roles) => (req, res, next) => {
  if (!req.user || !roles.includes(req.user.role)) {
    return next(errors.forbidden());
  }
  next();
};
