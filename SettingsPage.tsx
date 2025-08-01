import { motion } from 'framer-motion';
import { useState, useEffect, useRef } from 'react';
import { ArrowLeft, Volume2, Shield, Palette, Play, Pause, Twitch, Upload, X, Timer, Volume, FileAudio, Award, Edit2, ChevronUp, Settings2, RefreshCw, File, Sliders, Search, Trash2, Info } from 'lucide-react';
import { Link } from 'react-router-dom';
import '../components/VolumeSlider.css';
import { AudioQuality, getAudioQualitySettings, getAudioSettingsForBackend } from '../utils/audioSettings';
import TwitchIntegration from '../components/TwitchIntegration';
import { invoke } from '@tauri-apps/api/core';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { load } from '@tauri-apps/plugin-store';

type SettingsTab = 'twitch' | 'audio' | 'tts' | 'python-env' | 'security' | 'appearance';

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
   staticFileNames: string[]; // Store file names for backend reference
   timerEnabled: boolean;
   timerDuration: string; // MM:SS format
}


interface SerializableRedemptionConfig {
   enabled: boolean;
   ttsType: 'dynamic' | 'static';
   dynamicTemplate: string;
   staticFiles: Array<{
      name: string;
      size: number;
      type: string;
      lastModified: number;
   }>;
   staticFileNames: string[]; // Store file names for backend reference
   timerEnabled: boolean;
   timerDuration: string;
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

   // TTS Settings State
   const [ttsMode, setTtsMode] = useState<'normal' | 'rvc'>('normal');
   const [ttsProvider, setTtsProvider] = useState('openai');
   const [ttsVoice, setTtsVoice] = useState('alloy');
   const [rvcModelFile, setRvcModelFile] = useState<File | null>(null);
   const [availableModels, setAvailableModels] = useState<string[]>([]);
   const [selectedModel, setSelectedModel] = useState<string>('');
   const [rvcSettings, setRvcSettings] = useState({
      // RVC Command Arguments
      device: 'cuda:0',
      inferenceRate: 0.75,
      filterRadius: 3,
      resampleRate: 0.25,
      protectRate: 0.5
   });

   // Redemptions Manager State
   const [redemptions, setRedemptions] = useState<TwitchRedemption[]>([]);
   const [redemptionConfigs, setRedemptionConfigs] = useState<Record<string, RedemptionConfig>>({});
   const [isLoadingRedemptions, setIsLoadingRedemptions] = useState(false);
   const [expandedRedemptionId, setExpandedRedemptionId] = useState<string>('');
   const [showAddModal, setShowAddModal] = useState(false);
   const [twitchAuthStatus, setTwitchAuthStatus] = useState<'checking' | 'needs_credentials' | 'needs_auth' | 'authenticating' | 'ready' | 'error'>('checking');
   const [isSavingConfigs, setIsSavingConfigs] = useState(false);

   // Python Environment State
   const [isSettingUpEnv, setIsSettingUpEnv] = useState(false);
   const [setupProgress, setSetupProgress] = useState(0);
   const [setupStatus, setSetupStatus] = useState('');
   const [isUploadingFiles, setIsUploadingFiles] = useState(false);
   const [isCheckingVersions, setIsCheckingVersions] = useState(false);
   const [isForceReinstalling, setIsForceReinstalling] = useState(false);
   const [isResettingEnv, setIsResettingEnv] = useState(false);
   const [pythonVersion, setPythonVersion] = useState<string>('');
   const [libraryVersions, setLibraryVersions] = useState<string>('');
   const [environmentReady, setEnvironmentReady] = useState(false);
   const [isCheckingEnvironment, setIsCheckingEnvironment] = useState(true);

   // Auto-load redemptions when auth becomes ready
   useEffect(() => {
      if (twitchAuthStatus === 'ready' && redemptions.length === 0 && !isLoadingRedemptions) {
         console.log('SettingsPage: Auto-loading redemptions after auth ready');
         loadRedemptions();
      }
   }, [twitchAuthStatus, redemptions.length, isLoadingRedemptions]);

