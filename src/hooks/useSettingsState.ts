import { useState, useEffect, useCallback } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { load } from '@tauri-apps/plugin-store';
import { AudioQuality } from '../utils/audioSettings';
import { 
  TwitchRedemption, 
  RedemptionConfig, 
  SerializableRedemptionConfig, 
  RvcSettings,
  TwitchAuthStatus 
} from '../types/settings';

export const useSettingsState = () => {
  // Audio Settings State
  const [audioQuality, setAudioQuality] = useState<AudioQuality>('high');
  const [outputDevices, setOutputDevices] = useState<MediaDeviceInfo[]>([]);
  const [selectedOutputDevice, setSelectedOutputDevice] = useState('default');
  const [volume, setVolume] = useState(50);
  const [isTestPlaying, setIsTestPlaying] = useState(false);

  // TTS Settings State
  const [ttsMode, setTtsMode] = useState<'normal' | 'rvc'>('normal');
  const [ttsProvider, setTtsProvider] = useState('openai');
  const [ttsVoice, setTtsVoice] = useState('alloy');
  const [rvcModelFile, setRvcModelFile] = useState<File | null>(null);
  const [availableModels, setAvailableModels] = useState<string[]>([]);
  const [selectedModel, setSelectedModel] = useState<string>('');
  const [availableDevices, setAvailableDevices] = useState<Array<{type: string, name: string, id: string}>>([]);
  const [rvcSettings, setRvcSettings] = useState<RvcSettings>({
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
  const [twitchAuthStatus, setTwitchAuthStatus] = useState<TwitchAuthStatus>('checking');
  const [isSavingConfigs, setIsSavingConfigs] = useState(false);
  const [isUploadingFiles, setIsUploadingFiles] = useState(false);

  // Python Environment State
  const [isSettingUpEnv, setIsSettingUpEnv] = useState(false);
  const [setupProgress, setSetupProgress] = useState(0);
  const [setupStatus, setSetupStatus] = useState('');
  const [isCheckingVersions, setIsCheckingVersions] = useState(false);
  const [isForceReinstalling, setIsForceReinstalling] = useState(false);
  const [isResettingEnv, setIsResettingEnv] = useState(false);
  const [pythonVersion, setPythonVersion] = useState<string>('');
  const [libraryVersions, setLibraryVersions] = useState<string>('');
  const [environmentReady, setEnvironmentReady] = useState(false);
  const [isCheckingEnvironment, setIsCheckingEnvironment] = useState(true);

  // Security Settings State
  const [autoAccept, setAutoAccept] = useState(false);
  const [manualConfirm, setManualConfirm] = useState(true);

  // Check Twitch auth status
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

  // Load redemptions
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

  // Update redemption config
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
    saveRedemptionConfigs(newConfigs);
  };

  // Save redemption configs to storage
  const saveRedemptionConfigs = async (configs: Record<string, RedemptionConfig>) => {
    try {
      setIsSavingConfigs(true);
      const store = await load('redemptions.json', { autoSave: false });

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

  // Load redemption configs from storage
  const loadRedemptionConfigs = async (): Promise<Record<string, RedemptionConfig>> => {
    try {
      const store = await load('redemptions.json', { autoSave: false });
      const configs = await store.get<Record<string, SerializableRedemptionConfig>>('redemptionConfigs');
      console.log('Loaded redemption configurations:', configs);

      if (!configs) return {};

      const redemptionConfigs: Record<string, RedemptionConfig> = {};
      for (const [key, config] of Object.entries(configs)) {
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

  // Convert file to base64
  const convertFileToBase64 = (file: File): Promise<string> => {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.readAsDataURL(file);
      reader.onload = () => {
        const result = reader.result as string;
        const base64 = result.split(',')[1];
        resolve(base64);
      };
      reader.onerror = error => reject(error);
    });
  };

  // Save audio file
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

  // Load audio files
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

  // TTS Settings functions
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
        console.log('TTS settings loaded successfully');
      }
    } catch (error) {
      console.error('Error loading TTS settings:', error);
    }
  };

  // Load available models
  const loadAvailableModels = useCallback(async () => {
    try {
      const models = await invoke('get_pth_models') as string[];
      setAvailableModels(models);
      console.log('Available models loaded:', models);
    } catch (error) {
      console.error('Error loading available models:', error);
    }
  }, []);

  // Load available devices
  const loadAvailableDevices = useCallback(async () => {
    try {
      const devices = await invoke('get_available_devices') as Array<{type: string, name: string, id: string}>;
      setAvailableDevices(devices);
      console.log('Available devices loaded:', devices);
    } catch (error) {
      console.error('Error loading available devices:', error);
      // Fallback to CPU only
      setAvailableDevices([{type: 'cpu', name: 'CPU', id: 'cpu'}]);
    }
  }, []);

  // Delete model
  const deleteModel = async (modelName: string) => {
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

  // Initialize state on mount
  useEffect(() => {
    // Load audio devices
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
    loadTtsSettings();
    loadAvailableModels();

    // Set up periodic auth status checking
    const authCheckInterval = setInterval(checkTwitchAuthStatus, 5000);

    return () => {
      clearInterval(authCheckInterval);
    };
  }, []);

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

  // Auto-load redemptions when auth becomes ready
  useEffect(() => {
    if (twitchAuthStatus === 'ready' && redemptions.length === 0 && !isLoadingRedemptions) {
      console.log('SettingsPage: Auto-loading redemptions after auth ready');
      loadRedemptions();
    }
  }, [twitchAuthStatus, redemptions.length, isLoadingRedemptions]);

  // Load existing configurations on component mount
  useEffect(() => {
    const initializeConfigs = async () => {
      const savedConfigs = await loadRedemptionConfigs();
      if (Object.keys(savedConfigs).length > 0) {
        const updatedConfigs = { ...savedConfigs };

        for (const [redemptionId, config] of Object.entries(savedConfigs)) {
          if (config.enabled && config.ttsType === 'static') {
            const redemption = redemptions.find(r => r.id === redemptionId);
            if (redemption) {
              try {
                const fileNames = await loadAudioFiles(redemption.title);
                if (fileNames.length > 0) {
                  const mockFiles = fileNames.map(fileName => ({
                    name: fileName,
                    size: 0,
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

    if (redemptions.length > 0) {
      initializeConfigs();
    }
  }, [redemptions]);

  return {
    // Audio Settings
    audioQuality,
    setAudioQuality,
    outputDevices,
    selectedOutputDevice,
    setSelectedOutputDevice,
    volume,
    setVolume,
    isTestPlaying,
    setIsTestPlaying,

    // TTS Settings
    ttsMode,
    setTtsMode,
    ttsProvider,
    setTtsProvider,
    ttsVoice,
    setTtsVoice,
    rvcModelFile,
    setRvcModelFile,
    availableModels,
    setAvailableModels,
    selectedModel,
    setSelectedModel,
    availableDevices,
    setAvailableDevices,
    rvcSettings,
    setRvcSettings,
    saveTtsSettings,
    loadTtsSettings,
    loadAvailableModels,
    loadAvailableDevices,
    deleteModel,

    // Redemptions
    redemptions,
    setRedemptions,
    redemptionConfigs,
    setRedemptionConfigs,
    isLoadingRedemptions,
    expandedRedemptionId,
    setExpandedRedemptionId,
    showAddModal,
    setShowAddModal,
    twitchAuthStatus,
    setTwitchAuthStatus,
    isSavingConfigs,
    isUploadingFiles,
    setIsUploadingFiles,
    loadRedemptions,
    updateRedemptionConfig,
    saveAudioFile,
    loadAudioFiles,
    convertFileToBase64,

    // Python Environment
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
    setIsCheckingEnvironment,

    // Security
    autoAccept,
    setAutoAccept,
    manualConfirm,
    setManualConfirm,

    // Utility functions
    checkTwitchAuthStatus,
  };
};
