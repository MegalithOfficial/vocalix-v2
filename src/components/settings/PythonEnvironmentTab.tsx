import { motion, AnimatePresence } from 'framer-motion';
import { Settings2, RefreshCw, Search, Trash2, Terminal, ChevronDown, ChevronUp, AlertTriangle, CheckCircle, XCircle, X } from 'lucide-react';
import { invoke } from '@tauri-apps/api/core';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { appDataDir } from '@tauri-apps/api/path';
import { useSettingsState } from '../../hooks/useSettingsState';
import { logger } from '../../utils/logger';
import { useState, useRef, useEffect } from 'react';

interface PythonEnvironmentTabProps {
  settingsState: ReturnType<typeof useSettingsState>;
}

const PythonEnvironmentTab = ({ settingsState }: PythonEnvironmentTabProps) => {
  const {
    isSettingUpEnv,
    setIsSettingUpEnv,
    setupProgress,
    setSetupProgress,
    setupStatus,
    setSetupStatus,
    isCheckingVersions,
    setIsCheckingVersions,
    isForceReinstalling,
    setIsForceReinstalling,
    isResettingEnv,
    setIsResettingEnv,
    pythonVersion,
    setPythonVersion,
    libraryVersions,
    setLibraryVersions,
    environmentReady,
    setEnvironmentReady,
    isCheckingEnvironment,
  } = settingsState;

  const [showLogPanel, setShowLogPanel] = useState(false);
  const [logMessages, setLogMessages] = useState<string[]>([]);
  const [currentPythonVersion, setCurrentPythonVersion] = useState<string>('');
  const [versionError, setVersionError] = useState<string>('');
  const [confirmDeleteOpen, setConfirmDeleteOpen] = useState(false);
  const [virtualEnvPath, setVirtualEnvPath] = useState<string>('');
  const logEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (logEndRef.current) {
      logEndRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [logMessages]);

  useEffect(() => {
    (async () => {
      try {
        const dir = await appDataDir();
        setVirtualEnvPath(`${dir}/pythonenv`);
      } catch {
        setVirtualEnvPath('./pythonenv');
      }
    })();
  }, []);

  const addLogMessage = (message: string, type: 'info' | 'error' | 'success' = 'info') => {
    const timestamp = new Date().toLocaleTimeString();
    const icon = type === 'error' ? '❌' : type === 'success' ? '✅' : 'ℹ️';
    setLogMessages(prev => [...prev, `[${timestamp}] ${icon} ${message}`]);
  };

  const clearLogs = () => {
    setLogMessages([]);
  };

  const validatePythonVersion = (version: string): { valid: boolean; message: string } => {
    const versionMatch = version.match(/Python (\d+)\.(\d+)\.(\d+)/);
    if (!versionMatch) {
      return { valid: false, message: 'Invalid Python version format' };
    }

    const [, major, minor, patch] = versionMatch;
    const majorNum = parseInt(major);
    const minorNum = parseInt(minor);

    if (majorNum !== 3) {
      return { valid: false, message: `Python ${majorNum}.${minorNum}.${patch} found. Only Python 3.10.* is supported.` };
    }

    if (minorNum !== 10) {
      return { valid: false, message: `Python ${majorNum}.${minorNum}.${patch} found. Only Python 3.10.* is supported.` };
    }

    return { valid: true, message: `Python ${majorNum}.${minorNum}.${patch} is compatible.` };
  };

  const checkSystemPython = async (): Promise<boolean> => {
    try {
      addLogMessage('Checking system Python version...');
      const pythonVersion = await invoke('check_python_version', {}) as string;
      setCurrentPythonVersion(pythonVersion);
      
      const validation = validatePythonVersion(pythonVersion);
      if (!validation.valid) {
        setVersionError(validation.message);
        addLogMessage(validation.message, 'error');
        return false;
      } else {
        setVersionError('');
        addLogMessage(validation.message, 'success');
        return true;
      }
    } catch (error) {
      const errorMsg = `Failed to check Python version: ${error}`;
      setVersionError(errorMsg);
      addLogMessage(errorMsg, 'error');
      return false;
    }
  };

  return (
    <motion.div
      initial={{ x: 20, opacity: 0 }}
      animate={{ x: 0, opacity: 1 }}
      transition={{ duration: 0.3 }}
      className="space-y-6"
    >
      <div>
        <h2 className="text-2xl font-bold text-white mb-2">Python Environment</h2>
  <p className="text-gray-400">Set up the Python 3.10 environment and required TTS dependencies.</p>
        {/* quick status chips */}
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <span className={`inline-flex items-center px-2.5 py-1 rounded-full text-xs font-medium border ${
            environmentReady
              ? 'bg-green-500/10 text-green-300 border-green-500/30'
              : 'bg-orange-500/10 text-orange-300 border-orange-500/30'
          }`}>
            {environmentReady ? (
              <>
                <CheckCircle className="w-3.5 h-3.5 mr-1" /> Ready
              </>
            ) : (
              <>
                <AlertTriangle className="w-3.5 h-3.5 mr-1" /> Not ready
              </>
            )}
          </span>
          <span className="inline-flex items-center px-2.5 py-1 rounded-full text-xs font-medium border bg-gray-700/40 text-gray-200 border-gray-600/50">
            Python: {(pythonVersion || currentPythonVersion || 'unknown')}
          </span>
        </div>
        <div className="mt-2 text-sm text-orange-300 bg-orange-900/20 border border-orange-500/30 rounded-lg p-3">
          <div className="flex items-center space-x-2">
            <AlertTriangle className="w-4 h-4" />
            <span className="font-medium">Python 3.10.* Required</span>
          </div>
          <p className="text-orange-200 mt-1">Only Python 3.10.* versions are supported. Other versions (3.9, 3.11, 3.12, etc.) are not supported.</p>
        </div>
      </div>

      <div className="bg-gray-800/50 border border-gray-700/50 rounded-2xl p-6">
        <div className="space-y-6">
          <h3 className="text-lg font-semibold text-white">Environment Management</h3>

          {/* Version Error Display */}
          {versionError && (
            <motion.div
              initial={{ opacity: 0, y: -10 }}
              animate={{ opacity: 1, y: 0 }}
              className="p-4 bg-red-500/10 border border-red-500/30 rounded-lg"
            >
              <div className="flex items-center space-x-3">
                <XCircle className="w-5 h-5 text-red-400" />
                <div>
                  <h4 className="text-sm font-medium text-red-300">Python Version Error</h4>
                  <p className="text-xs text-red-200 mt-1">{versionError}</p>
                </div>
              </div>
            </motion.div>
          )}

          {/* Current Python Version Display */}
          {currentPythonVersion && !versionError && (
            <motion.div
              initial={{ opacity: 0, y: -10 }}
              animate={{ opacity: 1, y: 0 }}
              className="p-4 bg-green-500/10 border border-green-500/30 rounded-lg"
            >
              <div className="flex items-center space-x-3">
                <CheckCircle className="w-5 h-5 text-green-400" />
                <div>
                  <h4 className="text-sm font-medium text-green-300">Python Version Detected</h4>
                  <p className="text-xs text-green-200 mt-1 font-mono">{currentPythonVersion}</p>
                </div>
              </div>
            </motion.div>
          )}

          {/* Environment Setup Section */}
          {!environmentReady && !isCheckingEnvironment && (
            <div>
              <label className="block text-sm font-medium text-gray-300 mb-3">Environment Setup</label>
              <div className="space-y-4">
                <div className="p-4 bg-gray-700/30 border border-gray-600/30 rounded-lg">
                  <div className="flex items-center space-x-3 mb-3">
                    <Settings2 className={`w-5 h-5 text-orange-400 ${isSettingUpEnv ? 'animate-spin' : ''}`} />
                    <h4 className="text-sm font-semibold text-white">
                      {isSettingUpEnv ? 'Setting up environment...' : 'Python Environment Setup'}
                    </h4>
                  </div>
                  <p className="text-xs text-gray-400 mb-4">
                    {isSettingUpEnv 
                      ? 'Please wait while we configure your Python environment'
                      : 'Check for Python 3.10, create virtual environment, and install required packages'
                    }
                  </p>
                  <motion.button
                    whileHover={!isSettingUpEnv ? { scale: 1.02 } : {}}
                    whileTap={!isSettingUpEnv ? { scale: 0.98 } : {}}
                    onClick={async () => {
                      if (isSettingUpEnv) return;
                      
                      try {
                        setIsSettingUpEnv(true);
                        setSetupProgress(0);
                        setSetupStatus('Initializing setup...');
                        clearLogs();
                        setShowLogPanel(true);
                        addLogMessage('Starting Python environment setup...');

                        const isPythonValid = await checkSystemPython();
                        if (!isPythonValid) {
                          setIsSettingUpEnv(false);
                          return;
                        }

                        const window = getCurrentWindow();
                        const unlisten = await window.listen('PYTHON_SETUP_PROGRESS', (event: any) => {
                          const { progress, status } = event.payload;
                          setSetupProgress(progress);
                          setSetupStatus(status);
                          addLogMessage(status);
                        });

                        try {
                          const result = await invoke('setup_python_environment');
                          logger.info('PythonEnvironment', `Python environment setup result: ${JSON.stringify(result)}`);
                          addLogMessage('Environment setup completed successfully!', 'success');
                          
                          setSetupStatus('Environment setup completed successfully!');
                          unlisten();
                          
                          const status = await invoke('check_environment_status') as any;
                          if (status.environment_ready) {
                            setEnvironmentReady(true);
                            if (status.python_version) {
                              setPythonVersion(status.python_version);
                            }
                            if (status.library_versions) {
                              const formatted = Object.entries(status.library_versions)
                                .map(([lib, version]) => `${lib}: ${version}`)
                                .join('\n');
                              setLibraryVersions(formatted);
                            }
                          }
                          
                          setTimeout(() => {
                            setIsSettingUpEnv(false);
                            setSetupProgress(0);
                            setSetupStatus('');
                          }, 3000);

                        } catch (error) {
                          console.error('Failed to setup Python environment:', error);
                          const errorMsg = `Setup failed: ${error}`;
                          setSetupStatus(errorMsg);
                          addLogMessage(errorMsg, 'error');
                          setSetupProgress(0);
                          unlisten();
                          
                          setTimeout(() => {
                            setIsSettingUpEnv(false);
                            setSetupProgress(0);
                            setSetupStatus('');
                          }, 5000);
                        }

                      } catch (error) {
                        console.error('Setup initialization failed:', error);
                        addLogMessage(`Setup initialization failed: ${error}`, 'error');
                        setIsSettingUpEnv(false);
                      }
                    }}
                    disabled={isSettingUpEnv}
                    className={`px-6 py-3 rounded-lg font-medium transition-colors flex items-center space-x-2 ${
                      isSettingUpEnv 
                        ? 'bg-orange-600/30 cursor-not-allowed text-orange-300' 
                        : 'bg-orange-600 hover:bg-orange-700 text-white'
                    }`}
                  >
                    <Settings2 className={`w-4 h-4 ${isSettingUpEnv ? 'animate-spin' : ''}`} />
                    <span>
                      {isSettingUpEnv ? 'Setting up...' : 'Setup Environment'}
                    </span>
                  </motion.button>
                </div>

                {/* Progress Section */}
                {isSettingUpEnv && (
                  <motion.div
                    initial={{ opacity: 0, height: 0 }}
                    animate={{ opacity: 1, height: 'auto' }}
                    exit={{ opacity: 0, height: 0 }}
                    className="p-4 bg-gray-700/30 border border-gray-600/30 rounded-lg"
                  >
                    <div className="space-y-3">
                      <div className="flex items-center justify-between">
                        <span className="text-xs font-medium text-gray-300">{setupStatus}</span>
                        <span className="text-xs font-bold text-orange-400">{setupProgress}%</span>
                      </div>
                      
                      <div className="relative w-full bg-gray-600/50 rounded-full h-2 overflow-hidden">
                        <motion.div
                          initial={{ width: 0 }}
                          animate={{ width: `${setupProgress}%` }}
                          transition={{ duration: 0.8, ease: "easeOut" }}
                          className="h-full bg-orange-500 rounded-full"
                        />
                      </div>

                      {/* Status indicators */}
                      <div className="grid grid-cols-3 gap-2 pt-2">
                        <div className={`text-center p-1 rounded text-xs ${
                          setupProgress >= 25 ? 'bg-green-500/20 text-green-300' : 'bg-gray-600/30 text-gray-400'
                        }`}>
                          Python
                        </div>
                        <div className={`text-center p-1 rounded text-xs ${
                          setupProgress >= 60 ? 'bg-green-500/20 text-green-300' : 'bg-gray-600/30 text-gray-400'
                        }`}>
                          Virtual Env
                        </div>
                        <div className={`text-center p-1 rounded text-xs ${
                          setupProgress >= 100 ? 'bg-green-500/20 text-green-300' : 'bg-gray-600/30 text-gray-400'
                        }`}>
                          Packages
                        </div>
                      </div>
                    </div>
                  </motion.div>
                )}
              </div>
            </div>
          )}

          {/* Environment Management Actions */}
          {!isSettingUpEnv && !isForceReinstalling && !isResettingEnv && (
            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-300 mb-3">Environment Management</label>
                <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                  {/* Check Versions Button */}
                  <motion.button
                    whileHover={{ scale: 1.02 }}
                    whileTap={{ scale: 0.98 }}
                    onClick={async () => {
                      try {
                        setIsCheckingVersions(true);
                        addLogMessage('Checking environment status and versions...');
                        
                        const status = await invoke('check_environment_status') as any;
                        
                        if (status.environment_ready) {
                          if (status.python_version) {
                            setPythonVersion(status.python_version);
                            addLogMessage(`Python version: ${status.python_version}`, 'success');
                          }
                          if (status.library_versions) {
                            const formatted = Object.entries(status.library_versions)
                              .map(([lib, version]) => `${lib}: ${version}`)
                              .join('\n');
                            setLibraryVersions(formatted);
                            addLogMessage('Library versions checked successfully', 'success');
                          }
                        } else {
                          setLibraryVersions('Environment not ready');
                          setPythonVersion('Not available');
                          addLogMessage('Environment not ready', 'error');
                        }
                      } catch (error) {
                        console.error('Version check failed:', error);
                        const errorMsg = `Version check failed: ${error}`;
                        setLibraryVersions(errorMsg);
                        setPythonVersion('Error');
                        addLogMessage(errorMsg, 'error');
                      } finally {
                        setIsCheckingVersions(false);
                      }
                    }}
                    disabled={isCheckingVersions}
                    className={`p-4 rounded-lg border transition-colors text-left ${
                      isCheckingVersions
                        ? 'border-blue-500/50 bg-blue-500/10 text-blue-300 cursor-not-allowed'
                        : 'border-gray-600/50 bg-gray-700/30 text-gray-300 hover:border-blue-500/50 hover:bg-blue-500/10'
                    }`}
                  >
                    <div className="flex items-center space-x-3">
                      <Search className={`w-5 h-5 ${isCheckingVersions ? 'animate-pulse text-blue-400' : 'text-gray-400'}`} />
                      <div>
                        <div className="text-sm font-medium">
                          {isCheckingVersions ? 'Checking...' : 'Check Versions'}
                        </div>
                        <div className="text-xs text-gray-500">
                          Python & libraries
                        </div>
                      </div>
                    </div>
                  </motion.button>

                  {/* Force Reinstall Button */}
                  <motion.button
                    whileHover={{ scale: 1.02 }}
                    whileTap={{ scale: 0.98 }}
                    onClick={async () => {
                      try {
                        setIsForceReinstalling(true);
                        setSetupProgress(0);
                        setSetupStatus('Preparing force reinstall...');
                        clearLogs();
                        setShowLogPanel(true);
                        addLogMessage('Starting force reinstall of packages...');

                        const window = getCurrentWindow();
                        const unlisten = await window.listen('PYTHON_SETUP_PROGRESS', (event: any) => {
                          const { progress, status } = event.payload;
                          setSetupProgress(progress);
                          setSetupStatus(status);
                          addLogMessage(status);
                        });

                        const result = await invoke('force_reinstall_libraries');
                        logger.info('PythonEnvironment', `Force reinstall result: ${JSON.stringify(result)}`);
                        addLogMessage('Force reinstall completed successfully!', 'success');
                        
                        const status = await invoke('check_environment_status') as any;
                        if (status.environment_ready && status.library_versions) {
                          const formatted = Object.entries(status.library_versions)
                            .map(([lib, version]) => `${lib}: ${version}`)
                            .join('\n');
                          setLibraryVersions(formatted);
                        }
                        
                        unlisten();
                        setTimeout(() => {
                          setIsForceReinstalling(false);
                          setSetupProgress(0);
                          setSetupStatus('');
                        }, 3000);

                      } catch (error) {
                        console.error('Force reinstall failed:', error);
                        const errorMsg = `Reinstall failed: ${error}`;
                        setSetupStatus(errorMsg);
                        addLogMessage(errorMsg, 'error');
                        setTimeout(() => {
                          setIsForceReinstalling(false);
                          setSetupProgress(0);
                          setSetupStatus('');
                        }, 5000);
                      }
                    }}
                    disabled={isForceReinstalling}
                    className={`p-4 rounded-lg border transition-colors text-left ${
                      isForceReinstalling
                        ? 'border-orange-500/50 bg-orange-500/10 text-orange-300 cursor-not-allowed'
                        : 'border-gray-600/50 bg-gray-700/30 text-gray-300 hover:border-orange-500/50 hover:bg-orange-500/10'
                    }`}
                  >
                    <div className="flex items-center space-x-3">
                      <RefreshCw className={`w-5 h-5 ${isForceReinstalling ? 'animate-spin text-orange-400' : 'text-gray-400'}`} />
                      <div>
                        <div className="text-sm font-medium">
                          {isForceReinstalling ? 'Reinstalling...' : 'Force Reinstall'}
                        </div>
                        <div className="text-xs text-gray-500">
                          Refresh all packages
                        </div>
                      </div>
                    </div>
                  </motion.button>

                  {/* Delete Environment Button */}
                  <motion.button
                    whileHover={{ scale: 1.02 }}
                    whileTap={{ scale: 0.98 }}
                    onClick={() => setConfirmDeleteOpen(true)}
                    disabled={isResettingEnv}
                    className={`p-4 rounded-lg border transition-colors text-left ${
                      isResettingEnv
                        ? 'border-red-500/50 bg-red-500/10 text-red-300 cursor-not-allowed'
                        : 'border-gray-600/50 bg-gray-700/30 text-gray-300 hover:border-red-500/50 hover:bg-red-500/10'
                    }`}
                  >
                    <div className="flex items-center space-x-3">
                      <Trash2 className={`w-5 h-5 ${isResettingEnv ? 'animate-pulse text-red-400' : 'text-gray-400'}`} />
                      <div>
                        <div className="text-sm font-medium">
                          {isResettingEnv ? 'Deleting...' : 'Full Reset (Delete Only)'}
                        </div>
                        <div className="text-xs text-gray-500">
                          Remove virtual env
                        </div>
                      </div>
                    </div>
                  </motion.button>
                </div>
              </div>
            </div>
          )}

          {/* Progress Section for Management Actions */}
          {(isForceReinstalling || isResettingEnv) && (
            <motion.div
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: 'auto' }}
              exit={{ opacity: 0, height: 0 }}
              className="p-4 bg-gray-700/30 border border-gray-600/30 rounded-lg"
            >
              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-medium text-gray-300">{setupStatus}</span>
                  <span className="text-xs font-bold text-orange-400">{setupProgress}%</span>
                </div>
                
                <div className="relative w-full bg-gray-600/50 rounded-full h-2 overflow-hidden">
                  <motion.div
                    initial={{ width: 0 }}
                    animate={{ width: `${setupProgress}%` }}
                    transition={{ duration: 0.8, ease: "easeOut" }}
                    className={`h-full rounded-full ${
                      isForceReinstalling 
                        ? 'bg-orange-500'
                        : 'bg-red-500'
                    }`}
                  />
                </div>
              </div>
            </motion.div>
          )}

    {/* Environment Status */}
          {isCheckingEnvironment && (
            <div>
              <label className="block text-sm font-medium text-gray-300 mb-3">Environment Status</label>
              <div className="p-4 bg-gray-700/30 border border-gray-600/30 rounded-lg">
                <div className="flex items-center space-x-3">
                  <Settings2 className="w-5 h-5 text-orange-400 animate-spin" />
                  <span className="text-sm text-gray-300">Checking environment status...</span>
                </div>
              </div>
            </div>
          )}

          {environmentReady && !isCheckingEnvironment && (
            <div>
              <label className="block text-sm font-medium text-gray-300 mb-3">Environment Status</label>
              <div className="p-4 bg-green-500/10 border border-green-500/30 rounded-lg">
                <div className="flex items-center space-x-3">
                    <CheckCircle className="w-5 h-5 text-green-400" />
                  <span className="text-sm font-medium text-green-300">Environment is ready</span>
                </div>
              </div>
            </div>
          )}

    <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
      <div>
              <label className="block text-sm font-medium text-gray-300 mb-2">Virtual Environment</label>
              <div className="px-4 py-3 bg-gray-700/50 border border-gray-600 rounded-lg text-gray-300 font-mono text-xs break-all">{virtualEnvPath || '...'}</div>
            </div>
            
            <div>
              <label className="block text-sm font-medium text-gray-300 mb-2">Required Packages</label>
              <div className="px-4 py-3 bg-gray-700/50 border border-gray-600 rounded-lg text-gray-300">
                edge-tts, torch==2.1.1+cu118, torchaudio==2.1.1+cu118, rvc-python
              </div>
            </div>
          </div>

          {/* Version Information Display */}
          {(pythonVersion || libraryVersions) && !isSettingUpEnv && !isForceReinstalling && !isResettingEnv && (
            <div className="space-y-4">
              <label className="block text-sm font-medium text-gray-300">Version Information</label>
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                {pythonVersion && (
                  <div>
                    <label className="block text-xs font-medium text-gray-400 mb-1">Python Version</label>
                    <div className="px-3 py-2 bg-gray-700/50 border border-gray-600 rounded-lg text-sm text-gray-300 font-mono">
                      {pythonVersion}
                    </div>
                  </div>
                )}
                
                {libraryVersions && (
                  <div>
                    <label className="block text-xs font-medium text-gray-400 mb-1">Library Versions</label>
                    <div className="px-3 py-2 bg-gray-700/50 border border-gray-600 rounded-lg text-sm text-gray-300 font-mono whitespace-pre-wrap">
                      {libraryVersions}
                    </div>
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Logs */}
          <div className="pt-2">
            <div className="flex items-center justify-between mb-2">
              <h3 className="text-lg font-semibold text-white">Logs</h3>
              <motion.button
                whileHover={{ scale: 1.02 }}
                whileTap={{ scale: 0.98 }}
                onClick={() => setShowLogPanel(!showLogPanel)}
                className="flex items-center space-x-2 px-3 py-2 bg-gray-700/50 border border-gray-600 rounded-lg text-gray-300 hover:bg-gray-700 transition-colors"
              >
                <Terminal className="w-4 h-4" />
                <span className="text-sm">{showLogPanel ? 'Hide' : 'Show'}</span>
                {showLogPanel ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
              </motion.button>
            </div>
            <AnimatePresence>
              {showLogPanel && (
                <motion.div
                  initial={{ opacity: 0, height: 0 }}
                  animate={{ opacity: 1, height: 'auto' }}
                  exit={{ opacity: 0, height: 0 }}
                  className="bg-black/50 border border-gray-600 rounded-lg overflow-hidden"
                >
                  <div className="flex items-center justify-between p-3 bg-gray-800/50 border-b border-gray-600">
                    <div className="flex items-center space-x-2">
                      <Terminal className="w-4 h-4 text-green-400" />
                      <span className="text-sm font-medium text-white">Environment Logs</span>
                    </div>
                    <div className="flex items-center space-x-2">
                      <motion.button
                        whileHover={{ scale: 1.02 }}
                        whileTap={{ scale: 0.98 }}
                        onClick={clearLogs}
                        className="px-2 py-1 text-xs bg-gray-700 hover:bg-gray-600 text-gray-300 rounded transition-colors"
                      >
                        Clear
                      </motion.button>
                      <motion.button
                        whileHover={{ scale: 1.02 }}
                        whileTap={{ scale: 0.98 }}
                        onClick={() => setShowLogPanel(false)}
                        className="p-1 hover:bg-gray-700 text-gray-400 hover:text-white rounded transition-colors"
                      >
                        <X className="w-4 h-4" />
                      </motion.button>
                    </div>
                  </div>
                  <div className="p-3 max-h-64 overflow-y-auto">
                    {logMessages.length === 0 ? (
                      <p className="text-gray-500 text-sm">No logs yet...</p>
                    ) : (
                      <div className="space-y-1">
                        {logMessages.map((message, index) => (
                          <div key={index} className="text-xs font-mono text-gray-300 whitespace-pre-wrap">
                            {message}
                          </div>
                        ))}
                        <div ref={logEndRef} />
                      </div>
                    )}
                  </div>
                </motion.div>
              )}
            </AnimatePresence>
          </div>

          {/* Confirm Delete Modal */}
          <AnimatePresence>
            {confirmDeleteOpen && (
              <motion.div
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
              >
                <motion.div
                  initial={{ scale: 0.95, opacity: 0 }}
                  animate={{ scale: 1, opacity: 1 }}
                  exit={{ scale: 0.95, opacity: 0 }}
                  className="w-full max-w-md bg-gray-800 border border-gray-700 rounded-xl shadow-xl overflow-hidden"
                >
                  <div className="p-4 border-b border-gray-700 flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <Trash2 className="w-4 h-4 text-red-400" />
                      <h4 className="text-sm font-semibold text-white">Confirm Full Reset</h4>
                    </div>
                    <button onClick={() => setConfirmDeleteOpen(false)} className="p-1 rounded hover:bg-gray-700">
                      <X className="w-4 h-4 text-gray-400" />
                    </button>
                  </div>
                  <div className="p-4 space-y-2">
                    <p className="text-sm text-gray-300">This will delete the Python virtual environment folder.</p>
                    <p className="text-xs text-gray-400">Packages will not be reinstalled automatically. You can run Setup later.</p>
                  </div>
                  <div className="p-4 bg-gray-900/40 border-t border-gray-700 flex items-center justify-end gap-2">
                    <button
                      onClick={() => setConfirmDeleteOpen(false)}
                      className="px-3 py-1.5 text-sm rounded-lg bg-gray-700 hover:bg-gray-600 text-gray-200 border border-gray-600"
                    >
                      Cancel
                    </button>
                    <button
                      onClick={async () => {
                        setConfirmDeleteOpen(false);
                        try {
                          setIsResettingEnv(true);
                          setSetupProgress(0);
                          setSetupStatus('Preparing environment deletion...');
                          clearLogs();
                          setShowLogPanel(true);
                          addLogMessage('Deleting Python environment...');

                          const window = getCurrentWindow();
                          const unlisten = await window.listen('PYTHON_SETUP_PROGRESS', (event: any) => {
                            const { progress, status } = event.payload;
                            setSetupProgress(progress);
                            setSetupStatus(status);
                            addLogMessage(status);
                          });

                          const result = await invoke('delete_python_environment');
                          logger.info('PythonEnvironment', `Environment deletion result: ${JSON.stringify(result)}`);
                          addLogMessage('Environment deleted successfully!', 'success');

                          setEnvironmentReady(false);
                          setPythonVersion('');
                          setLibraryVersions('');

                          unlisten();
                          setTimeout(() => {
                            setIsResettingEnv(false);
                            setSetupProgress(0);
                            setSetupStatus('');
                          }, 3000);
                        } catch (error) {
                          console.error('Environment deletion failed:', error);
                          const errorMsg = `Deletion failed: ${error}`;
                          setSetupStatus(errorMsg);
                          addLogMessage(errorMsg, 'error');
                          setTimeout(() => {
                            setIsResettingEnv(false);
                            setSetupProgress(0);
                            setSetupStatus('');
                          }, 5000);
                        }
                      }}
                      className="px-3 py-1.5 text-sm rounded-lg bg-red-600 hover:bg-red-700 text-white border border-red-500"
                    >
                      Delete
                    </button>
                  </div>
                </motion.div>
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </div>
    </motion.div>
  );
};

export default PythonEnvironmentTab;