   // Check Python environment status on mount
   useEffect(() => {
      const checkEnvironmentStatus = async () => {
         try {
            setIsCheckingEnvironment(true);
            const status = await invoke('check_environment_status') as any;
            
            if (status.environment_ready) {
               setEnvironmentReady(true);
               if (status.python_version) {
                  setPythonVersion(status.python_version);
               }
               if (status.library_versions) {
                  // Format library versions for display
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
         } catch (error) {
            console.error('Error checking environment status:', error);
            setEnvironmentReady(false);
         } finally {
            setIsCheckingEnvironment(false);
         }
      };

      checkEnvironmentStatus();
   }, []);

   // Debug: Log when twitchAuthStatus changes
   useEffect(() => {
      console.log('SettingsPage: twitchAuthStatus changed to:', twitchAuthStatus);
   }, [twitchAuthStatus]);

   const tabs = [
      { id: 'twitch' as SettingsTab, label: 'Twitch Integration', icon: Twitch, color: 'purple' },
      { id: 'audio' as SettingsTab, label: 'Audio Settings', icon: Volume2, color: 'blue' },
      { id: 'tts' as SettingsTab, label: 'Text to Speech', icon: Volume, color: 'orange' },
      { id: 'python-env' as SettingsTab, label: 'Python Environment', icon: Settings2, color: 'yellow' },
      { id: 'security' as SettingsTab, label: 'Security & Privacy', icon: Shield, color: 'green' },
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
      const newConfigs = {
         ...redemptionConfigs,
         [redemptionId]: {
            ...{
               enabled: false,
               ttsType: 'dynamic' as const,
               dynamicTemplate: '[[USER]] said: [[MESSAGE]]',
               staticFiles: [],
               staticFileNames: [],
               timerEnabled: false,
               timerDuration: '00:30'
            },
            ...redemptionConfigs[redemptionId],
            ...config
         }
      };

      setRedemptionConfigs(newConfigs);

      // Save to storage automatically
      saveRedemptionConfigs(newConfigs);
   };

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
         // Get current static files count to continue numbering
         const currentConfig = redemptionConfigs[redemptionId];
         const currentFileCount = currentConfig?.staticFiles?.length || 0;

         // Save each file to backend
         const savedFileNames: string[] = [];
         const mockFiles: File[] = [];

         for (let i = 0; i < audioFiles.length; i++) {
            const file = audioFiles[i];
            const fileIndex = currentFileCount + i;
            const success = await saveAudioFile(redemption.title, file, fileIndex);

            if (success) {
               const fileName = `${redemption.title.replace(/[^a-zA-Z0-9]/g, '_')}-${fileIndex + 1}.mp3`;
               savedFileNames.push(fileName);

               // Create a mock File object for UI display
               const mockFile = {
                  name: fileName,
                  size: file.size,
                  type: file.type,
                  lastModified: Date.now()
               } as File;
               mockFiles.push(mockFile);
            }
         }

         // Update config with both File objects for UI and file names for backend reference
         updateRedemptionConfig(redemptionId, {
            staticFiles: [...(currentConfig?.staticFiles || []), ...mockFiles],
            staticFileNames: [...(currentConfig?.staticFileNames || []), ...savedFileNames]
         });

         console.log(`Uploaded ${savedFileNames.length} files for redemption: ${redemption.title}`);
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
            // Remove file from backend if we have the file name
            if (fileNameToRemove) {
               const redemption = redemptions.find(r => r.id === redemptionId);
               if (redemption) {
                  await invoke('delete_audio_file', {
                     redemptionName: redemption.title.replace(/[^a-zA-Z0-9]/g, '_'),
                     fileName: fileNameToRemove
                  });
                  console.log(`Deleted file from backend: ${fileNameToRemove}`);
               }
            }
         } catch (error) {
            console.error('Error deleting file from backend:', error);
         }

         // Update local state
         const updatedFiles = currentFiles.filter((_, index) => index !== fileIndex);
         const updatedFileNames = currentFileNames.filter((_, index) => index !== fileIndex);

         updateRedemptionConfig(redemptionId, {
            staticFiles: updatedFiles,
            staticFileNames: updatedFileNames
         });
      }
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

