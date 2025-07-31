import { motion } from 'framer-motion';
import { useState, useEffect, useRef } from 'react';
import { ArrowLeft, Volume2, Shield, Palette, Play, Pause, Twitch, Settings, Upload, X, Timer, Volume, FileAudio, Award, Edit2 } from 'lucide-react';
import { Link } from 'react-router-dom';
import '../components/VolumeSlider.css';
import { AudioQuality, getAudioQualitySettings, getAudioSettingsForBackend } from '../utils/audioSettings';
import TwitchIntegration from '../components/TwitchIntegration';
import { invoke } from '@tauri-apps/api/core';

type SettingsTab = 'twitch' | 'audio' | 'security' | 'appearance';

interface TwitchRedemption {
   id: string;
   title: string;
   cost: number;
   enabled: boolean;
   is_enabled: boolean;
   prompt?: string;
}

interface RedemptionConfig {
   enabled: boolean;
   ttsType: 'dynamic' | 'static';
   dynamicTemplate: string;
   staticFiles: File[];
   timerEnabled: boolean;
   timerDuration: string; // MM:SS format
}

const SettingsPage = () => {
   const [activeTab, setActiveTab] = useState<SettingsTab>('twitch');
   const [audioQuality, setAudioQuality] = useState<AudioQuality>('high');
   const [autoAccept, setAutoAccept] = useState(false);
   const [manualConfirm, setManualConfirm] = useState(true);
   const [theme, setTheme] = useState('dark');
   const [outputDevices, setOutputDevices] = useState<MediaDeviceInfo[]>([]);
   const [selectedOutputDevice, setSelectedOutputDevice] = useState('default');
   const [volume, setVolume] = useState(50);
   const [isTestPlaying, setIsTestPlaying] = useState(false);
   const audioRef = useRef<HTMLAudioElement | null>(null);

   // Redemptions Manager State
   const [redemptions, setRedemptions] = useState<TwitchRedemption[]>([]);
   const [redemptionConfigs, setRedemptionConfigs] = useState<Record<string, RedemptionConfig>>({});
   const [isLoadingRedemptions, setIsLoadingRedemptions] = useState(false);
   const [selectedRedemptionId, setSelectedRedemptionId] = useState<string>('');
   const [showCreateForm, setShowCreateForm] = useState(false);
   const [editingConfigId, setEditingConfigId] = useState<string>('');
      const [twitchAuthStatus, setTwitchAuthStatus] = useState<'checking' | 'needs_credentials' | 'needs_auth' | 'authenticating' | 'ready' | 'error'>('checking');

   // Debug: Log when twitchAuthStatus changes
   useEffect(() => {
      console.log('SettingsPage: twitchAuthStatus changed to:', twitchAuthStatus);
   }, [twitchAuthStatus]);

   const tabs = [
      { id: 'twitch' as SettingsTab, label: 'Twitch Integration', icon: Twitch, color: 'purple' },
      { id: 'audio' as SettingsTab, label: 'Audio Settings', icon: Volume2, color: 'blue' },
      { id: 'security' as SettingsTab, label: 'Security & Privacy', icon: Shield, color: 'green' },
      { id: 'appearance' as SettingsTab, label: 'Appearance', icon: Palette, color: 'pink' },
   ];

   const checkTwitchAuthStatus = async () => {
      try {
         const status = await invoke('twitch_get_auth_status') as string;
         console.log('SettingsPage: Received auth status:', status);
         if (status === 'no_credentials') {
            setTwitchAuthStatus('needs_credentials');
         } else if (status === 'valid') {
            setTwitchAuthStatus('ready');
         } else {
            setTwitchAuthStatus('checking');
         }
      } catch (error) {
         console.error('Error checking Twitch auth status:', error);
         setTwitchAuthStatus('needs_credentials');
      }
   };

   useEffect(() => {
      const loadAudioDevices = async () => {
         try {
            await navigator.mediaDevices.getUserMedia({ audio: true }).then(stream => {
               stream.getTracks().forEach(track => track.stop());
            });

            const devices = await navigator.mediaDevices.enumerateDevices();
            const audioOutputs = devices.filter(device => device.kind === 'audiooutput');
            setOutputDevices(audioOutputs);
         } catch (error) {
            console.error('Error loading audio devices:', error);
            const devices = await navigator.mediaDevices.enumerateDevices();
            const audioOutputs = devices.filter(device => device.kind === 'audiooutput');
            setOutputDevices(audioOutputs);
         }
      };

      loadAudioDevices();
      checkTwitchAuthStatus();

      // Set up periodic auth status checking
      const authCheckInterval = setInterval(checkTwitchAuthStatus, 5000); // Check every 5 seconds

      return () => {
         clearInterval(authCheckInterval);
      };
   }, []);

   const handleVolumeChange = (newVolume: number) => {
      setVolume(newVolume);
      if (audioRef.current) {
         audioRef.current.volume = newVolume / 100;
      }

      console.log('Audio Settings:', getAudioSettingsForBackend(audioQuality, newVolume));
   };

   const testAudio = () => {
      if (isTestPlaying) {
         if (audioRef.current) {
            audioRef.current.pause();
            audioRef.current.currentTime = 0;
         }
         setIsTestPlaying(false);
         return;
      }

      const qualitySettings = getAudioQualitySettings(audioQuality);

      const audio = new Audio();
      audioRef.current = audio;

      audio.volume = volume / 100;
      if ('setSinkId' in audio && selectedOutputDevice !== 'default') {
         (audio as any).setSinkId(selectedOutputDevice).catch((error: any) => {
            console.error('Error setting audio output device:', error);
         });
      }

      audio.src = `/test-audio.mp3?quality=${audioQuality}&t=${Date.now()}`;

      const playPromise = audio.play();

      if (playPromise !== undefined) {
         playPromise.then(() => {
            setIsTestPlaying(true);
            audio.onended = () => {
               setIsTestPlaying(false);
            };
         }).catch((error) => {
            console.log('MP3 playback failed, using tone fallback:', error);
            createTestTone(qualitySettings.frequency, qualitySettings.sampleRate);
         });
      } else {
         createTestTone(qualitySettings.frequency, qualitySettings.sampleRate);
      }
   };

   const createTestTone = (frequency: number = 440, sampleRate: number = 48000) => {
      try {
         const audioContext = new (window.AudioContext || (window as any).webkitAudioContext)({
            sampleRate: sampleRate
         });
         const oscillator = audioContext.createOscillator();
         const gainNode = audioContext.createGain();

         oscillator.connect(gainNode);
         gainNode.connect(audioContext.destination);

         oscillator.frequency.setValueAtTime(frequency, audioContext.currentTime);
         gainNode.gain.setValueAtTime((volume / 100) * 0.3, audioContext.currentTime);

         if (audioQuality === 'high') {
            const harmonic = audioContext.createOscillator();
            const harmonicGain = audioContext.createGain();
            harmonic.connect(harmonicGain);
            harmonicGain.connect(audioContext.destination);
            harmonic.frequency.setValueAtTime(frequency * 2, audioContext.currentTime);
            harmonicGain.gain.setValueAtTime((volume / 100) * 0.1, audioContext.currentTime);
            harmonic.start();
            setTimeout(() => harmonic.stop(), 1000);
         }

         setIsTestPlaying(true);
         oscillator.start();

         setTimeout(() => {
            oscillator.stop();
            setIsTestPlaying(false);
         }, 1000);
      } catch (error) {
         console.error('Error creating test tone:', error);
         setIsTestPlaying(false);
      }
   };

   const handleOutputDeviceChange = async (deviceId: string) => {
      setSelectedOutputDevice(deviceId);

      if (audioRef.current && 'setSinkId' in audioRef.current) {
         try {
            await (audioRef.current as any).setSinkId(deviceId);
         } catch (error) {
            console.error('Error setting audio output device:', error);
         }
      }
   };

   // Redemptions Manager Functions
   const loadRedemptions = async () => {
      setIsLoadingRedemptions(true);
      try {
         const redemptionsData = await invoke('get_twitch_redemptions') as TwitchRedemption[];
         setRedemptions(redemptionsData);
      } catch (error) {
         console.error('Error loading redemptions:', error);
         // Fallback to mock data for development
         const mockRedemptions: TwitchRedemption[] = [
            { id: '1', title: 'Say Hi', cost: 100, enabled: true, is_enabled: true, prompt: 'Say hello to the streamer!' },
            { id: '2', title: 'Play Sound', cost: 200, enabled: true, is_enabled: true, prompt: 'Play a sound effect' },
            { id: '3', title: 'Change Title', cost: 500, enabled: false, is_enabled: false, prompt: 'Change stream title' },
         ];
         setRedemptions(mockRedemptions);
      } finally {
         setIsLoadingRedemptions(false);
      }
   };

   const updateRedemptionConfig = (redemptionId: string, config: Partial<RedemptionConfig>) => {
      setRedemptionConfigs(prev => ({
         ...prev,
         [redemptionId]: {
            ...{
               enabled: false,
               ttsType: 'dynamic' as const,
               dynamicTemplate: '[[USER]] said: [[MESSAGE]]',
               staticFiles: [],
               timerEnabled: false,
               timerDuration: '00:30'
            },
            ...prev[redemptionId],
            ...config
         }
      }));
   };

   const handleFileUpload = (redemptionId: string, files: FileList | null) => {
      if (!files) return;
      
      const audioFiles = Array.from(files).filter(file => 
         file.type.startsWith('audio/') && file.name.endsWith('.mp3')
      );
      
      if (audioFiles.length > 0) {
         updateRedemptionConfig(redemptionId, { 
            staticFiles: [...(redemptionConfigs[redemptionId]?.staticFiles || []), ...audioFiles] 
         });
      }
   };

   const removeStaticFile = (redemptionId: string, fileIndex: number) => {
      const currentFiles = redemptionConfigs[redemptionId]?.staticFiles || [];
      const updatedFiles = currentFiles.filter((_, index) => index !== fileIndex);
      updateRedemptionConfig(redemptionId, { staticFiles: updatedFiles });
   };

   const formatTimer = (value: string): string => {
      // Remove all non-digit characters
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

   const renderTabContent = () => {
      switch (activeTab) {
         case 'twitch':
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

                  {/* Debug: Show current auth status and manual refresh */}
                  <div className="bg-gray-800/30 border border-gray-700/50 rounded-xl p-4">
                     <div className="flex items-center justify-between">
                        <div>
                           <h4 className="text-white font-medium">Debug: Auth Status</h4>
                           <p className="text-gray-400 text-sm">Current status: {twitchAuthStatus}</p>
                        </div>
                        <button 
                           onClick={checkTwitchAuthStatus}
                           className="px-3 py-1.5 bg-blue-600 hover:bg-blue-700 text-white text-sm rounded-lg font-medium transition-colors"
                        >
                           Refresh Status
                        </button>
                     </div>
                  </div>

                  {/* Redemptions Manager - Only show if Twitch is properly configured */}
                  {twitchAuthStatus === 'ready' && (
                     <div className="space-y-6">
                        <div>
                           <div className="flex items-center space-x-3 mb-2">
                              <Award className="w-6 h-6 text-purple-400" />
                              <h3 className="text-xl font-semibold text-white">Redemptions Manager</h3>
                           </div>
                           <p className="text-gray-400 mb-6">Configure responses for channel point redemptions</p>
                           
                           <div className="flex items-center space-x-3 mb-6">
                              <motion.button
                                 whileHover={{ scale: 1.02 }}
                                 whileTap={{ scale: 0.98 }}
                                 onClick={loadRedemptions}
                                 disabled={isLoadingRedemptions}
                                 className="flex items-center px-4 py-2 bg-gray-700 hover:bg-gray-600 disabled:bg-gray-600 text-white rounded-lg transition-colors font-medium"
                              >
                                 {isLoadingRedemptions ? (
                                    <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin mr-2" />
                                 ) : (
                                    <Settings className="w-4 h-4 mr-2" />
                                 )}
                                 {isLoadingRedemptions ? 'Loading...' : 'Load Redemptions'}
                              </motion.button>
                              
                              {redemptions.length > 0 && (
                                 <motion.button
                                    whileHover={{ scale: 1.02 }}
                                    whileTap={{ scale: 0.98 }}
                                    onClick={() => setShowCreateForm(!showCreateForm)}
                                    className="flex items-center px-4 py-2 bg-purple-600 hover:bg-purple-700 text-white rounded-lg transition-colors font-medium"
                                 >
                                    <span className="mr-2">+</span>
                                    Create New
                                 </motion.button>
                              )}
                           </div>
                        </div>

                     {/* Create New Redemption Config Form */}
                     {showCreateForm && redemptions.length > 0 && (
                        <motion.div
                           initial={{ y: 10, opacity: 0 }}
                           animate={{ y: 0, opacity: 1 }}
                           className="bg-gray-800/50 border border-gray-700/50 rounded-2xl p-6"
                        >
                           <div className="flex items-center justify-between mb-6">
                              <h4 className="text-lg font-semibold text-white">
                                 {editingConfigId ? 'Edit Redemption Configuration' : 'Configure Redemption Response'}
                              </h4>
                              <button
                                 onClick={() => {
                                    setShowCreateForm(false);
                                    setSelectedRedemptionId('');
                                    setEditingConfigId('');
                                 }}
                                 className="text-gray-400 hover:text-white transition-colors"
                              >
                                 <X className="w-5 h-5" />
                              </button>
                           </div>

                           {/* Redemption Selection - Hide when editing */}
                           {!editingConfigId && (
                              <div className="mb-6">
                                 <label className="block text-sm font-medium text-gray-300 mb-3">Select Redemption</label>
                                 <select
                                    value={selectedRedemptionId}
                                    onChange={(e) => setSelectedRedemptionId(e.target.value)}
                                    className="w-full px-4 py-3 bg-gray-700/50 border border-gray-600 rounded-lg text-white focus:outline-none focus:border-purple-500"
                                 >
                                    <option value="">Choose a redemption...</option>
                                    {redemptions
                                       .filter(redemption => !redemptionConfigs[redemption.id]?.enabled)
                                       .map((redemption) => (
                                          <option key={redemption.id} value={redemption.id}>
                                             {redemption.title} ({redemption.cost} pts) {redemption.is_enabled ? '• Live' : '• Inactive'}
                                          </option>
                                       ))
                                    }
                                 </select>
                              </div>
                           )}

                           {/* Configuration Form - Only show when redemption is selected */}
                           {(selectedRedemptionId || editingConfigId) && (() => {
                              const configId = editingConfigId || selectedRedemptionId;
                              const selectedRedemption = redemptions.find(r => r.id === configId);
                              const config = redemptionConfigs[configId] || {
                                 enabled: false,
                                 ttsType: 'dynamic' as const,
                                 dynamicTemplate: '[[USER]] said: [[MESSAGE]]',
                                 staticFiles: [],
                                 timerEnabled: false,
                                 timerDuration: '00:30'
                              };

                              return (
                                 <div className="space-y-6 border-t border-gray-700/50 pt-6">
                                    {/* Redemption Info */}
                                    <div className="flex items-center space-x-4 p-4 bg-gray-700/30 rounded-lg border border-gray-600/30">
                                       <div className={`w-3 h-3 rounded-full ${
                                          selectedRedemption?.is_enabled ? 'bg-green-400' : 'bg-gray-500'
                                       }`} />
                                       <div className="flex-1">
                                          <h5 className="font-medium text-white">{selectedRedemption?.title}</h5>
                                          <p className="text-sm text-gray-400">{selectedRedemption?.prompt}</p>
                                       </div>
                                       <span className="bg-purple-600/20 text-purple-300 text-sm font-medium px-3 py-1 rounded-full border border-purple-500/30">
                                          {selectedRedemption?.cost} pts
                                       </span>
                                    </div>

                                    {/* TTS Configuration */}
                                    <div className="space-y-4">
                                       <div className="flex items-center space-x-2">
                                          <Volume className="w-4 h-4 text-gray-400" />
                                          <h5 className="text-sm font-semibold text-white">Text-to-Speech</h5>
                                       </div>
                                       
                                       <div className="grid grid-cols-2 gap-3">
                                          <button
                                             onClick={() => updateRedemptionConfig(configId, { ttsType: 'dynamic' })}
                                             className={`p-3 rounded-lg border transition-colors ${
                                                config.ttsType === 'dynamic'
                                                   ? 'border-purple-500 bg-purple-500/10 text-purple-300'
                                                   : 'border-gray-600/50 bg-gray-700/30 text-gray-300 hover:border-gray-500'
                                             }`}
                                          >
                                             <div className="text-sm font-medium">Dynamic TTS</div>
                                             <div className="text-xs text-gray-500">Template based</div>
                                          </button>
                                          
                                          <button
                                             onClick={() => updateRedemptionConfig(configId, { ttsType: 'static' })}
                                             className={`p-3 rounded-lg border transition-colors ${
                                                config.ttsType === 'static'
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
                                                onChange={(e) => updateRedemptionConfig(configId, { dynamicTemplate: e.target.value })}
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
                                                   onChange={(e) => handleFileUpload(configId, e.target.files)}
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
                                                            onClick={() => removeStaticFile(configId, index)}
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
                                             onClick={() => updateRedemptionConfig(configId, { timerEnabled: !config.timerEnabled })}
                                             className={`relative w-10 h-5 rounded-full transition-colors ${
                                                config.timerEnabled ? 'bg-purple-600' : 'bg-gray-600'
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
                                                   onChange={(e) => updateRedemptionConfig(configId, { timerDuration: formatTimer(e.target.value) })}
                                                   placeholder="00:30"
                                                   className="w-20 px-2 py-1 bg-gray-600/50 border border-gray-500/50 rounded text-white text-center font-mono text-sm focus:outline-none focus:border-purple-500 transition-colors"
                                                />
                                                <span className="text-xs text-gray-400">(MM:SS)</span>
                                             </div>
                                          </div>
                                       )}
                                    </div>

                                    {/* Save Button */}
                                    <div className="flex justify-end space-x-3 pt-4 border-t border-gray-700/50">
                                       <button
                                          onClick={() => {
                                             setShowCreateForm(false);
                                             setSelectedRedemptionId('');
                                             setEditingConfigId('');
                                          }}
                                          className="px-4 py-2 text-gray-400 hover:text-white transition-colors"
                                       >
                                          Cancel
                                       </button>
                                       <motion.button
                                          whileHover={{ scale: 1.02 }}
                                          whileTap={{ scale: 0.98 }}
                                          onClick={() => {
                                             updateRedemptionConfig(configId, { enabled: true });
                                             setShowCreateForm(false);
                                             setSelectedRedemptionId('');
                                             setEditingConfigId('');
                                          }}
                                          className="px-6 py-2 bg-purple-600 hover:bg-purple-700 text-white rounded-lg transition-colors font-medium"
                                       >
                                          {editingConfigId ? 'Update Configuration' : 'Save Configuration'}
                                       </motion.button>
                                    </div>
                                 </div>
                              );
                           })()}
                        </motion.div>
                     )}

                     {/* Active Configurations List */}
                     {Object.entries(redemptionConfigs).filter(([_, config]) => config.enabled).length > 0 && (
                        <div className="space-y-4">
                           <h4 className="text-lg font-semibold text-white">Active Configurations</h4>
                           <div className="space-y-3">
                              {Object.entries(redemptionConfigs)
                                 .filter(([_, config]) => config.enabled)
                                 .map(([redemptionId, config]) => {
                                    const redemption = redemptions.find(r => r.id === redemptionId);
                                    if (!redemption) return null;

                                    return (
                                       <motion.div
                                          key={redemptionId}
                                          initial={{ y: 10, opacity: 0 }}
                                          animate={{ y: 0, opacity: 1 }}
                                          className="bg-gray-800/40 border border-gray-700/50 rounded-lg p-4"
                                       >
                                          <div className="flex items-center justify-between">
                                             <div className="flex items-center space-x-3">
                                                <div className={`w-2 h-2 rounded-full ${
                                                   redemption.is_enabled ? 'bg-green-400' : 'bg-gray-500'
                                                }`} />
                                                <div>
                                                   <span className="text-white font-medium">{redemption.title}</span>
                                                   <div className="flex items-center space-x-2 text-xs text-gray-400 mt-1">
                                                      <span>{config.ttsType === 'dynamic' ? 'Dynamic TTS' : `${config.staticFiles.length} audio files`}</span>
                                                      {config.timerEnabled && (
                                                         <>
                                                            <span>•</span>
                                                            <span>Timer: {config.timerDuration}</span>
                                                         </>
                                                      )}
                                                   </div>
                                                </div>
                                             </div>
                                             <div className="flex items-center space-x-2">
                                                <motion.button
                                                   whileHover={{ scale: 1.1 }}
                                                   whileTap={{ scale: 0.9 }}
                                                   onClick={() => {
                                                      setSelectedRedemptionId(redemptionId);
                                                      setEditingConfigId(redemptionId);
                                                      setShowCreateForm(true);
                                                   }}
                                                   className="p-1 text-gray-400 hover:text-blue-400 transition-colors"
                                                   title="Edit configuration"
                                                >
                                                   <Edit2 className="w-4 h-4" />
                                                </motion.button>
                                                <button
                                                   onClick={() => updateRedemptionConfig(redemptionId, { enabled: false })}
                                                   className="p-1 text-gray-400 hover:text-red-400 transition-colors"
                                                   title="Remove configuration"
                                                >
                                                   <X className="w-4 h-4" />
                                                </button>
                                             </div>
                                          </div>
                                       </motion.div>
                                    );
                                 })
                              }
                           </div>
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

         case 'audio':
            return (
               <motion.div
                  initial={{ x: 20, opacity: 0 }}
                  animate={{ x: 0, opacity: 1 }}
                  transition={{ duration: 0.3 }}
                  className="space-y-6"
               >
                  <div>
                     <h2 className="text-2xl font-bold text-white mb-2">Audio Settings</h2>
                     <p className="text-gray-400">Configure audio quality and output devices</p>
                  </div>

                  <div className="bg-gray-800/50 border border-gray-700/50 rounded-2xl p-6">
                     <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
                        <div className="space-y-6">
                           <div>
                              <label className="block text-sm font-medium text-gray-300 mb-2">Audio Quality</label>
                              <select
                                 value={audioQuality}
                                 onChange={(e) => setAudioQuality(e.target.value as AudioQuality)}
                                 className="w-full px-4 py-3 bg-gray-700/50 border border-gray-600 rounded-lg text-white focus:outline-none focus:border-purple-500"
                              >
                                 <option value="ultra">Ultra (48kHz, 320kbps)</option>
                                 <option value="high">High (44kHz, 256kbps)</option>
                                 <option value="medium">Medium (22kHz, 192kbps)</option>
                                 <option value="low">Low (16kHz, 128kbps)</option>
                              </select>
                           </div>

                           <div>
                              <label className="block text-sm font-medium text-gray-300 mb-2">Output Device</label>
                              <select
                                 value={selectedOutputDevice}
                                 onChange={(e) => handleOutputDeviceChange(e.target.value)}
                                 className="w-full px-4 py-3 bg-gray-700/50 border border-gray-600 rounded-lg text-white focus:outline-none focus:border-purple-500"
                              >
                                 <option value="default">Default Output Device</option>
                                 {outputDevices.map((device) => (
                                    <option key={device.deviceId} value={device.deviceId}>
                                       {device.label || `Device ${device.deviceId.slice(0, 8)}...`}
                                    </option>
                                 ))}
                              </select>
                           </div>
                        </div>

                        <div className="space-y-6">
                           <div>
                              <label className="block text-sm font-medium text-gray-300 mb-2">
                                 Volume: {volume}%
                              </label>
                              <div className="volume-slider-container">
                                 <input
                                    type="range"
                                    min="0"
                                    max="100"
                                    value={volume}
                                    onChange={(e) => handleVolumeChange(parseInt(e.target.value))}
                                    className="volume-slider w-full"
                                    style={{
                                       background: `linear-gradient(to right, #8b5cf6 0%, #8b5cf6 ${volume}%, #374151 ${volume}%, #374151 100%)`
                                    }}
                                 />
                              </div>
                           </div>

                           <div>
                              <label className="block text-sm font-medium text-gray-300 mb-2">Test Audio</label>
                              <motion.button
                                 whileHover={{ scale: 1.02 }}
                                 whileTap={{ scale: 0.98 }}
                                 onClick={testAudio}
                                 className="flex items-center px-4 py-2 bg-purple-600 hover:bg-purple-700 text-white rounded-lg transition-colors"
                              >
                                 {isTestPlaying ? (
                                    <>
                                       <Pause className="w-4 h-4 mr-2" />
                                       Stop Test
                                    </>
                                 ) : (
                                    <>
                                       <Play className="w-4 h-4 mr-2" />
                                       Test Audio
                                    </>
                                 )}
                              </motion.button>
                           </div>
                        </div>
                     </div>
                  </div>
               </motion.div>
            );

         case 'security':
            return (
               <motion.div
                  initial={{ x: 20, opacity: 0 }}
                  animate={{ x: 0, opacity: 1 }}
                  transition={{ duration: 0.3 }}
                  className="space-y-6"
               >
                  <div>
                     <h2 className="text-2xl font-bold text-white mb-2">Security & Privacy</h2>
                     <p className="text-gray-400">Manage connection security and privacy settings</p>
                  </div>

                  <div className="bg-gray-800/50 border border-gray-700/50 rounded-2xl p-6">
                     <div className="space-y-6">
                        <div className="flex items-center justify-between">
                           <div>
                              <h3 className="text-lg font-medium text-white">Auto-accept connections</h3>
                              <p className="text-gray-400 text-sm">Automatically accept incoming connections without manual approval</p>
                           </div>
                           <motion.button
                              whileTap={{ scale: 0.95 }}
                              onClick={() => setAutoAccept(!autoAccept)}
                              className={`relative w-12 h-6 rounded-full transition-colors ${
                                 autoAccept ? 'bg-purple-600' : 'bg-gray-600'
                              }`}
                           >
                              <motion.div
                                 animate={{ x: autoAccept ? 24 : 0 }}
                                 transition={{ type: "spring", stiffness: 500, damping: 30 }}
                                 className="absolute top-0.5 left-0.5 w-5 h-5 bg-white rounded-full"
                              />
                           </motion.button>
                        </div>

                        <div className="flex items-center justify-between">
                           <div>
                              <h3 className="text-lg font-medium text-white">Manual confirmation required</h3>
                              <p className="text-gray-400 text-sm">Require manual confirmation for sensitive operations</p>
                           </div>
                           <motion.button
                              whileTap={{ scale: 0.95 }}
                              onClick={() => setManualConfirm(!manualConfirm)}
                              className={`relative w-12 h-6 rounded-full transition-colors ${
                                 manualConfirm ? 'bg-purple-600' : 'bg-gray-600'
                              }`}
                           >
                              <motion.div
                                 animate={{ x: manualConfirm ? 24 : 0 }}
                                 transition={{ type: "spring", stiffness: 500, damping: 30 }}
                                 className="absolute top-0.5 left-0.5 w-5 h-5 bg-white rounded-full"
                              />
                           </motion.button>
                        </div>
                     </div>
                  </div>
               </motion.div>
            );

         case 'appearance':
            return (
               <motion.div
                  initial={{ x: 20, opacity: 0 }}
                  animate={{ x: 0, opacity: 1 }}
                  transition={{ duration: 0.3 }}
                  className="space-y-6"
               >
                  <div>
                     <h2 className="text-2xl font-bold text-white mb-2">Appearance</h2>
                     <p className="text-gray-400">Customize the interface theme and visual preferences</p>
                  </div>

                  <div className="bg-gray-800/50 border border-gray-700/50 rounded-2xl p-6">
                     <div className="space-y-6">
                        <div className="max-w-md">
                           <label className="block text-sm font-medium text-gray-300 mb-2">Theme</label>
                           <select
                              value={theme}
                              onChange={(e) => setTheme(e.target.value)}
                              className="w-full px-4 py-3 bg-gray-700/50 border border-gray-600 rounded-lg text-white focus:outline-none focus:border-purple-500"
                           >
                              <option value="dark">Dark (Default)</option>
                              <option value="light">Light</option>
                              <option value="auto">Auto (System)</option>
                           </select>
                        </div>
                     </div>
                  </div>
               </motion.div>
            );

         default:
            return null;
      }
   };

   return (
      <div className="min-h-screen bg-gradient-to-br from-gray-900 via-black to-gray-900 flex">
         {/* Sidebar with tabs */}
         <div className="w-80 bg-gray-900/50 border-r border-gray-800 flex flex-col">
            {/* Header */}
            <div className="p-6 border-b border-gray-800">
               <Link to="/">
                  <motion.div
                     whileHover={{ x: -3 }}
                     className="flex items-center text-gray-300 hover:text-white transition-colors cursor-pointer mb-4"
                  >
                     <ArrowLeft className="w-5 h-5 mr-2" />
                     <span className="font-medium">Back to Home</span>
                  </motion.div>
               </Link>

               <div className="flex items-center">
                  <div className="w-3 h-3 bg-purple-400 rounded-full mr-3"></div>
                  <h1 className="text-xl font-semibold text-white">Settings</h1>
               </div>
            </div>

            {/* Tab navigation */}
            <div className="flex-1 p-4">
               <div className="space-y-2">
                  {tabs.map((tab) => {
                     const Icon = tab.icon;
                     const isActive = activeTab === tab.id;
                     const colorClasses = {
                        purple: isActive ? 'bg-purple-600/20 text-purple-400 border-purple-500/30' : 'hover:bg-purple-500/10 hover:text-purple-400',
                        blue: isActive ? 'bg-blue-600/20 text-blue-400 border-blue-500/30' : 'hover:bg-blue-500/10 hover:text-blue-400',
                        green: isActive ? 'bg-green-600/20 text-green-400 border-green-500/30' : 'hover:bg-green-500/10 hover:text-green-400',
                        pink: isActive ? 'bg-pink-600/20 text-pink-400 border-pink-500/30' : 'hover:bg-pink-500/10 hover:text-pink-400',
                     };

                     return (
                        <motion.button
                           key={tab.id}
                           whileHover={{ x: 4 }}
                           whileTap={{ scale: 0.98 }}
                           onClick={() => setActiveTab(tab.id)}
                           className={`w-full flex items-center px-4 py-3 rounded-xl border transition-all text-left ${
                              isActive 
                                 ? `${colorClasses[tab.color as keyof typeof colorClasses]} border` 
                                 : `text-gray-400 border-transparent ${colorClasses[tab.color as keyof typeof colorClasses]}`
                           }`}
                        >
                           <Icon className="w-5 h-5 mr-3" />
                           <span className="font-medium">{tab.label}</span>
                        </motion.button>
                     );
                  })}
               </div>
            </div>
         </div>

         {/* Main content area */}
         <div className="flex-1 overflow-auto">
            <div className="p-8">
               <div className="max-w-4xl mx-auto">
                  {renderTabContent()}
               </div>
            </div>
         </div>

         {/* Audio element for testing */}
         <audio ref={audioRef} style={{ display: 'none' }} />
      </div>
   );
};

export default SettingsPage;
