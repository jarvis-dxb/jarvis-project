// Example of how to use the error utilities in your controllers or services:

// throw errors.badRequest('Password too weak', { minLength: 8, received: 5 });
// throw errors.notFound('User not found', { userId: 123 });
// throw errors.conflict('Email already registered', { email: 'user@example.com' });
// throw errors.unprocessable('Invalid request', { 
//   errors: [
//     { field: 'age', message: 'must be a number' },
//     { field: 'phone', message: 'must be 10 digits' }
//   ]
// });
// throw errors.serverError('Database connection failed', { errorCode: 'ECONNREFUSED' });


const ErrorResponse = (message, statusCode, details = null) => {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.details = details;
  error.name = 'ErrorResponse';
  Error.captureStackTrace(error, ErrorResponse);
  return error;
};

// Common HTTP error helpers for consistent error responses
export const errors = {
  badRequest: (message = 'Bad Request', details = null) => ErrorResponse(message, 400, details),
  unauthorized: (message = 'Unauthorized', details = null) => ErrorResponse(message, 401, details),
  forbidden: (message = 'Forbidden', details = null) => ErrorResponse(message, 403, details),
  notFound: (message = 'Not Found', details = null) => ErrorResponse(message, 404, details),
  conflict: (message = 'Conflict', details = null) => ErrorResponse(message, 409, details),
  unprocessable: (message = 'Unprocessable Entity', details = null) => ErrorResponse(message, 422, details),
  tooManyRequests: (message = 'Too Many Requests', details = null) => ErrorResponse(message, 429, details),
  serverError: (message = 'Internal Server Error', details = null) => ErrorResponse(message, 500, details),
};

// Centralized middleware for formatting and sending errors
export const errorHandler = (err, req, res, next) => {
  // default status
  const statusCode = err.statusCode || 500;
  const message = err.message || 'Internal Server Error';
  const details = err.details || null;

  console.error(`[${new Date().toISOString()}] ${err.name || 'Error'}: ${message}`);

  res.status(statusCode).json({
    success: false,
    statusCode,
    message,
    ...(details && { details }),
    ...(process.env.APP_ENV !== 'production' && { stack: err.stack }),
  });
};

export default ErrorResponse;