   // Storage functions for redemption configurations
   const saveRedemptionConfigs = async (configs: Record<string, RedemptionConfig>) => {
      try {
         setIsSavingConfigs(true);
         const store = await load('redemptions.json', { autoSave: false });

         // Convert File objects to serializable format
         const serializableConfigs: Record<string, SerializableRedemptionConfig> = {};
         for (const [key, config] of Object.entries(configs)) {
            serializableConfigs[key] = {
               ...config,
               staticFiles: config.staticFiles.map(file => ({
                  name: file.name,
                  size: file.size,
                  type: file.type,
                  lastModified: file.lastModified
               })),
               staticFileNames: config.staticFileNames || []
            };
         }

         await store.set('redemptionConfigs', serializableConfigs);
         await store.save();
         console.log('Redemption configurations saved successfully');
      } catch (error) {
         console.error('Error saving redemption configurations:', error);
      } finally {
         setIsSavingConfigs(false);
      }
   };

   const loadRedemptionConfigs = async (): Promise<Record<string, RedemptionConfig>> => {
      try {
         const store = await load('redemptions.json', { autoSave: false });
         const configs = await store.get<Record<string, SerializableRedemptionConfig>>('redemptionConfigs');
         console.log('Loaded redemption configurations:', configs);

         if (!configs) return {};

         // Convert serializable format back to RedemptionConfig
         const redemptionConfigs: Record<string, RedemptionConfig> = {};
         for (const [key, config] of Object.entries(configs)) {
            // Create mock File objects from saved metadata for UI display
            const mockFiles = config.staticFiles.map(fileData => ({
               name: fileData.name,
               size: fileData.size,
               type: fileData.type,
               lastModified: fileData.lastModified
            } as File));

            redemptionConfigs[key] = {
               ...config,
               staticFiles: mockFiles,
               staticFileNames: config.staticFileNames || []
            };
         }

         return redemptionConfigs;
      } catch (error) {
         console.error('Error loading redemption configurations:', error);
         return {};
      }
   };

   // Load existing configurations on component mount
   useEffect(() => {
      const initializeConfigs = async () => {
         const savedConfigs = await loadRedemptionConfigs();
         if (Object.keys(savedConfigs).length > 0) {
            // Load file lists from backend for each configured redemption
            const updatedConfigs = { ...savedConfigs };

            for (const [redemptionId, config] of Object.entries(savedConfigs)) {
               if (config.enabled && config.ttsType === 'static') {
                  const redemption = redemptions.find(r => r.id === redemptionId);
                  if (redemption) {
                     try {
                        const fileNames = await loadAudioFiles(redemption.title);
                        if (fileNames.length > 0) {
                           // Create mock File objects for UI display
                           const mockFiles = fileNames.map(fileName => ({
                              name: fileName,
                              size: 0, // We don't know the size from the backend
                              type: 'audio/mpeg',
                              lastModified: Date.now()
                           } as File));

                           updatedConfigs[redemptionId] = {
                              ...config,
                              staticFiles: mockFiles,
                              staticFileNames: fileNames
                           };
                        }
                     } catch (error) {
                        console.error(`Error loading files for redemption ${redemption.title}:`, error);
                     }
                  }
               }
            }

            setRedemptionConfigs(updatedConfigs);
            console.log('Initialized with saved configurations and loaded audio files');
         }
      };

      // Only initialize after redemptions are loaded
      if (redemptions.length > 0) {
         initializeConfigs();
      }
   }, [redemptions]);

   // Load TTS settings on component mount
   useEffect(() => {
      loadTtsSettings();
      loadAvailableModels();
   }, []);

   // Load available models
   const loadAvailableModels = async () => {
      try {
         const models = await invoke('get_pth_models') as string[];
         setAvailableModels(models);
         console.log('Available models loaded:', models);
      } catch (error) {
         console.error('Error loading available models:', error);
      }
   };

   // Auto-save TTS settings when they change
   useEffect(() => {
      saveTtsSettings();
   }, [ttsMode, ttsProvider, ttsVoice, selectedModel, rvcSettings]);

