const logger = require('./logger');

// Validation function for asset parameters
function validateAsset(asset) {
  if (!asset || typeof asset !== 'string') {
    throw new Error('Asset parameter is required and must be a string');
  }
  
  // Remove any path traversal attempts and normalize
  const cleanAsset = asset.replace(/[./\\]/g, '').trim();
  
  // Validate length (reasonable limit)
  if (cleanAsset.length > 20 || cleanAsset.length < 1) {
    throw new Error('Asset parameter must be between 1 and 20 characters');
  }
  
  // Validate format (alphanumeric and common crypto symbols)
  if (!/^[A-Za-z0-9]+$/.test(cleanAsset)) {
    throw new Error('Asset parameter contains invalid characters (only letters and numbers allowed)');
  }
  
  return cleanAsset.toUpperCase();
}

// Validation function for transaction IDs
function validateTxid(txid) {
  if (!txid || typeof txid !== 'string') {
    throw new Error('Transaction ID is required and must be a string');
  }
  
  // Kraken txid format validation (alphanumeric with hyphens)
  if (!/^[A-Za-z0-9\-]+$/.test(txid)) {
    throw new Error('Invalid transaction ID format (only letters, numbers, and hyphens allowed)');
  }
  
  // Length validation
  if (txid.length > 50 || txid.length < 10) {
    throw new Error('Transaction ID length is invalid (must be between 10 and 50 characters)');
  }
  
  return txid;
}

// Validation function for array of transaction IDs
function validateTxidArray(txids) {
  if (!Array.isArray(txids)) {
    throw new Error('Transaction IDs must be provided as an array');
  }
  
  if (txids.length === 0) {
    throw new Error('Transaction IDs array cannot be empty');
  }
  
  if (txids.length > 20) {
    throw new Error('Maximum 20 transaction IDs per request');
  }
  
  // Validate each transaction ID
  const validatedTxids = [];
  for (let i = 0; i < txids.length; i++) {
    try {
      validatedTxids.push(validateTxid(txids[i]));
    } catch (error) {
      throw new Error(`Invalid transaction ID at index ${i}: ${error.message}`);
    }
  }
  
  return validatedTxids;
}

// Middleware for consistent error responses
function handleValidationError(error, req, res) {
  logger.warn('Input validation failed', {
    error: error.message,
    endpoint: req.path,
    method: req.method,
    params: req.params,
    body: req.body,
    userAgent: req.get('User-Agent'),
    ip: req.ip
  });
  
  res.status(400).json({
    error: 'Invalid input',
    message: error.message,
    timestamp: new Date().toISOString()
  });
}

module.exports = {
  validateAsset,
  validateTxid,
  validateTxidArray,
  handleValidationError
}; 