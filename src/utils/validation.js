const logger = require('./logger');
const { sendErrorResponse, createValidationError } = require('./errorHandler');

// Validation function for asset parameters
function validateAsset(asset) {
  if (!asset || typeof asset !== 'string') {
    throw createValidationError('Asset parameter is required and must be a string', 'asset');
  }
  const cleanAsset = asset.replace(/[./\\]/g, '').trim();
  if (cleanAsset.length > 20 || cleanAsset.length < 1) {
    throw createValidationError('Asset parameter must be between 1 and 20 characters', 'asset');
  }
  if (!/^[A-Za-z0-9]+$/.test(cleanAsset)) {
    throw createValidationError('Asset parameter contains invalid characters (only letters and numbers allowed)', 'asset');
  }
  return cleanAsset.toUpperCase();
}

// Validation function for transaction IDs
function validateTxid(txid) {
  if (!txid || typeof txid !== 'string') {
    throw createValidationError('Transaction ID is required and must be a string', 'txid');
  }
  if (!/^[A-Za-z0-9\-]+$/.test(txid)) {
    throw createValidationError('Invalid transaction ID format (only letters, numbers, and hyphens allowed)', 'txid');
  }
  if (txid.length > 50 || txid.length < 10) {
    throw createValidationError('Transaction ID length is invalid (must be between 10 and 50 characters)', 'txid');
  }
  return txid;
}

// Validation function for array of transaction IDs
function validateTxidArray(txids) {
  if (!Array.isArray(txids)) {
    throw createValidationError('Transaction IDs must be provided as an array', 'txids');
  }
  if (txids.length === 0) {
    throw createValidationError('Transaction IDs array cannot be empty', 'txids');
  }
  if (txids.length > 20) {
    throw createValidationError('Maximum 20 transaction IDs per request', 'txids');
  }
  const validatedTxids = [];
  for (let i = 0; i < txids.length; i++) {
    try {
      validatedTxids.push(validateTxid(txids[i]));
    } catch (error) {
      throw createValidationError(`Invalid transaction ID at index ${i}: ${error.message}`, `txids[${i}]`);
    }
  }
  return validatedTxids;
}

// Middleware for consistent error responses (updated to use new error handler)
function handleValidationError(error, req, res) {
  const context = {
    endpoint: req.path,
    method: req.method,
    userAgent: req.get('User-Agent'),
    ip: req.ip,
    params: req.params,
    body: req.body
  };

  logger.warn('Input validation failed', {
    error: error.message,
    field: error.field,
    endpoint: req.path,
    method: req.method,
    params: req.params,
    body: req.body,
    userAgent: req.get('User-Agent'),
    ip: req.ip
  });

  sendErrorResponse(res, error, context);
}

module.exports = {
  validateAsset,
  validateTxid,
  validateTxidArray,
  handleValidationError
}; 