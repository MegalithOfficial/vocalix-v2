import { invoke } from '@tauri-apps/api/core';
import { LogLevel, LogEntry } from '../types/settings';

class Logger {
  private static instance: Logger;
  private logBuffer: LogEntry[] = [];
  private listeners: ((logs: LogEntry[]) => void)[] = [];
  private maxLogs = 1000;

  private constructor() {}

  static getInstance(): Logger {
    if (!Logger.instance) {
      Logger.instance = new Logger();
    }
    return Logger.instance;
  }

  private async writeToBackend(level: LogLevel, component: string, message: string) {
    try {
      await invoke('write_log', {
        level,
        component,
        message,
        timestamp: new Date().toISOString()
      });
    } catch (error) {
      console.error('Failed to write log to backend:', error);
    }
  }

  private addLogEntry(level: LogLevel, component: string, message: string) {
    const logEntry: LogEntry = {
      timestamp: new Date().toISOString(),
      level,
      component,
      message
    };

    this.logBuffer.push(logEntry);
    
    if (this.logBuffer.length > this.maxLogs) {
      this.logBuffer = this.logBuffer.slice(-this.maxLogs);
    }

    this.listeners.forEach(listener => listener([...this.logBuffer]));

    this.writeToBackend(level, component, message);
  }

  debug(component: string, message: string) {
    console.debug(`[${component}] ${message}`);
    this.addLogEntry('debug', component, message);
  }

  info(component: string, message: string) {
    console.info(`[${component}] ${message}`);
    this.addLogEntry('info', component, message);
  }

  warn(component: string, message: string) {
    console.warn(`[${component}] ${message}`);
    this.addLogEntry('warn', component, message);
  }

  error(component: string, message: string) {
    console.error(`[${component}] ${message}`);
    this.addLogEntry('error', component, message);
  }

  log(component: string, message: string) {
    console.log(`[${component}] ${message}`);
    this.addLogEntry('info', component, message);
  }

  getLogs(): LogEntry[] {
    return [...this.logBuffer];
  }

  addListener(listener: (logs: LogEntry[]) => void) {
    this.listeners.push(listener);
    return () => {
      this.listeners = this.listeners.filter(l => l !== listener);
    };
  }

  clearLogs() {
    this.logBuffer = [];
    this.listeners.forEach(listener => listener([]));
    invoke('clear_logs').catch(console.error);
  }

  async loadLogsFromFile(): Promise<LogEntry[]> {
    try {
      const logs = await invoke<LogEntry[]>('get_logs');
      this.logBuffer = logs.slice(-this.maxLogs);
      this.listeners.forEach(listener => listener([...this.logBuffer]));
      return this.logBuffer;
    } catch (error) {
      console.error('Failed to load logs from file:', error);
      return [];
    }
  }

  setMaxLogs(max: number) {
    this.maxLogs = max;
    if (this.logBuffer.length > max) {
      this.logBuffer = this.logBuffer.slice(-max);
      this.listeners.forEach(listener => listener([...this.logBuffer]));
    }
  }
}

export const logger = Logger.getInstance();

export const logDebug = (component: string, message: string) => logger.debug(component, message);
export const logInfo = (component: string, message: string) => logger.info(component, message);
export const logWarn = (component: string, message: string) => logger.warn(component, message);
export const logError = (component: string, message: string) => logger.error(component, message);
export const log = (component: string, message: string) => logger.log(component, message);
