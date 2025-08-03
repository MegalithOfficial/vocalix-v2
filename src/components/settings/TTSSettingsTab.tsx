import { motion } from 'framer-motion';
import { Volume, Sliders, File, X, Play } from 'lucide-react';
import { invoke } from '@tauri-apps/api/core';
import { useEffect, useRef, useState } from 'react';
import { listen } from '@tauri-apps/api/event';
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
    availableDevices,
    rvcSettings,
    setRvcSettings,
    saveTtsSettings,
    convertFileToBase64,
    loadAvailableModels,
    loadAvailableDevices,
  } = settingsState;

  const [ttsBusy, setTtsBusy] = useState(false);
  const [ttsProgress, setTtsProgress] = useState(0);
  const [ttsMessage, setTtsMessage] = useState<string>('');
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [lastOutputPath, setLastOutputPath] = useState<string>('');

  // Handle provider change - update voice to default for the provider
  useEffect(() => {
    const edgeTTSVoices = ['en-US-JennyNeural', 'en-US-AriaNeural', 'en-US-GuyNeural', 'en-US-DavisNeural'];
    const openAIVoices = ['alloy', 'echo', 'fable', 'onyx', 'nova', 'shimmer'];

    if (ttsProvider === 'edgetts') {
      if (!edgeTTSVoices.includes(ttsVoice)) {
        setTtsVoice('en-US-JennyNeural');
      }
    } else if (ttsProvider === 'openai') {
      if (!openAIVoices.includes(ttsVoice)) {
        setTtsVoice('alloy');
      }
    }
  }, [ttsProvider, ttsVoice, setTtsVoice]);

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

  // Load available models and devices when RVC mode is selected
  useEffect(() => {
    if (ttsMode === 'rvc') {
      // Load models
      loadAvailableModels().catch(error => {
        console.error('Error loading available models:', error);
      });
      
      // Load devices immediately when RVC mode is selected
      loadAvailableDevices().then(() => {
        // After devices load, if current selected device isn't present, try to fallback
        const cpuFallback = availableDevices.find((d: any) => d.id === 'cpu');
        if (availableDevices.length > 0) {
          const exists = availableDevices.some((d: any) => d.id === rvcSettings.device);
          if (!exists) {
            if (cpuFallback) {
              updateRvcSetting('device', cpuFallback.id);
            } else {
              updateRvcSetting('device', availableDevices[0].id);
            }
          }
        }
      }).catch(error => {
        console.error('Error loading available devices:', error);
      });
    }
  }, [ttsMode]); // Only depend on ttsMode to prevent infinite loops

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

  useEffect(() => {
    let unlisten: undefined | (() => void);
    (async () => {
      try {
        unlisten = await listen<{ progress?: number; status?: string }>('tts_status', (e) => {
          const p = typeof e.payload?.progress === 'number' ? e.payload.progress : undefined;
          const s = typeof e.payload?.status === 'string' ? e.payload.status : undefined;
          if (p !== undefined) setTtsProgress(p);
          if (s) setTtsMessage(s);
          if (s?.startsWith('error')) setTtsBusy(false);
          if (s === 'completed') setTtsBusy(false);
        });
      } catch (err) {
        console.error('Failed to listen to tts_status', err);
      }
    })();
    return () => { if (unlisten) unlisten(); };
  }, []);

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
                  <option value="edgetts">Edge-TTS</option>
                  <option value="openai">OpenAI TTS</option>
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
                  {ttsProvider === 'edgetts' ? (
                    <>
                      <option value="en-US-JennyNeural">en-US-JennyNeural</option>
                      <option value="en-US-AriaNeural">en-US-AriaNeural</option>
                      <option value="en-US-GuyNeural">en-US-GuyNeural</option>
                      <option value="en-US-DavisNeural">en-US-DavisNeural</option>
                    </>
                  ) : (
                    <>
                      <option value="alloy">alloy</option>
                      <option value="echo">echo</option>
                      <option value="fable">fable</option>
                      <option value="onyx">onyx</option>
                      <option value="nova">nova</option>
                      <option value="shimmer">shimmer</option>
                    </>
                  )}
                </select>
              </div>
            </div>

            {/* Test TTS Button for Normal Mode */}
            {ttsMode === 'normal' && (
              <div className="flex justify-center pt-4">
                <motion.button
                  whileHover={!ttsBusy ? { scale: 1.02 } : undefined}
                  whileTap={!ttsBusy ? { scale: 0.98 } : undefined}
                  disabled={ttsBusy}
                  onClick={async () => {
                    setTtsBusy(true);
                    setTtsProgress(0);
                    setTtsMessage('Starting...');
                    try {
                      const res = await invoke('generate_tts', {
                        mode: 'normal',
                        text: 'This is a test of text to speech.',
                        voice: ttsVoice,
                        modelFile: null,
                        device: null,
                        inferenceRate: null,
                        filterRadius: null,
                        resampleRate: null,
                        protectRate: null,
                      }) as { path: string; audio_data: string; mime_type: string };
                      if (audioRef.current) {
                        const audioBlob = new Blob([
                          Uint8Array.from(atob(res.audio_data), c => c.charCodeAt(0))
                        ], { type: res.mime_type });
                        const audioUrl = URL.createObjectURL(audioBlob);
                        audioRef.current.src = audioUrl;
                        setLastOutputPath(audioUrl);
                        await audioRef.current.play().catch(() => {});
                      }
                    } catch (error) {
                      console.error('Failed to test Normal TTS:', error);
                      setTtsBusy(false);
                    }
                  }}
                  className={`px-6 py-3 rounded-lg font-medium transition-colors flex items-center space-x-2 ${ttsBusy ? 'bg-blue-600/50 cursor-not-allowed text-white' : 'bg-blue-600 hover:bg-blue-700 text-white'}`}
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
                {/* Info warning for first-time RVC run */}
                <div className="mt-3 p-3 rounded-lg border border-yellow-700/40 bg-yellow-500/10 text-yellow-200 text-sm">
                  RVC may take longer on the first launch while models and dependencies are prepared. Subsequent runs will be faster.
                </div>
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
                      {availableDevices && availableDevices.length > 0 ? (
                        availableDevices.map((device: any) => (
                          <option key={device.id} value={device.id}>
                            {device.name} ({device.type})
                          </option>
                        ))
                      ) : (
                        <option value="cpu">CPU</option>
                      )}
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
                      {rvcSettings.device !== 'cpu' && `-de {rvcSettings.device} `}
                      -ir {rvcSettings.inferenceRate} -fr {rvcSettings.filterRadius} -rmr {rvcSettings.resampleRate} -pr {rvcSettings.protectRate}
                    </code>
                  </div>
                </div>
              </div>

              {/* Test TTS Button for RVC Mode */}
              <div className="flex justify-center pt-6">
                <motion.button
                  whileHover={!ttsBusy ? { scale: 1.02 } : undefined}
                  whileTap={!ttsBusy ? { scale: 0.98 } : undefined}
                  disabled={ttsBusy}
                  onClick={async () => {
                    setTtsBusy(true);
                    setTtsProgress(0);
                    setTtsMessage('Starting...');
                    try {
                      const res = await invoke('generate_tts', {
                        mode: 'rvc',
                        text: 'This is a test of RVC voice conversion.',
                        voice: 'en-US-JennyNeural',
                        modelFile: selectedModel || null,
                        device: rvcSettings.device || null,
                        inferenceRate: rvcSettings.inferenceRate ?? null,
                        filterRadius: rvcSettings.filterRadius ?? null,
                        resampleRate: rvcSettings.resampleRate ?? null,
                        protectRate: rvcSettings.protectRate ?? null,
                      }) as { path: string; audio_data: string; mime_type: string };
                      if (audioRef.current) {
                        const audioBlob = new Blob([
                          Uint8Array.from(atob(res.audio_data), c => c.charCodeAt(0))
                        ], { type: res.mime_type });
                        const audioUrl = URL.createObjectURL(audioBlob);
                        audioRef.current.src = audioUrl;
                        setLastOutputPath(audioUrl);
                        await audioRef.current.play().catch(() => {});
                      }
                    } catch (error) {
                      console.error('Failed to test RVC TTS:', error);
                      setTtsBusy(false);
                    }
                  }}
                  className={`px-6 py-3 rounded-lg font-medium transition-colors flex items-center space-x-2 ${ttsBusy ? 'bg-purple-600/50 cursor-not-allowed text-white' : 'bg-purple-600 hover:bg-purple-700 text-white'}`}
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

      {/* Inline TTS progress & player */}
      {(ttsBusy || lastOutputPath) && (
        <div className="mt-4 p-4 rounded-xl border border-gray-700 bg-gray-800/60">
          <div className="flex items-center justify-between gap-4">
            <div className="flex-1">
              <div className="text-sm text-gray-300 mb-2">{ttsMessage || (ttsBusy ? 'Processing...' : 'Ready')}</div>
              <div className="w-full h-2 bg-gray-700 rounded">
                <div className={`h-2 rounded ${ttsBusy ? 'bg-orange-500 animate-pulse' : 'bg-green-500'}`} style={{ width: `${ttsBusy ? Math.max(10, ttsProgress) : 100}%`, transition: 'width 150ms ease-out' }} />
              </div>
            </div>
            <div className="flex items-center gap-3">
              <audio ref={audioRef} controls className="h-8" src={lastOutputPath || undefined} />
              {lastOutputPath && (
                <button
                  onClick={() => setLastOutputPath('')}
                  className="px-2 py-1 text-xs rounded bg-gray-700 hover:bg-gray-600 text-gray-200"
                  title="Clear output"
                >
                  Clear
                </button>
              )}
            </div>
          </div>
        </div>
      )}
    </motion.div>
  );
};

export default TTSSettingsTab;
