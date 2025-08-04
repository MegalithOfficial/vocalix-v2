import React, { useState, useEffect, useRef } from 'react';
import { motion } from 'framer-motion';
import { Download, Trash2, RefreshCw } from 'lucide-react';
import { logger } from '../../utils/logger';
import { LogEntry, LogLevel } from '../../types/settings';

const LogsSettingsTab: React.FC = () => {
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [filteredLogs, setFilteredLogs] = useState<LogEntry[]>([]);
  const [filterLevel, setFilterLevel] = useState<LogLevel | 'all'>('all');
  const [searchQuery, setSearchQuery] = useState('');
  const [autoScroll, setAutoScroll] = useState(true);
  const [maxLogEntries, setMaxLogEntries] = useState(1000);
  const [showDebugLogs, setShowDebugLogs] = useState(true);
  const [isLoading, setIsLoading] = useState(false);
  
  const logsEndRef = useRef<HTMLDivElement>(null);
  const logsContainerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const loadLogs = async () => {
      setIsLoading(true);
      try {
        await logger.loadLogsFromFile();
        setLogs(logger.getLogs());
      } catch (error) {
        console.error('Failed to load logs:', error);
      } finally {
        setIsLoading(false);
      }
    };
    
    loadLogs();

    const unsubscribe = logger.addListener((newLogs) => {
      setLogs(newLogs);
    });

    return unsubscribe;
  }, []);

  useEffect(() => {
    let filtered = logs;

    if (filterLevel !== 'all') {
      filtered = filtered.filter(log => log.level === filterLevel);
    }

    if (!showDebugLogs) {
      filtered = filtered.filter(log => log.level !== 'debug');
    }

    if (searchQuery.trim()) {
      const query = searchQuery.toLowerCase();
      filtered = filtered.filter(log => 
        log.message.toLowerCase().includes(query) ||
        log.component.toLowerCase().includes(query)
      );
    }

    setFilteredLogs(filtered);
  }, [logs, filterLevel, searchQuery, showDebugLogs]);

  useEffect(() => {
    if (autoScroll && logsEndRef.current) {
      logsEndRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [filteredLogs, autoScroll]);

  const handleClearLogs = () => {
    logger.clearLogs();
  };

  const handleDownloadLogs = () => {
    const logText = filteredLogs.map(log => 
      `[${new Date(log.timestamp).toLocaleString()}] [${log.level.toUpperCase()}] [${log.component}] ${log.message}`
    ).join('\n');
    
    const blob = new Blob([logText], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `vocalix-logs-${new Date().toISOString().split('T')[0]}.txt`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const handleRefreshLogs = async () => {
    setIsLoading(true);
    try {
      await logger.loadLogsFromFile();
    } finally {
      setIsLoading(false);
    }
  };

  const handleMaxLogEntriesChange = (value: number) => {
    setMaxLogEntries(value);
    logger.setMaxLogs(value);
  };

  const getLogLevelColor = (level: LogLevel) => {
    switch (level) {
      case 'debug': return 'text-gray-400 bg-gray-800/20';
      case 'info': return 'text-blue-400 bg-blue-800/20';
      case 'warn': return 'text-yellow-400 bg-yellow-800/20';
      case 'error': return 'text-red-400 bg-red-800/20';
      default: return 'text-gray-400 bg-gray-800/20';
    }
  };

  const getLogLevelIcon = (level: LogLevel) => {
    switch (level) {
      case 'debug': return '🔍';
      case 'info': return 'ℹ️';
      case 'warn': return '⚠️';
      case 'error': return '❌';
      default: return 'ℹ️';
    }
  };

  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3 }}
      className="space-y-6"
    >
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-3xl font-bold text-white mb-2">Application Logs</h2>
          <p className="text-gray-400">View and manage application logs in real-time</p>
        </div>
        <div className="flex gap-2">
          <motion.button
            whileHover={{ scale: 1.05 }}
            whileTap={{ scale: 0.95 }}
            onClick={handleRefreshLogs}
            disabled={isLoading}
            className="flex items-center gap-2 px-4 py-2 bg-blue-600 hover:bg-blue-700 disabled:bg-blue-800 text-white rounded-lg transition-colors"
          >
            <RefreshCw className={`w-4 h-4 ${isLoading ? 'animate-spin' : ''}`} />
            Refresh
          </motion.button>
          <motion.button
            whileHover={{ scale: 1.05 }}
            whileTap={{ scale: 0.95 }}
            onClick={handleDownloadLogs}
            className="flex items-center gap-2 px-4 py-2 bg-green-600 hover:bg-green-700 text-white rounded-lg transition-colors"
          >
            <Download className="w-4 h-4" />
            Download
          </motion.button>
          <motion.button
            whileHover={{ scale: 1.05 }}
            whileTap={{ scale: 0.95 }}
            onClick={handleClearLogs}
            className="flex items-center gap-2 px-4 py-2 bg-red-600 hover:bg-red-700 text-white rounded-lg transition-colors"
          >
            <Trash2 className="w-4 h-4" />
            Clear
          </motion.button>
        </div>
      </div>

      {/* Controls */}
      <div className="bg-gray-900/50 rounded-xl p-6 border border-gray-800">
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
          {/* Log Level Filter */}
          <div>
            <label className="block text-sm font-medium text-gray-300 mb-2">
              Log Level
            </label>
            <select
              value={filterLevel}
              onChange={(e) => setFilterLevel(e.target.value as LogLevel | 'all')}
              className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-white focus:outline-none focus:ring-2 focus:ring-blue-500"
            >
              <option value="all">All Levels</option>
              <option value="debug">Debug</option>
              <option value="info">Info</option>
              <option value="warn">Warning</option>
              <option value="error">Error</option>
            </select>
          </div>

          {/* Search */}
          <div>
            <label className="block text-sm font-medium text-gray-300 mb-2">
              Search
            </label>
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search logs..."
              className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>

          {/* Max Entries */}
          <div>
            <label className="block text-sm font-medium text-gray-300 mb-2">
              Max Entries
            </label>
            <select
              value={maxLogEntries}
              onChange={(e) => handleMaxLogEntriesChange(Number(e.target.value))}
              className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-white focus:outline-none focus:ring-2 focus:ring-blue-500"
            >
              <option value={500}>500</option>
              <option value={1000}>1000</option>
              <option value={2000}>2000</option>
              <option value={5000}>5000</option>
            </select>
          </div>

          {/* Settings */}
          <div className="space-y-2">
            <label className="block text-sm font-medium text-gray-300">
              Settings
            </label>
            <div className="flex flex-col gap-2">
              <label className="flex items-center gap-2 text-sm text-gray-300">
                <input
                  type="checkbox"
                  checked={autoScroll}
                  onChange={(e) => setAutoScroll(e.target.checked)}
                  className="w-4 h-4 text-blue-600 bg-gray-800 border-gray-700 rounded focus:ring-blue-500"
                />
                Auto-scroll
              </label>
              <label className="flex items-center gap-2 text-sm text-gray-300">
                <input
                  type="checkbox"
                  checked={showDebugLogs}
                  onChange={(e) => setShowDebugLogs(e.target.checked)}
                  className="w-4 h-4 text-blue-600 bg-gray-800 border-gray-700 rounded focus:ring-blue-500"
                />
                Show debug logs
              </label>
            </div>
          </div>
        </div>
      </div>

      {/* Log Stats */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        {['debug', 'info', 'warn', 'error'].map((level) => {
          const count = logs.filter(log => log.level === level).length;
          const colorClass = getLogLevelColor(level as LogLevel);
          return (
            <div key={level} className={`p-4 rounded-lg border border-gray-800 ${colorClass}`}>
              <div className="flex items-center gap-2">
                <span className="text-lg">{getLogLevelIcon(level as LogLevel)}</span>
                <div>
                  <div className="text-sm font-medium capitalize">{level}</div>
                  <div className="text-2xl font-bold">{count}</div>
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {/* Logs Display */}
      <div className="bg-gray-900/50 rounded-xl border border-gray-800">
        <div className="p-4 border-b border-gray-800 flex items-center justify-between">
          <h3 className="text-lg font-semibold text-white">
            Logs ({filteredLogs.length} of {logs.length})
          </h3>
          {isLoading && (
            <div className="flex items-center gap-2 text-gray-400">
              <RefreshCw className="w-4 h-4 animate-spin" />
              Loading...
            </div>
          )}
        </div>
        
        <div 
          ref={logsContainerRef}
          className="h-96 overflow-y-auto bg-black/20 font-mono text-sm"
        >
          {filteredLogs.length === 0 ? (
            <div className="flex items-center justify-center h-full text-gray-500">
              {isLoading ? 'Loading logs...' : 'No logs to display'}
            </div>
          ) : (
            <div className="p-4 space-y-1">
              {filteredLogs.map((log, index) => (
                <div 
                  key={index}
                  className={`flex gap-3 p-2 rounded text-xs hover:bg-gray-800/50 ${getLogLevelColor(log.level)}`}
                >
                  <span className="text-gray-500 shrink-0 w-20">
                    {new Date(log.timestamp).toLocaleTimeString()}
                  </span>
                  <span className={`shrink-0 w-12 text-center px-1 rounded ${getLogLevelColor(log.level)}`}>
                    {log.level.toUpperCase()}
                  </span>
                  <span className="text-gray-400 shrink-0 w-24 truncate">
                    [{log.component}]
                  </span>
                  <span className="flex-1 break-words">
                    {log.message}
                  </span>
                </div>
              ))}
              <div ref={logsEndRef} />
            </div>
          )}
        </div>
      </div>
    </motion.div>
  );
};

export default LogsSettingsTab;