   // File upload and storage functions
   const convertFileToBase64 = (file: File): Promise<string> => {
      return new Promise((resolve, reject) => {
         const reader = new FileReader();
         reader.readAsDataURL(file);
         reader.onload = () => {
            const result = reader.result as string;
            // Remove the data:audio/mpeg;base64, prefix
            const base64 = result.split(',')[1];
            resolve(base64);
         };
         reader.onerror = error => reject(error);
      });
   };

   const saveAudioFile = async (redemptionTitle: string, file: File, fileIndex: number): Promise<boolean> => {
      try {
         const base64Data = await convertFileToBase64(file);
         const fileName = `${redemptionTitle.replace(/[^a-zA-Z0-9]/g, '_')}-${fileIndex + 1}.mp3`;

         await invoke('save_audio_file', {
            redemptionName: redemptionTitle.replace(/[^a-zA-Z0-9]/g, '_'),
            fileName: fileName,
            base64Data: base64Data
         });

         console.log(`Audio file saved: static_audios/${redemptionTitle.replace(/[^a-zA-Z0-9]/g, '_')}/${fileName}`);
         return true;
      } catch (error) {
         console.error('Error saving audio file:', error);
         return false;
      }
   };

   const loadAudioFiles = async (redemptionName: string): Promise<string[]> => {
      try {
         const files = await invoke('get_audio_files', {
            redemptionName: redemptionName.replace(/[^a-zA-Z0-9]/g, '_')
         }) as string[];
         return files;
      } catch (error) {
         console.error('Error loading audio files:', error);
         return [];
      }
   };

