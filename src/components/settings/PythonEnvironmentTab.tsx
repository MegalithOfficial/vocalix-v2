import { motion } from 'framer-motion';
import { Settings2, RefreshCw, Search, Trash2 } from 'lucide-react';
import { invoke } from '@tauri-apps/api/core';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { useSettingsState } from '../../hooks/useSettingsState';
import { logger } from '../../utils/logger';

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

  return (
    <motion.div
      initial={{ x: 20, opacity: 0 }}
      animate={{ x: 0, opacity: 1 }}
      transition={{ duration: 0.3 }}
      className="space-y-6"
    >
      <div>
        <h2 className="text-2xl font-bold text-white mb-2">Python Environment</h2>
        <p className="text-gray-400">Set up Python environment and dependencies for TTS functionality</p>
      </div>

      <div className="bg-gray-800/50 border border-gray-700/50 rounded-2xl p-6">
        <div className="space-y-6">
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
                      : 'Check for Python 3.10+, create virtual environment, and install required packages'
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

                        const window = getCurrentWindow();
                        const unlisten = await window.listen('PYTHON_SETUP_PROGRESS', (event: any) => {
                          const { progress, status } = event.payload;
                          setSetupProgress(progress);
                          setSetupStatus(status);
                        });

                        try {
                          const result = await invoke('setup_python_environment');
                          logger.info('PythonEnvironment', `Python environment setup result: ${JSON.stringify(result)}`);
                          
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
                          setSetupStatus(`Setup failed: ${error}`);
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

          {/* Environment Status Loading */}
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

          {/* Environment Ready Status */}
          {environmentReady && !isCheckingEnvironment && (
            <div>
              <label className="block text-sm font-medium text-gray-300 mb-3">Environment Status</label>
              <div className="p-4 bg-green-500/10 border border-green-500/30 rounded-lg">
                <div className="flex items-center space-x-3">
                  <div className="w-5 h-5 bg-green-500 rounded-full flex items-center justify-center">
                    <svg className="w-3 h-3 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                    </svg>
                  </div>
                  <span className="text-sm font-medium text-green-300">Environment is ready</span>
                </div>
              </div>
            </div>
          )}

          {/* Environment Information */}
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
            <div>
              <label className="block text-sm font-medium text-gray-300 mb-2">Python Version</label>
              <div className="px-4 py-3 bg-gray-700/50 border border-gray-600 rounded-lg text-gray-300">
                Requires 3.10+
              </div>
            </div>
            
            <div>
              <label className="block text-sm font-medium text-gray-300 mb-2">Virtual Environment</label>
              <div className="px-4 py-3 bg-gray-700/50 border border-gray-600 rounded-lg text-gray-300">
                ./pythonenv
              </div>
            </div>
            
            <div>
              <label className="block text-sm font-medium text-gray-300 mb-2">Required Packages</label>
              <div className="px-4 py-3 bg-gray-700/50 border border-gray-600 rounded-lg text-gray-300">
                edge-tts, rvc-python
              </div>
            </div>
          </div>

          {/* Environment Management Actions */}
          {!isSettingUpEnv && !isForceReinstalling && !isResettingEnv && (
            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-300 mb-3">Environment Management</label>
                <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
                  {/* Check Versions Button */}
                  <motion.button
                    whileHover={{ scale: 1.02 }}
                    whileTap={{ scale: 0.98 }}
                    onClick={async () => {
                      try {
                        setIsCheckingVersions(true);
                        const status = await invoke('check_environment_status') as any;
                        
                        if (status.environment_ready) {
                          if (status.python_version) {
                            setPythonVersion(status.python_version);
                          }
                          if (status.library_versions) {
                            const formatted = Object.entries(status.library_versions)
                              .map(([lib, version]) => `${lib}: ${version}`)
                              .join('\n');
                            setLibraryVersions(formatted);
                          }
                        } else {
                          setLibraryVersions('Environment not ready');
                          setPythonVersion('Not available');
                        }
                      } catch (error) {
                        console.error('Version check failed:', error);
                        setLibraryVersions(`Error: ${error}`);
                        setPythonVersion('Error');
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

                        const window = getCurrentWindow();
                        const unlisten = await window.listen('PYTHON_SETUP_PROGRESS', (event: any) => {
                          const { progress, status } = event.payload;
                          setSetupProgress(progress);
                          setSetupStatus(status);
                        });

                        const result = await invoke('force_reinstall_libraries');
                        logger.info('PythonEnvironment', `Force reinstall result: ${JSON.stringify(result)}`);
                        
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
                        setSetupStatus(`Reinstall failed: ${error}`);
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

                  {/* Full Reset Button */}
                  <motion.button
                    whileHover={{ scale: 1.02 }}
                    whileTap={{ scale: 0.98 }}
                    onClick={async () => {
                      try {
                        setIsResettingEnv(true);
                        setSetupProgress(0);
                        setSetupStatus('Preparing environment reset...');

                        const window = getCurrentWindow();
                        const unlisten = await window.listen('PYTHON_SETUP_PROGRESS', (event: any) => {
                          const { progress, status } = event.payload;
                          setSetupProgress(progress);
                          setSetupStatus(status);
                        });

                        const result = await invoke('reset_python_environment');
                        logger.info('PythonEnvironment', `Environment reset result: ${JSON.stringify(result)}`);
                        
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
                        } else {
                          setEnvironmentReady(false);
                          setPythonVersion('');
                          setLibraryVersions('');
                        }
                        
                        unlisten();
                        setTimeout(() => {
                          setIsResettingEnv(false);
                          setSetupProgress(0);
                          setSetupStatus('');
                        }, 3000);

                      } catch (error) {
                        console.error('Environment reset failed:', error);
                        setSetupStatus(`Reset failed: ${error}`);
                        setTimeout(() => {
                          setIsResettingEnv(false);
                          setSetupProgress(0);
                          setSetupStatus('');
                        }, 5000);
                      }
                    }}
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
                          {isResettingEnv ? 'Resetting...' : 'Full Reset'}
                        </div>
                        <div className="text-xs text-gray-500">
                          Fresh environment
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
        </div>
      </div>
    </motion.div>
  );
};

export default PythonEnvironmentTab;
