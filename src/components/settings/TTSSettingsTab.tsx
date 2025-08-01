import { motion } from 'framer-motion';
import { Volume, Sliders, File, X, Play } from 'lucide-react';
import { invoke } from '@tauri-apps/api/core';
import { useEffect } from 'react';
import { useSettingsState } from '../../hooks/useSettingsState';
import { logger } from '../../utils/logger';

interface TTSSettingsTabProps {
  settingsState: ReturnType<typeof useSettingsState>;
}

const TTSSettingsTab = ({ settingsState }: TTSSettingsTabProps) => {
  const {
    ttsMode,
    setTtsMode,
    ttsProvider,
    setTtsProvider,
    ttsVoice,
    setTtsVoice,
    rvcModelFile,
    setRvcModelFile,
    availableModels,
    selectedModel,
    setSelectedModel,
    rvcSettings,
    setRvcSettings,
    saveTtsSettings,
    convertFileToBase64,
    loadAvailableModels,
  } = settingsState;

  // Handle RVC model file upload
  const handleRvcModelUpload = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (file && file.name.endsWith('.pth')) {
      try {
        const base64Data = await convertFileToBase64(file);

        await invoke('save_pth_model', {
          fileName: file.name,
          base64Data: base64Data
        });

        setRvcModelFile(file);
        logger.info('TTSSettings', `Model file saved: pythonenv/models/${file.name}`);
        
        // Refresh the available models list
        await loadAvailableModels();
        
        // Auto-select the newly uploaded model
        setSelectedModel(file.name);
      } catch (error) {
        console.error('Error saving model file:', error);
        alert('Failed to save model file');
      }
    } else {
      alert('Please select a valid .pth model file');
    }
    
    // Clear the input so the same file can be uploaded again if needed
    event.target.value = '';
  };

  // Load available models when component mounts or RVC mode is selected
  useEffect(() => {
    if (ttsMode === 'rvc') {
      loadAvailableModels().catch(error => {
        console.error('Error loading available models:', error);
      });
    }
  }, [ttsMode, loadAvailableModels]);

  // Sync rvcModelFile when selectedModel changes
  useEffect(() => {
    if (selectedModel && rvcModelFile?.name !== selectedModel) {
      // If a different model is selected, clear the rvcModelFile since it represents
      // the currently uploaded file, not the selected saved model
      if (rvcModelFile && rvcModelFile.name !== selectedModel) {
        setRvcModelFile(null);
      }
    }
  }, [selectedModel, rvcModelFile]);

  // Update RVC setting
  const updateRvcSetting = (key: keyof typeof rvcSettings, value: number | boolean | string) => {
    setRvcSettings(prev => ({
      ...prev,
      [key]: value
    }));
  };

  return (
    <motion.div
      initial={{ x: 20, opacity: 0 }}
      animate={{ x: 0, opacity: 1 }}
      transition={{ duration: 0.3 }}
      className="space-y-6"
    >
      <div>
        <h2 className="text-2xl font-bold text-white mb-2">Text to Speech</h2>
        <p className="text-gray-400">Configure TTS engine and voice settings</p>
      </div>

      <div className="bg-gray-800/50 border border-gray-700/50 rounded-2xl p-6">
        <div className="space-y-6">
          {/* TTS Mode Selection */}
          <div>
            <label className="block text-sm font-medium text-gray-300 mb-3">TTS Mode</label>
            <div className="grid grid-cols-2 gap-3">
              <button
                onClick={() => setTtsMode('normal')}
                className={`p-4 rounded-lg border transition-colors ${
                  ttsMode === 'normal'
                    ? 'border-orange-500 bg-orange-500/10 text-orange-300'
                    : 'border-gray-600/50 bg-gray-700/30 text-gray-300 hover:border-gray-500'
                }`}
              >
                <div className="flex items-center space-x-3">
                  <Volume className="w-5 h-5" />
                  <div className="text-left">
                    <div className="text-sm font-medium">Normal TTS</div>
                    <div className="text-xs text-gray-500">Standard text-to-speech</div>
                  </div>
                </div>
              </button>

              <button
                onClick={() => setTtsMode('rvc')}
                className={`p-4 rounded-lg border transition-colors ${
                  ttsMode === 'rvc'
                    ? 'border-orange-500 bg-orange-500/10 text-orange-300'
                    : 'border-gray-600/50 bg-gray-700/30 text-gray-300 hover:border-gray-500'
                }`}
              >
                <div className="flex items-center space-x-3">
                  <Sliders className="w-5 h-5" />
                  <div className="text-left">
                    <div className="text-sm font-medium">RVC Powered</div>
                    <div className="text-xs text-gray-500">AI voice conversion</div>
                  </div>
                </div>
              </button>
            </div>
          </div>

          {/* Normal TTS Settings */}
          <div className="space-y-4">
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium text-gray-300 mb-2">
                  TTS Provider
                </label>
                <select
                  value={ttsProvider}
                  onChange={(e) => setTtsProvider(e.target.value)}
                  className="w-full px-4 py-3 bg-gray-700/50 border border-gray-600 rounded-lg text-white focus:outline-none focus:border-orange-500"
                >
                  <option value="openai">OpenAI</option>
                  <option value="elevenlabs">ElevenLabs</option>
                  <option value="azure">Azure Cognitive Services</option>
                  <option value="google">Google Cloud TTS</option>
                  <option value="aws">AWS Polly</option>
                </select>
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-300 mb-2">
                  Voice
                </label>
                <select
                  value={ttsVoice}
                  onChange={(e) => setTtsVoice(e.target.value)}
                  className="w-full px-4 py-3 bg-gray-700/50 border border-gray-600 rounded-lg text-white focus:outline-none focus:border-orange-500"
                >
                  <option value="Joanna">Joanna</option>
                  <option value="Matthew">Matthew</option>
                  <option value="Ivy">Ivy</option>
                </select>
              </div>
            </div>

            {/* Test TTS Button for Normal Mode */}
            {ttsMode === 'normal' && (
              <div className="flex justify-center pt-4">
                <motion.button
                  whileHover={{ scale: 1.02 }}
                  whileTap={{ scale: 0.98 }}
                  onClick={async () => {
                    try {
                      await invoke('test_tts_normal', {
                        provider: ttsProvider,
                        voice: ttsVoice
                      });
                      logger.info('TTSSettings', 'Normal TTS test initiated');
                    } catch (error) {
                      console.error('Failed to test Normal TTS:', error);
                    }
                  }}
                  className="px-6 py-3 bg-blue-600 hover:bg-blue-700 text-white rounded-lg font-medium transition-colors flex items-center space-x-2"
                >
                  <Play className="w-4 h-4" />
                  <span>Test TTS</span>
                </motion.button>
              </div>
            )}
          </div>

          {/* RVC Settings (only show when RVC mode is selected) */}
          {ttsMode === 'rvc' && (
            <motion.div
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: 'auto' }}
              exit={{ opacity: 0, height: 0 }}
              className="space-y-6 pt-6 border-t border-gray-700/50"
            >
              <div>
                <h3 className="text-lg font-semibold text-white mb-4 flex items-center">
                  <Sliders className="w-5 h-5 mr-2 text-orange-400" />
                  Command Arguments
                </h3>
              </div>

              {/* Model File Upload */}
              <div>
                <label className="block text-sm font-medium text-gray-300 mb-2">
                  RVC Model File (.pth)
                </label>
                <div className="space-y-3">
                  <label className="flex flex-col items-center justify-center w-full h-24 border-2 border-dashed border-gray-600 rounded-lg cursor-pointer hover:border-gray-500 transition-colors">
                    <div className="flex flex-col items-center justify-center">
                      <File className="w-5 h-5 text-gray-400 mb-2" />
                      <p className="text-sm text-gray-400">
                        {rvcModelFile ? rvcModelFile.name : 'Click to upload .pth file'}
                      </p>
                      <p className="text-xs text-gray-500">or drag and drop</p>
                    </div>
                    <input
                      type="file"
                      accept=".pth"
                      onChange={handleRvcModelUpload}
                      className="hidden"
                    />
                  </label>
                  {rvcModelFile && (
                    <div className="flex items-center justify-between p-3 bg-gray-700/30 rounded-lg border border-gray-600/30">
                      <div className="flex items-center space-x-3">
                        <File className="w-4 h-4 text-gray-400" />
                        <div>
                          <span className="text-sm text-gray-200">{rvcModelFile.name}</span>
                          <div className="text-xs text-gray-500">
                            {(rvcModelFile.size / 1024 / 1024).toFixed(2)} MB
                          </div>
                        </div>
                      </div>
                      <button
                        onClick={() => {
                          setRvcModelFile(null);
                          // If this model is currently selected, clear the selection
                          if (selectedModel === rvcModelFile?.name) {
                            setSelectedModel('');
                          }
                        }}
                        className="p-1 text-gray-400 hover:text-red-400 transition-colors"
                      >
                        <X className="w-4 h-4" />
                      </button>
                    </div>
                  )}
                </div>
              </div>

              {/* Model Selection */}
              {availableModels.length > 0 && (
                <div>
                  <label className="block text-sm font-medium text-gray-300 mb-2">
                    Select Active Model
                  </label>
                  <select
                    value={selectedModel || ''}
                    onChange={(e) => setSelectedModel(e.target.value)}
                    className="w-full px-4 py-3 bg-gray-700/50 border border-gray-600 rounded-lg text-white focus:outline-none focus:border-orange-500"
                  >
                    <option value="">Select a model...</option>
                    {availableModels.map((model) => (
                      <option key={model} value={model}>
                        {model}
                      </option>
                    ))}
                  </select>
                  {selectedModel && (
                    <p className="text-xs text-gray-500 mt-2">
                      Active model: {selectedModel}
                    </p>
                  )}
                </div>
              )}

              {/* Command Arguments */}
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                <div className="space-y-4">
                  <div>
                    <label className="block text-sm font-medium text-gray-300 mb-2">
                      Device (-de)
                    </label>
                    <select
                      value={rvcSettings.device}
                      onChange={(e) => updateRvcSetting('device', e.target.value)}
                      className="w-full px-4 py-3 bg-gray-700/50 border border-gray-600 rounded-lg text-white focus:outline-none focus:border-orange-500"
                    >
                      <option value="cuda:0">CUDA GPU (cuda:0)</option>
                      <option value="cpu">CPU</option>
                      <option value="cuda:1">CUDA GPU 1 (cuda:1)</option>
                      <option value="cuda:2">CUDA GPU 2 (cuda:2)</option>
                    </select>
                  </div>

                  <div>
                    <label className="block text-sm font-medium text-gray-300 mb-2">
                      Inference Rate (-ir): {rvcSettings.inferenceRate}
                    </label>
                    <input
                      type="range"
                      min="0"
                      max="1"
                      step="0.01"
                      value={rvcSettings.inferenceRate}
                      onChange={(e) => updateRvcSetting('inferenceRate', parseFloat(e.target.value))}
                      className="w-full h-2 bg-gray-700 rounded-lg appearance-none cursor-pointer"
                    />
                    <p className="text-xs text-gray-500 mt-1">Controls the strength of inference processing</p>
                  </div>

                  <div>
                    <label className="block text-sm font-medium text-gray-300 mb-2">
                      Filter Radius (-fr): {rvcSettings.filterRadius}
                    </label>
                    <input
                      type="range"
                      min="0"
                      max="10"
                      step="1"
                      value={rvcSettings.filterRadius}
                      onChange={(e) => updateRvcSetting('filterRadius', parseInt(e.target.value))}
                      className="w-full h-2 bg-gray-700 rounded-lg appearance-none cursor-pointer"
                    />
                    <p className="text-xs text-gray-500 mt-1">Median filtering radius for noise reduction</p>
                  </div>
                </div>

                <div className="space-y-4">
                  <div>
                    <label className="block text-sm font-medium text-gray-300 mb-2">
                      Resample Rate (-rmr): {rvcSettings.resampleRate}
                    </label>
                    <input
                      type="range"
                      min="0"
                      max="1"
                      step="0.01"
                      value={rvcSettings.resampleRate}
                      onChange={(e) => updateRvcSetting('resampleRate', parseFloat(e.target.value))}
                      className="w-full h-2 bg-gray-700 rounded-lg appearance-none cursor-pointer"
                    />
                    <p className="text-xs text-gray-500 mt-1">Controls audio resampling strength</p>
                  </div>

                  <div>
                    <label className="block text-sm font-medium text-gray-300 mb-2">
                      Protect Rate (-pr): {rvcSettings.protectRate}
                    </label>
                    <input
                      type="range"
                      min="0"
                      max="1"
                      step="0.01"
                      value={rvcSettings.protectRate}
                      onChange={(e) => updateRvcSetting('protectRate', parseFloat(e.target.value))}
                      className="w-full h-2 bg-gray-700 rounded-lg appearance-none cursor-pointer"
                    />
                    <p className="text-xs text-gray-500 mt-1">Protection for consonants and breath sounds</p>
                  </div>

                  <div className="p-4 bg-gray-700/20 rounded-lg border border-gray-600/30">
                    <h5 className="text-sm font-medium text-white mb-2">Generated Command</h5>
                    <code className="text-xs text-gray-300 bg-gray-800/50 p-2 rounded block overflow-x-auto">
                      -de {rvcSettings.device} -ir {rvcSettings.inferenceRate} -fr {rvcSettings.filterRadius} -rmr {rvcSettings.resampleRate} -pr {rvcSettings.protectRate}
                    </code>
                  </div>
                </div>
              </div>

              {/* Test TTS Button for RVC Mode */}
              <div className="flex justify-center pt-6">
                <motion.button
                  whileHover={{ scale: 1.02 }}
                  whileTap={{ scale: 0.98 }}
                  onClick={async () => {
                    try {
                      await invoke('test_tts_rvc', {
                        device: rvcSettings.device,
                        inferenceRate: rvcSettings.inferenceRate,
                        filterRadius: rvcSettings.filterRadius,
                        resampleRate: rvcSettings.resampleRate,
                        protectRate: rvcSettings.protectRate
                      });
                      logger.info('TTSSettings', 'RVC TTS test initiated');
                    } catch (error) {
                      console.error('Failed to test RVC TTS:', error);
                    }
                  }}
                  className="px-6 py-3 bg-purple-600 hover:bg-purple-700 text-white rounded-lg font-medium transition-colors flex items-center space-x-2"
                >
                  <Play className="w-4 h-4" />
                  <span>Test TTS</span>
                </motion.button>
              </div>
            </motion.div>
          )}

          {/* Save Button */}
          <div className="flex justify-end pt-6 border-t border-gray-700/50">
            <motion.button
              whileHover={{ scale: 1.02 }}
              whileTap={{ scale: 0.98 }}
              onClick={saveTtsSettings}
              className="px-6 py-3 bg-orange-600 hover:bg-orange-700 text-white rounded-lg font-medium transition-colors"
            >
              Save TTS Settings
            </motion.button>
          </div>
        </div>
      </div>
    </motion.div>
  );
};

export default TTSSettingsTab;
