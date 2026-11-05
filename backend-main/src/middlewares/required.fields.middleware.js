import { errors } from '../utils/index.js';

// simple helper to ensure the request body or query contains the listed fields
export const requiredFields = (...fields) => (req, res, next) => {
  const source = (req.method === 'GET' || req.method === 'DELETE') ? req.query : req.body;
  const missing = fields.filter((f) => source[f] === undefined || source[f] === null || source[f] === '');
  if (missing.length > 0) {
    return next(
      errors.badRequest(`Missing required field(s): ${missing.join(', ')}`)
    );
  }
  next();
};

