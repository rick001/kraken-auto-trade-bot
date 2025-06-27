const config = require('../config');

class Logger {
  constructor() {
    this.levels = config.logging.levels;
  }

  log(level, message, data = {}) {
    const logEntry = {
      timestamp: new Date().toISOString(),
      level,
      message,
      ...(Object.keys(data).length > 0 ? data : {})
    };

    const consoleMessage = `[${logEntry.timestamp}] ${level.toUpperCase()}: ${message}`;

    switch (level) {
      case this.levels.ERROR:
        console.error(consoleMessage, Object.keys(data).length > 0 ? data : '');
        break;
      case this.levels.WARN:
        console.warn(consoleMessage, Object.keys(data).length > 0 ? data : '');
        break;
      case this.levels.INFO:
        console.log(consoleMessage, Object.keys(data).length > 0 ? data : '');
        break;
      case this.levels.DEBUG:
        if (process.env.DEBUG) {
          console.debug(consoleMessage, Object.keys(data).length > 0 ? data : '');
        }
        break;
    }
  }

  error(message, data = {}) {
    this.log(this.levels.ERROR, message, data);
  }

  warn(message, data = {}) {
    this.log(this.levels.WARN, message, data);
  }

  info(message, data = {}) {
    this.log(this.levels.INFO, message, data);
  }

  debug(message, data = {}) {
    this.log(this.levels.DEBUG, message, data);
  }
}

module.exports = new Logger(); 