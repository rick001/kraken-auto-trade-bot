const logger = require('./logger');

// Standard error response format
const createErrorResponse = (error, statusCode = 500, context = {}) => {
  const response = {
    error: error.type || 'Internal Server Error',
    message: error.message || 'An unexpected error occurred',
    timestamp: new Date().toISOString(),
    statusCode: statusCode
  };

  // Add context if provided
  if (Object.keys(context).length > 0) {
    response.context = context;
  }

  // Add request ID if available
  if (error.requestId) {
    response.requestId = error.requestId;
  }

  return response;
};

// Common error types
const ErrorTypes = {
  VALIDATION_ERROR: 'Validation Error',
  NOT_FOUND: 'Not Found',
  UNAUTHORIZED: 'Unauthorized',
  RATE_LIMIT_EXCEEDED: 'Rate Limit Exceeded',
  KRAKEN_API_ERROR: 'Kraken API Error',
  WEBSOCKET_ERROR: 'WebSocket Error',
  INTERNAL_ERROR: 'Internal Server Error',
  BAD_REQUEST: 'Bad Request'
};

// HTTP status codes mapping
const StatusCodes = {
  [ErrorTypes.VALIDATION_ERROR]: 400,
  [ErrorTypes.NOT_FOUND]: 404,
  [ErrorTypes.UNAUTHORIZED]: 401,
  [ErrorTypes.RATE_LIMIT_EXCEEDED]: 429,
  [ErrorTypes.KRAKEN_API_ERROR]: 502,
  [ErrorTypes.WEBSOCKET_ERROR]: 503,
  [ErrorTypes.INTERNAL_ERROR]: 500,
  [ErrorTypes.BAD_REQUEST]: 400
};

// Send standardized error response
const sendErrorResponse = (res, error, context = {}) => {
  const statusCode = error.statusCode || StatusCodes[error.type] || 500;
  const response = createErrorResponse(error, statusCode, context);
  
  logger.error('API Error Response', {
    error: error.message,
    type: error.type,
    statusCode,
    endpoint: context.endpoint,
    method: context.method,
    userAgent: context.userAgent,
    ip: context.ip
  });

  res.status(statusCode).json(response);
};

// Create specific error types
const createValidationError = (message, field = null) => ({
  type: ErrorTypes.VALIDATION_ERROR,
  message,
  field,
  statusCode: 400
});

const createNotFoundError = (message, resource = null) => ({
  type: ErrorTypes.NOT_FOUND,
  message,
  resource,
  statusCode: 404
});

const createKrakenApiError = (message, apiError = null) => ({
  type: ErrorTypes.KRAKEN_API_ERROR,
  message,
  apiError,
  statusCode: 502
});

const createWebSocketError = (message, connectionState = null) => ({
  type: ErrorTypes.WEBSOCKET_ERROR,
  message,
  connectionState,
  statusCode: 503
});

const createRateLimitError = (message, retryAfter = null) => ({
  type: ErrorTypes.RATE_LIMIT_EXCEEDED,
  message,
  retryAfter,
  statusCode: 429
});

const createInternalError = (message, details = null) => ({
  type: ErrorTypes.INTERNAL_ERROR,
  message,
  details,
  statusCode: 500
});

// Middleware for consistent error handling
const errorHandler = (err, req, res, next) => {
  const context = {
    endpoint: req.path,
    method: req.method,
    userAgent: req.get('User-Agent'),
    ip: req.ip,
    params: req.params,
    body: req.body
  };

  // Handle validation errors
  if (err.message && (err.message.includes('Asset parameter') || 
                      err.message.includes('Transaction ID') || 
                      err.message.includes('Invalid'))) {
    const validationError = createValidationError(err.message);
    return sendErrorResponse(res, validationError, context);
  }

  // Handle Kraken API errors
  if (err.message && (err.message.includes('Kraken') || 
                      err.message.includes('API') ||
                      err.message.includes('rate limit'))) {
    const krakenError = createKrakenApiError(err.message, err);
    return sendErrorResponse(res, krakenError, context);
  }

  // Handle WebSocket errors
  if (err.message && err.message.includes('WebSocket')) {
    const wsError = createWebSocketError(err.message);
    return sendErrorResponse(res, wsError, context);
  }

  // Default internal error
  const internalError = createInternalError(err.message, err.stack);
  sendErrorResponse(res, internalError, context);
};

// Success response helper
const sendSuccessResponse = (res, data, statusCode = 200) => {
  const response = {
    ...data,
    timestamp: new Date().toISOString(),
    status: 'success'
  };

  res.status(statusCode).json(response);
};

module.exports = {
  ErrorTypes,
  StatusCodes,
  createErrorResponse,
  sendErrorResponse,
  sendSuccessResponse,
  createValidationError,
  createNotFoundError,
  createKrakenApiError,
  createWebSocketError,
  createRateLimitError,
  createInternalError,
  errorHandler
}; 