   // TTS Helper Functions
   const handleRvcModelUpload = async (event: React.ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.[0];
      if (file && file.name.endsWith('.pth')) {
         try {
            // Convert file to base64
            const base64Data = await convertFileToBase64(file);

            // Save .pth file to pythonenv/models/ directory
            await invoke('save_pth_model', {
               fileName: file.name,
               base64Data: base64Data
            });

            setRvcModelFile(file);
            console.log(`Model file saved: pythonenv/models/${file.name}`);
            
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
   };

   const handleDeleteModel = async (modelName: string) => {
      if (!confirm(`Are you sure you want to delete ${modelName}?`)) {
         return;
      }

      try {
         await invoke('delete_pth_model', {
            fileName: modelName
         });

         console.log(`Model file deleted: ${modelName}`);
         
         // Refresh the available models list
         await loadAvailableModels();
         
         // Clear selection if the deleted model was selected
         if (selectedModel === modelName) {
            setSelectedModel('');
         }
      } catch (error) {
         console.error('Error deleting model file:', error);
         alert('Failed to delete model file');
      }
   };

   const updateRvcSetting = (key: keyof typeof rvcSettings, value: number | boolean | string) => {
      setRvcSettings(prev => ({
         ...prev,
         [key]: value
      }));
   };

   const saveTtsSettings = async () => {
      try {
         const ttsConfig = {
            ttsMode,
            ttsProvider,
            ttsVoice,
            rvcModelFile: rvcModelFile ? rvcModelFile.name : null,
            selectedModel,
            rvcSettings
         };

         await invoke('save_tts_settings', {
            config: ttsConfig
         });

         console.log('TTS settings saved successfully');
      } catch (error) {
         console.error('Error saving TTS settings:', error);
      }
   };

   const loadTtsSettings = async () => {
      try {
         const config = await invoke('load_tts_settings') as any;
         if (config) {
            setTtsMode(config.ttsMode || 'normal');
            setTtsProvider(config.ttsProvider || 'openai');
            setTtsVoice(config.ttsVoice || 'alloy');
            setSelectedModel(config.selectedModel || '');
            if (config.rvcSettings) {
               setRvcSettings(config.rvcSettings);
            }
            // Note: We don't restore the file object, just show the name if available
            console.log('TTS settings loaded successfully');
         }
      } catch (error) {
         console.error('Error loading TTS settings:', error);
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
                        <div className="flex items-center space-x-2">
                           <button
                              onClick={async () => {
                                 const store = await load('redemptions.json', { autoSave: false });
                                 await store.set('redemptionConfigs', {});
                                 await store.save();
                                 setRedemptionConfigs({});
                                 console.log('Cleared all redemption configurations');
                              }}
                              className="px-3 py-1.5 bg-red-600 hover:bg-red-700 text-white text-sm rounded-lg font-medium transition-colors"
                           >
                              Clear Configs
                           </button>
                           <button
                              onClick={checkTwitchAuthStatus}
                              className="px-3 py-1.5 bg-blue-600 hover:bg-blue-700 text-white text-sm rounded-lg font-medium transition-colors"
                           >
                              Refresh Status
                           </button>
                        </div>
                     </div>
                  </div>

                  {/* Redemptions Manager - Only show if Twitch is properly configured */}
                  {twitchAuthStatus === 'ready' && (
                     <div className="space-y-6">
                        <div className="flex items-center justify-between mb-6">
                           <div>
                              <div className="flex items-center space-x-3 mb-2">
                                 <Award className="w-6 h-6 text-purple-400" />
                                 <h3 className="text-xl font-semibold text-white">Redemptions Manager</h3>
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
                              <p className="text-gray-400">Configure responses for channel point redemptions</p>
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

                        {/* Redemption Cards - Only show configured ones and available ones via selection */}
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
                                                   {/* Status Indicator - Always green for configured */}
                                                   <div className="w-3 h-3 rounded-full bg-green-400" />

                                                   {/* Redemption Info */}
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

                                                {/* Action Buttons */}
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
                                                            // Don't allow saving if static mode with no files
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

                        {/* Show message when no redemptions available */}
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

         case 'tts':
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
                                 className={`p-4 rounded-lg border transition-colors ${ttsMode === 'normal'
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
                                 className={`p-4 rounded-lg border transition-colors ${ttsMode === 'rvc'
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
                                          console.log('Normal TTS test initiated');
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
                                             onClick={() => setRvcModelFile(null)}
                                             className="p-1 text-gray-400 hover:text-red-400 transition-colors"
                                          >
                                             <X className="w-4 h-4" />
                                          </button>
                                       </div>
                                    )}
                                 </div>
                              </div>

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
                                          console.log('RVC TTS test initiated');
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

         case 'python-env':
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

                                             // Listen for progress events
                                             const window = getCurrentWindow();
                                             const unlisten = await window.listen('PYTHON_SETUP_PROGRESS', (event: any) => {
                                                const { progress, status } = event.payload;
                                                setSetupProgress(progress);
                                                setSetupStatus(status);
                                             });

                                             try {
                                                const result = await invoke('setup_python_environment');
                                                console.log('Python environment setup result:', result);
                                                
                                                // Show completion message
                                                setSetupStatus('Environment setup completed successfully!');
                                                
                                                // Clean up listener
                                                unlisten();
                                                
                                                // Check environment status again and update state
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
                                                
                                                // Reset after showing completion
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
                                             console.log('Force reinstall result:', result);
                                             
                                             // Update environment status
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
                                             console.log('Environment reset result:', result);
                                             
                                             // Update environment status
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
                              className={`relative w-12 h-6 rounded-full transition-colors ${autoAccept ? 'bg-purple-600' : 'bg-gray-600'
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
                              className={`relative w-12 h-6 rounded-full transition-colors ${manualConfirm ? 'bg-purple-600' : 'bg-gray-600'
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
                        orange: isActive ? 'bg-orange-600/20 text-orange-400 border-orange-500/30' : 'hover:bg-orange-500/10 hover:text-orange-400',
                        yellow: isActive ? 'bg-yellow-600/20 text-yellow-400 border-yellow-500/30' : 'hover:bg-yellow-500/10 hover:text-yellow-400',
                     };

                     return (
                        <motion.button
                           key={tab.id}
                           whileHover={{ x: 4 }}
                           whileTap={{ scale: 0.98 }}
                           onClick={() => setActiveTab(tab.id)}
                           className={`w-full flex items-center px-4 py-3 rounded-xl border transition-all text-left ${isActive
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
