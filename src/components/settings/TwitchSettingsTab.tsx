import { motion } from 'framer-motion';
import { Award, RefreshCw, X, ChevronUp, Edit2, Settings2, Volume, Timer, Upload, FileAudio } from 'lucide-react';
import { invoke } from '@tauri-apps/api/core';
import TwitchIntegration from '../TwitchIntegration';
import { useSettingsState } from '../../hooks/useSettingsState';
import { log } from '../../utils/logger';

interface TwitchSettingsTabProps {
  settingsState: ReturnType<typeof useSettingsState>;
}

const TwitchSettingsTab = ({ settingsState }: TwitchSettingsTabProps) => {
  const {
    redemptions,
    redemptionConfigs,
    isLoadingRedemptions,
    expandedRedemptionId,
    setExpandedRedemptionId,
    showAddModal,
    setShowAddModal,
    twitchAuthStatus,
    isSavingConfigs,
    isUploadingFiles,
    setIsUploadingFiles,
    loadRedemptions,
    updateRedemptionConfig,
    saveAudioFile,
    //checkTwitchAuthStatus,
  } = settingsState;

  const handleFileUpload = async (redemptionId: string, files: FileList | null) => {
    if (!files) return;

    const redemption = redemptions.find(r => r.id === redemptionId);
    if (!redemption) return;

    const audioFiles = Array.from(files).filter(file =>
      file.type.startsWith('audio/') && file.name.endsWith('.mp3')
    );

    if (audioFiles.length === 0) return;

    setIsUploadingFiles(true);

    try {
      const currentConfig = redemptionConfigs[redemptionId];
      const currentFileCount = currentConfig?.staticFiles?.length || 0;

      const savedFileNames: string[] = [];
      const mockFiles: File[] = [];

      for (let i = 0; i < audioFiles.length; i++) {
        const file = audioFiles[i];
        const fileIndex = currentFileCount + i;
        const success = await saveAudioFile(redemption.title, file, fileIndex);

        if (success) {
          const fileName = `${redemption.title.replace(/[^a-zA-Z0-9]/g, '_')}-${fileIndex + 1}.mp3`;
          savedFileNames.push(fileName);

          const mockFile = {
            name: fileName,
            size: file.size,
            type: file.type,
            lastModified: Date.now()
          } as File;
          mockFiles.push(mockFile);
        }
      }

      updateRedemptionConfig(redemptionId, {
        staticFiles: [...(currentConfig?.staticFiles || []), ...mockFiles],
        staticFileNames: [...(currentConfig?.staticFileNames || []), ...savedFileNames]
      });

      log('TwitchSettings', `Uploaded ${savedFileNames.length} files for redemption: ${redemption.title}`);
    } catch (error) {
      console.error('Error uploading files:', error);
    } finally {
      setIsUploadingFiles(false);
    }
  };

  const removeStaticFile = async (redemptionId: string, fileIndex: number) => {
    const currentConfig = redemptionConfigs[redemptionId];
    if (!currentConfig) return;

    const currentFiles = currentConfig.staticFiles || [];
    const currentFileNames = currentConfig.staticFileNames || [];

    if (fileIndex >= 0 && fileIndex < currentFiles.length) {
      const fileNameToRemove = currentFileNames[fileIndex];

      try {
        if (fileNameToRemove) {
          const redemption = redemptions.find(r => r.id === redemptionId);
          if (redemption) {
            await invoke('delete_audio_file', {
              redemptionName: redemption.title.replace(/[^a-zA-Z0-9]/g, '_'),
              fileName: fileNameToRemove
            });
            log('TwitchSettings', `Deleted file from backend: ${fileNameToRemove}`);
          }
        }
      } catch (error) {
        console.error('Error deleting file from backend:', error);
      }

      const updatedFiles = currentFiles.filter((_, index) => index !== fileIndex);
      const updatedFileNames = currentFileNames.filter((_, index) => index !== fileIndex);

      updateRedemptionConfig(redemptionId, {
        staticFiles: updatedFiles,
        staticFileNames: updatedFileNames
      });
    }
  };

  const formatTimer = (value: string): string => {
    const digits = value.replace(/\D/g, '');

    if (digits.length <= 2) {
      return `00:${digits.padStart(2, '0')}`;
    } else if (digits.length <= 4) {
      const minutes = digits.slice(0, -2);
      const seconds = digits.slice(-2);
      return `${minutes.padStart(2, '0')}:${seconds}`;
    } else {
      const minutes = digits.slice(0, 2);
      const seconds = digits.slice(2, 4);
      return `${minutes}:${seconds}`;
    }
  };

  return (
    <motion.div
      initial={{ x: 20, opacity: 0 }}
      animate={{ x: 0, opacity: 1 }}
      transition={{ duration: 0.3 }}
      className="space-y-8"
    >
      <div>
        <h2 className="text-2xl font-bold text-white mb-2">Twitch Integration</h2>
        <p className="text-gray-400">Configure your Twitch channel point redemptions and authentication</p>
      </div>

      <TwitchIntegration />

      {/* Redemptions Manager - Only show if Twitch is properly configured */}
      {twitchAuthStatus === 'ready' && (
        <div className="space-y-6">
          <div className="flex items-center justify-between mb-6">
            <div>
              <div className="flex items-center space-x-3 mb-2">
                <div className="w-12 h-12 bg-purple-500/20 rounded-xl flex items-center justify-center mr-4">
                  <Award className="w-6 h-6 text-purple-400" />
                </div>
                <div>
                  <h2 className="text-xl font-bold text-white">Redemptions Manager</h2>
                  <p className="text-gray-400 text-sm">Configure Twitch channel point redemptions</p>
                </div>
                {isSavingConfigs && (
                  <div className="flex items-center space-x-2 text-sm text-gray-400">
                    <div className="w-3 h-3 border border-gray-400 border-t-transparent rounded-full animate-spin" />
                    <span>Saving...</span>
                  </div>
                )}
                {isUploadingFiles && (
                  <div className="flex items-center space-x-2 text-sm text-blue-400">
                    <div className="w-3 h-3 border border-blue-400 border-t-transparent rounded-full animate-spin" />
                    <span>Uploading files...</span>
                  </div>
                )}
              </div>
            </div>

            <motion.button
              whileHover={{ scale: 1.05 }}
              whileTap={{ scale: 0.95 }}
              onClick={loadRedemptions}
              disabled={isLoadingRedemptions}
              className="p-2 bg-gray-700 hover:bg-gray-600 disabled:bg-gray-600 text-white rounded-lg transition-colors"
              title="Refresh redemptions"
            >
              {isLoadingRedemptions ? (
                <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
              ) : (
                <RefreshCw className="w-4 h-4" />
              )}
            </motion.button>
          </div>

          {/* Redemption Cards */}
          {redemptions.length > 0 && (
            <div className="space-y-6">
              {/* Configured Redemptions */}
              {Object.entries(redemptionConfigs)
                .filter(([_, config]) => config.enabled)
                .map(([redemptionId, config]) => {
                  const redemption = redemptions.find(r => r.id === redemptionId);
                  if (!redemption) return null;

                  const isExpanded = expandedRedemptionId === redemption.id;

                  return (
                    <motion.div
                      key={redemption.id}
                      initial={{ opacity: 0, y: 10 }}
                      animate={{ opacity: 1, y: 0 }}
                      className="bg-gray-800/40 border border-gray-700/50 rounded-xl overflow-hidden"
                    >
                      {/* Card Header */}
                      <div className="p-4">
                        <div className="flex items-center justify-between">
                          <div className="flex items-center space-x-4">
                            <div className="w-3 h-3 rounded-full bg-green-400" />
                            <div>
                              <h4 className="text-white font-semibold text-lg">{redemption.title}</h4>
                              <div className="flex items-center space-x-3 text-sm text-gray-400">
                                <span>{redemption.cost} points</span>
                                <span>•</span>
                                <span>{redemption.is_enabled ? 'Active' : 'Disabled'}</span>
                                <span>•</span>
                                <span className="text-green-400">Configured</span>
                              </div>
                              {redemption.prompt && (
                                <p className="text-gray-500 text-sm mt-1">{redemption.prompt}</p>
                              )}
                            </div>
                          </div>

                          <div className="flex items-center space-x-2">
                            <motion.button
                              whileHover={{ scale: 1.05 }}
                              whileTap={{ scale: 0.95 }}
                              onClick={() => updateRedemptionConfig(redemption.id, { enabled: false })}
                              className="p-2 text-red-400 hover:text-red-300 hover:bg-red-400/10 rounded-lg transition-colors"
                              title="Remove configuration"
                            >
                              <X className="w-4 h-4" />
                            </motion.button>

                            <motion.button
                              whileHover={{ scale: 1.05 }}
                              whileTap={{ scale: 0.95 }}
                              onClick={() => setExpandedRedemptionId(isExpanded ? '' : redemption.id)}
                              className="p-2 rounded-lg transition-colors text-green-400 hover:text-green-300 hover:bg-green-400/10"
                              title="Edit configuration"
                            >
                              {isExpanded ? (
                                <ChevronUp className="w-4 h-4" />
                              ) : (
                                <Edit2 className="w-4 h-4" />
                              )}
                            </motion.button>
                          </div>
                        </div>
                      </div>

                      {/* Expanded Configuration Panel */}
                      {isExpanded && (
                        <motion.div
                          initial={{ height: 0, opacity: 0 }}
                          animate={{ height: 'auto', opacity: 1 }}
                          exit={{ height: 0, opacity: 0 }}
                          className="border-t border-gray-700/50"
                        >
                          <div className="p-6 space-y-6">
                            {/* TTS Configuration */}
                            <div className="space-y-4">
                              <div className="flex items-center space-x-2">
                                <Volume className="w-4 h-4 text-gray-400" />
                                <h5 className="text-sm font-semibold text-white">Text-to-Speech Response</h5>
                              </div>

                              <div className="grid grid-cols-2 gap-3">
                                <button
                                  onClick={() => updateRedemptionConfig(redemption.id, { ttsType: 'dynamic' })}
                                  className={`p-3 rounded-lg border transition-colors ${config.ttsType === 'dynamic'
                                    ? 'border-purple-500 bg-purple-500/10 text-purple-300'
                                    : 'border-gray-600/50 bg-gray-700/30 text-gray-300 hover:border-gray-500'
                                    }`}
                                >
                                  <div className="text-sm font-medium">Dynamic TTS</div>
                                  <div className="text-xs text-gray-500">Template based</div>
                                </button>

                                <button
                                  onClick={() => updateRedemptionConfig(redemption.id, { ttsType: 'static' })}
                                  className={`p-3 rounded-lg border transition-colors ${config.ttsType === 'static'
                                    ? 'border-purple-500 bg-purple-500/10 text-purple-300'
                                    : 'border-gray-600/50 bg-gray-700/30 text-gray-300 hover:border-gray-500'
                                    }`}
                                >
                                  <div className="text-sm font-medium">Static Audio</div>
                                  <div className="text-xs text-gray-500">Upload files</div>
                                </button>
                              </div>

                              {config.ttsType === 'dynamic' ? (
                                <div className="space-y-3">
                                  <label className="block text-sm font-medium text-gray-300">
                                    Template String
                                  </label>
                                  <input
                                    type="text"
                                    value={config.dynamicTemplate}
                                    onChange={(e) => updateRedemptionConfig(redemption.id, { dynamicTemplate: e.target.value })}
                                    placeholder="[[USER]] said: [[MESSAGE]]"
                                    className="w-full px-3 py-2 bg-gray-700/50 border border-gray-600 rounded-lg text-white placeholder-gray-500 focus:outline-none focus:border-purple-500 transition-colors"
                                  />
                                  <p className="text-xs text-gray-500">
                                    Use [[USER]] for username and [[MESSAGE]] for redemption message
                                  </p>
                                </div>
                              ) : (
                                <div className="space-y-3">
                                  <label className="block text-sm font-medium text-gray-300">
                                    Audio Files
                                  </label>
                                  <p className="text-xs text-gray-500 mb-2">
                                    Audio files are saved to the backend in static_audios/&lt;redemption_name&gt;/ folder.
                                  </p>
                                  <label className="flex flex-col items-center justify-center w-full h-24 border-2 border-dashed border-gray-600 rounded-lg cursor-pointer hover:border-gray-500 transition-colors">
                                    <div className="flex flex-col items-center justify-center">
                                      <Upload className="w-5 h-5 text-gray-400 mb-2" />
                                      <p className="text-sm text-gray-400">Click to upload MP3 files</p>
                                      <p className="text-xs text-gray-500">or drag and drop</p>
                                    </div>
                                    <input
                                      type="file"
                                      multiple
                                      accept=".mp3,audio/mpeg"
                                      onChange={(e) => handleFileUpload(redemption.id, e.target.files)}
                                      className="hidden"
                                    />
                                  </label>

                                  {config.staticFiles.length > 0 && (
                                    <div className="space-y-2 max-h-32 overflow-y-auto">
                                      {config.staticFiles.map((file, index) => (
                                        <div key={index} className="flex items-center justify-between p-3 bg-gray-700/30 rounded-lg border border-gray-600/30">
                                          <div className="flex items-center space-x-3">
                                            <FileAudio className="w-4 h-4 text-gray-400" />
                                            <div>
                                              <span className="text-sm text-gray-200">{file.name}</span>
                                              <div className="text-xs text-gray-500">{(file.size / 1024 / 1024).toFixed(2)} MB</div>
                                            </div>
                                          </div>
                                          <button
                                            onClick={() => removeStaticFile(redemption.id, index)}
                                            className="p-1 text-gray-400 hover:text-red-400 transition-colors"
                                          >
                                            <X className="w-4 h-4" />
                                          </button>
                                        </div>
                                      ))}
                                    </div>
                                  )}
                                </div>
                              )}
                            </div>

                            {/* Timer Configuration */}
                            <div className="space-y-4">
                              <div className="flex items-center justify-between">
                                <div className="flex items-center space-x-2">
                                  <Timer className="w-4 h-4 text-gray-400" />
                                  <h5 className="text-sm font-semibold text-white">Timer</h5>
                                  <span className="text-xs text-gray-500">(Optional)</span>
                                </div>
                                <motion.button
                                  whileTap={{ scale: 0.95 }}
                                  onClick={() => updateRedemptionConfig(redemption.id, { timerEnabled: !config.timerEnabled })}
                                  className={`relative w-10 h-5 rounded-full transition-colors ${config.timerEnabled ? 'bg-purple-600' : 'bg-gray-600'
                                    }`}
                                >
                                  <motion.div
                                    animate={{ x: config.timerEnabled ? 20 : 0 }}
                                    transition={{ type: "spring", stiffness: 500, damping: 30 }}
                                    className="absolute top-0.5 left-0.5 w-4 h-4 bg-white rounded-full"
                                  />
                                </motion.button>
                              </div>

                              {config.timerEnabled && (
                                <div className="flex items-center space-x-3 p-3 bg-gray-700/30 rounded-lg border border-gray-600/30">
                                  <label className="text-sm font-medium text-gray-300 whitespace-nowrap">
                                    Duration:
                                  </label>
                                  <div className="flex items-center space-x-2">
                                    <input
                                      type="text"
                                      value={config.timerDuration}
                                      onChange={(e) => updateRedemptionConfig(redemption.id, { timerDuration: formatTimer(e.target.value) })}
                                      placeholder="00:30"
                                      className="w-20 px-2 py-1 bg-gray-600/50 border border-gray-500/50 rounded text-white text-center font-mono text-sm focus:outline-none focus:border-purple-500 transition-colors"
                                    />
                                    <span className="text-xs text-gray-400">(MM:SS)</span>
                                  </div>
                                </div>
                              )}
                            </div>

                            {/* Action Buttons */}
                            <div className="flex justify-end space-x-3 pt-4 border-t border-gray-700/50">
                              <button
                                onClick={() => setExpandedRedemptionId('')}
                                className="px-4 py-2 text-gray-400 hover:text-white transition-colors"
                              >
                                Cancel
                              </button>
                              <motion.button
                                whileHover={{ scale: config.ttsType === 'static' && config.staticFiles.length === 0 ? 1 : 1.02 }}
                                whileTap={{ scale: config.ttsType === 'static' && config.staticFiles.length === 0 ? 1 : 0.98 }}
                                onClick={() => {
                                  if (config.ttsType === 'static' && config.staticFiles.length === 0) {
                                    return;
                                  }
                                  updateRedemptionConfig(redemption.id, { enabled: true });
                                  setExpandedRedemptionId('');
                                }}
                                disabled={config.ttsType === 'static' && config.staticFiles.length === 0}
                                className={`px-6 py-2 rounded-lg transition-colors font-medium ${config.ttsType === 'static' && config.staticFiles.length === 0
                                  ? 'bg-gray-600 text-gray-400 cursor-not-allowed'
                                  : 'bg-purple-600 hover:bg-purple-700 text-white'
                                  }`}
                                title={config.ttsType === 'static' && config.staticFiles.length === 0 ? 'Please upload at least one MP3 file' : ''}
                              >
                                Update Configuration
                              </motion.button>
                            </div>
                          </div>
                        </motion.div>
                      )}
                    </motion.div>
                  );
                })}

              {/* Add New Redemption Modal Button */}
              <motion.div
                whileHover={{ scale: 1.02 }}
                whileTap={{ scale: 0.98 }}
                onClick={() => setShowAddModal(true)}
                className="bg-gray-800/30 border-2 border-dashed border-gray-600/50 hover:border-purple-500/50 rounded-xl p-6 cursor-pointer transition-all group"
              >
                <div className="text-center">
                  <div className="w-12 h-12 bg-purple-600/20 group-hover:bg-purple-600/30 rounded-xl flex items-center justify-center mx-auto mb-4 transition-colors">
                    <Settings2 className="w-6 h-6 text-purple-400" />
                  </div>
                  <h4 className="text-lg font-semibold text-white mb-2 group-hover:text-purple-300 transition-colors">Add Redemption</h4>
                  <p className="text-gray-400 text-sm group-hover:text-gray-300 transition-colors">
                    Configure a new redemption for audio responses
                  </p>
                </div>
              </motion.div>
            </div>
          )}

          {/* Add Redemption Modal */}
          {showAddModal && (
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="fixed inset-0 bg-black/60 backdrop-blur-sm z-50 flex items-center justify-center p-4"
              onClick={(e) => e.target === e.currentTarget && setShowAddModal(false)}
            >
              <motion.div
                initial={{ scale: 0.9, opacity: 0 }}
                animate={{ scale: 1, opacity: 1 }}
                exit={{ scale: 0.9, opacity: 0 }}
                className="bg-gray-800 border border-gray-700/50 rounded-2xl p-6 w-full max-w-2xl max-h-[80vh] overflow-y-auto"
              >
                <div className="flex items-center justify-between mb-6">
                  <div className="flex items-center space-x-3">
                    <div className="w-10 h-10 bg-purple-600/20 rounded-lg flex items-center justify-center">
                      <Settings2 className="w-5 h-5 text-purple-400" />
                    </div>
                    <div>
                      <h3 className="text-xl font-semibold text-white">Add Redemption</h3>
                      <p className="text-gray-400 text-sm">Choose a redemption to configure</p>
                    </div>
                  </div>
                  <button
                    onClick={() => setShowAddModal(false)}
                    className="p-2 text-gray-400 hover:text-white hover:bg-gray-700/50 rounded-lg transition-colors"
                  >
                    <X className="w-5 h-5" />
                  </button>
                </div>

                <div className="space-y-3">
                  {redemptions
                    .filter(redemption => !redemptionConfigs[redemption.id]?.enabled)
                    .map((redemption) => (
                      <motion.div
                        key={redemption.id}
                        whileHover={{ scale: 1.02 }}
                        whileTap={{ scale: 0.98 }}
                        onClick={() => {
                          updateRedemptionConfig(redemption.id, { enabled: true });
                          setExpandedRedemptionId(redemption.id);
                          setShowAddModal(false);
                        }}
                        className="p-4 bg-gray-700/30 hover:bg-gray-700/50 border border-gray-600/30 hover:border-purple-500/30 rounded-xl cursor-pointer transition-all group"
                      >
                        <div className="flex items-center justify-between">
                          <div className="flex items-center space-x-4">
                            <div className={`w-3 h-3 rounded-full ${redemption.is_enabled ? 'bg-purple-400' : 'bg-gray-500'
                              }`} />
                            <div>
                              <h4 className="text-white font-medium group-hover:text-purple-300 transition-colors">
                                {redemption.title}
                              </h4>
                              <div className="flex items-center space-x-3 text-sm text-gray-400">
                                <span>{redemption.cost} points</span>
                                <span>•</span>
                                <span>{redemption.is_enabled ? 'Active' : 'Disabled'}</span>
                              </div>
                              {redemption.prompt && (
                                <p className="text-gray-500 text-sm mt-1">{redemption.prompt}</p>
                              )}
                            </div>
                          </div>
                          <div className="text-purple-400 group-hover:text-purple-300 transition-colors">
                            <ChevronUp className="w-5 h-5 rotate-90" />
                          </div>
                        </div>
                      </motion.div>
                    ))
                  }

                  {redemptions.filter(redemption => !redemptionConfigs[redemption.id]?.enabled).length === 0 && (
                    <div className="text-center py-8">
                      <div className="w-16 h-16 bg-gray-700/30 rounded-xl flex items-center justify-center mx-auto mb-4">
                        <Award className="w-8 h-8 text-gray-400" />
                      </div>
                      <h4 className="text-lg font-medium text-white mb-2">All Redemptions Configured</h4>
                      <p className="text-gray-400 text-sm">
                        You've configured all available redemptions. Create more on Twitch to add additional responses.
                      </p>
                    </div>
                  )}
                </div>
              </motion.div>
            </motion.div>
          )}

          {/* Empty state messages */}
          {redemptions.length > 0 &&
            Object.entries(redemptionConfigs).filter(([_, config]) => config.enabled).length === 0 &&
            redemptions.filter(redemption => !redemptionConfigs[redemption.id]?.enabled).length === 0 && (
              <div className="text-center py-12 bg-gray-800/30 border-2 border-dashed border-gray-600/50 rounded-xl">
                <div className="w-16 h-16 bg-gray-700/50 rounded-xl flex items-center justify-center mx-auto mb-4">
                  <Award className="w-8 h-8 text-gray-400" />
                </div>
                <h4 className="text-lg font-semibold text-white mb-2">All Redemptions Configured</h4>
                <p className="text-gray-400 max-w-sm mx-auto">
                  You've configured all available redemptions. Create more on Twitch to add additional responses.
                </p>
              </div>
            )}

          {redemptions.length === 0 && !isLoadingRedemptions && (
            <div className="text-center py-12 bg-gray-800/30 border-2 border-dashed border-gray-600/50 rounded-xl">
              <div className="w-16 h-16 bg-gray-700/50 rounded-xl flex items-center justify-center mx-auto mb-4">
                <Award className="w-8 h-8 text-gray-400" />
              </div>
              <h4 className="text-lg font-semibold text-white mb-2">No Redemptions Found</h4>
              <p className="text-gray-400 max-w-sm mx-auto">
                Create some channel point redemptions on Twitch to get started with audio responses.
              </p>
            </div>
          )}

          {twitchAuthStatus !== 'ready' && (
            <div className="text-center py-12 bg-gray-800/30 border-2 border-dashed border-gray-600/50 rounded-xl">
              <div className="w-16 h-16 bg-gray-700/50 rounded-xl flex items-center justify-center mx-auto mb-4">
                <Award className="w-8 h-8 text-gray-400" />
              </div>
              <h4 className="text-lg font-semibold text-white mb-2">
                {twitchAuthStatus === 'checking' ? 'Checking Authentication...' : 'Twitch Authentication Required'}
              </h4>
              <p className="text-gray-400 max-w-sm mx-auto">
                {twitchAuthStatus === 'checking'
                  ? 'Please wait while we verify your Twitch connection'
                  : 'Please complete Twitch authentication above to access redemption management features'
                }
              </p>
            </div>
          )}
        </div>
      )}
    </motion.div>
  );
};

export default TwitchSettingsTab;
