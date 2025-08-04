import { motion } from 'framer-motion';
import { useState, useEffect, useRef } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { 
  ArrowLeft, 
  Copy, 
  CheckCircle, 
  AlertCircle,
  X,
  Check,
  Clock,
  User,
  MessageSquare,
  Power,
  ArrowDown,
  ArrowDownCircle
} from 'lucide-react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';

interface NetworkInfo {
  lan_ip: string;
  port: number;
  is_running: boolean;
}

interface RedemptionRequest {
  id: string;
  user_name: string;
  user_input?: string;
  reward_title: string;
  reward_id: string;
  reward_cost: number;
  reward_prompt?: string;
  redeemed_at: string;
  config?: {
    ttsType: 'dynamic' | 'static';
    dynamicTemplate: string;
    staticFiles: string[];
    timerEnabled: boolean;
    timerDuration: string;
  };
}

const ServerPage = () => {
  const navigate = useNavigate();
  const [isServerRunning, setIsServerRunning] = useState(false);
  const [networkInfo, setNetworkInfo] = useState<NetworkInfo | null>(null);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isEndingSession, setIsEndingSession] = useState(false);
  
  const [serverLogs, setServerLogs] = useState<Array<{type: 'info' | 'error' | 'success', message: string, timestamp: string}>>([]);

  const [redemptionRequests, setRedemptionRequests] = useState<RedemptionRequest[]>([]);
  const [processingRedemptions, setProcessingRedemptions] = useState<Set<string>>(new Set());
  const [editingRedemptions, setEditingRedemptions] = useState<Record<string, string>>({});
  const [redemptionConfigs, setRedemptionConfigs] = useState<Record<string, any>>({});
  
  const [isClientConnected, setIsClientConnected] = useState(false);
  const [generatedTTS, setGeneratedTTS] = useState<Record<string, {filePath: string, title: string, content: string, timerDuration?: number}>>({});
  
  const [activeTimers, setActiveTimers] = useState<Record<string, {
    id: string;
    title: string;
    content: string;
    userName: string;
    totalDuration: number;
    remainingTime: number;
    startedAt: Date;
  }>>({});

  const [autoScroll, setAutoScroll] = useState(true);
  const logsContainerRef = useRef<HTMLDivElement>(null);

  const addServerLog = (type: 'info' | 'error' | 'success', message: string) => {
    const timestamp = new Date().toLocaleTimeString();
    setServerLogs(prev => [...prev.slice(-9), { type, message, timestamp }]); 
  };

  useEffect(() => {
    if (autoScroll && logsContainerRef.current) {
      logsContainerRef.current.scrollTop = logsContainerRef.current.scrollHeight;
    }
  }, [serverLogs, autoScroll]);

  const scrollToBottom = () => {
    if (logsContainerRef.current) {
      logsContainerRef.current.scrollTop = logsContainerRef.current.scrollHeight;
    }
  };

  const checkConnectionStatus = async () => {
    try {
      const connected = await invoke('check_client_connection') as boolean;
      setIsClientConnected(connected);
    } catch (error) {
      console.error('Failed to check connection status:', error);
      setIsClientConnected(false);
    }
  };

  useEffect(() => {
    let mounted = true;
    let serverInitialized = false;

    const initializeServer = async () => {
      if (serverInitialized) return; 
      serverInitialized = true;
      
      try {
        if (mounted && !isServerRunning) {
          await handleStartServer();
          await getNetworkInfo();
        }
      } catch (error) {
        console.error('Failed to initialize server:', error);
        if (mounted) {
          setError(`Failed to initialize server: ${error}`);
        }
      }
    };
    
    initializeServer();

    const unlistenStatus = listen('STATUS_UPDATE', (event) => {
      if (!mounted) return;
      
      const message = event.payload as string;
      console.log('Server status:', message);
      addServerLog('info', message);
      
      if (message.includes('Listening on')) {
        setIsServerRunning(true);
        setError(null);
        getNetworkInfo();
      }
    });

    const unlistenError = listen('ERROR', (event) => {
      if (!mounted) return;
      
      const errorMessage = event.payload as string;
      console.error('Server error:', errorMessage);
      setError(errorMessage);
      addServerLog('error', errorMessage);
    });

    const unlistenTwitchRedemption = listen('TWITCH_CHANNEL_POINTS_REDEMPTION', async (event) => {
      if (!mounted) return;
      
      const redemptionData = event.payload as any;
      console.log('Twitch redemption received:', redemptionData);
      
      const redemptionRequest: RedemptionRequest = {
        id: redemptionData.id,
        user_name: redemptionData.user_name,
        user_input: redemptionData.user_input,
        reward_title: redemptionData.reward_title,
        reward_id: redemptionData.reward_id,
        reward_cost: redemptionData.reward_cost,
        reward_prompt: redemptionData.reward_prompt,
        redeemed_at: redemptionData.redeemed_at,
      };

      setRedemptionRequests(prev => [...prev, redemptionRequest]);
      addServerLog('info', `Redemption: ${redemptionData.user_name} redeemed "${redemptionData.reward_title}" (${redemptionData.reward_cost} points)`);
      
      loadRedemptionConfig(redemptionData.reward_id);
      
      if (redemptionData.user_input) {
        setEditingRedemptions(prev => ({
          ...prev,
          [redemptionData.id]: redemptionData.user_input
        }));
      }
    });

    const unlistenServerStopped = listen('SERVER_STOPPED', () => {
      if (!mounted) return;
      
      console.log('Server stopped, redirecting to home page');
      setIsServerRunning(false);
      setIsEndingSession(false);
      navigate('/');
    });

    const connectionCheckInterval = setInterval(() => {
      if (mounted && isServerRunning) {
        checkConnectionStatus();
      }
    }, 2000); 

    const timerInterval = setInterval(() => {
      if (mounted) {
        setActiveTimers(prev => {
          const updated = { ...prev };
          let hasChanges = false;

          Object.keys(updated).forEach(timerId => {
            if (updated[timerId].remainingTime > 0) {
              updated[timerId].remainingTime -= 1;
              hasChanges = true;
            } else {
              delete updated[timerId];
              hasChanges = true;
            }
          });

          return hasChanges ? updated : prev;
        });
      }
    }, 1000); 

    return () => {
      mounted = false;
      clearInterval(connectionCheckInterval);
      clearInterval(timerInterval);
      unlistenStatus.then(f => f());
      unlistenError.then(f => f());
      unlistenTwitchRedemption.then(f => f());
      unlistenServerStopped.then(f => f());
    };
  }, []); 

  const getNetworkInfo = async () => {
    try {
      const info = await invoke('get_lan_ip') as string;
      setNetworkInfo({
        lan_ip: info,
        port: 12345,
        is_running: true 
      });
      console.log('Network info retrieved:', info);
    } catch (error) {
      console.error('Failed to get network info:', error);
      setError('Failed to get network information');
    }
  };

  const handleStartServer = async () => {
    if (isServerRunning) {
      console.log('Server is already running, skipping start attempt');
      return;
    }

    try {
      setError(null);
      console.log('Starting server...');
      await invoke('start_listener');
    } catch (error) {
      console.error('Failed to start server:', error);
      
      const errorStr = error as string;
      if (errorStr.includes('already in use') || errorStr.includes('Address already in use')) {
        console.log('Port already in use, server might already be running');
        setIsServerRunning(true);
      } else {
        setError(`Failed to start server: ${error}`);
      }
    }
  };

  const handleAcceptRedemption = async (redemption: RedemptionRequest) => {
    setProcessingRedemptions(prev => new Set(prev).add(redemption.id));
    
    try {
      const { load } = await import('@tauri-apps/plugin-store');
      const store = await load('redemptions.json', { autoSave: false });
      const configs = await store.get('redemptionConfigs') as Record<string, any>;
      const redemptionConfig = configs?.[redemption.reward_id];

      if (!redemptionConfig || !redemptionConfig.enabled) {
        addServerLog('error', `No configuration found for redemption ${redemption.reward_title}`);
        return;
      }

      const timerDuration = redemptionConfig.timerEnabled ? 
        parseTimeToSeconds(redemptionConfig.timerDuration) : null;

      if (redemptionConfig.ttsType === 'static') {
        await handleStaticRedemption(redemption, redemptionConfig, timerDuration);
        setRedemptionRequests(prev => prev.filter(r => r.id !== redemption.id));
      } else if (redemptionConfig.ttsType === 'dynamic') {
        await handleDynamicRedemption(redemption, redemptionConfig, timerDuration);
      } else {
        addServerLog('error', `Unknown TTS type: ${redemptionConfig.ttsType}`);
        return;
      }
      
    } catch (error) {
      console.error('Failed to process redemption:', error);
      addServerLog('error', `Failed to process redemption: ${error}`);
    } finally {
      setProcessingRedemptions(prev => {
        const newSet = new Set(prev);
        newSet.delete(redemption.id);
        return newSet;
      });
    }
  };

  const parseTimeToSeconds = (timeStr: string): number => {
    const [minutes, seconds] = timeStr.split(':').map(Number);
    return (minutes * 60) + seconds;
  };

  const formatSecondsToTime = (totalSeconds: number): string => {
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return `${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
  };

  const handleStaticRedemption = async (
    redemption: RedemptionRequest, 
    config: any, 
    timerDuration: number | null
  ) => {
    if (!config.staticFileNames || config.staticFileNames.length === 0) {
      addServerLog('error', `No static files configured for ${redemption.reward_title}`);
      return;
    }

    const randomIndex = Math.floor(Math.random() * config.staticFileNames.length);
    const selectedFile = config.staticFileNames[randomIndex];
    
    const redemptionFolderName = redemption.reward_title.replace(/[^a-zA-Z0-9]/g, '_');
    const filePath = `static_audios/${redemptionFolderName}/${selectedFile}`;

    const title = redemption.reward_title;
    const content = redemption.user_input || `${redemption.user_name} redeemed ${redemption.reward_title}`;

    try {
      if (timerDuration) {
        await invoke('send_redemption_with_timer', {
          filePath,
          title,
          content,
          time: timerDuration
        });
        addServerLog('success', `Sent static redemption with timer (${timerDuration}s): ${selectedFile}`);
        
        const timerId = `timer_${Date.now()}_${redemption.id}`;
        setActiveTimers(prev => ({
          ...prev,
          [timerId]: {
            id: timerId,
            title,
            content,
            userName: redemption.user_name,
            totalDuration: timerDuration,
            remainingTime: timerDuration,
            startedAt: new Date()
          }
        }));
      } else {
        await invoke('send_redemption_without_timer', {
          filePath,
          title,
          content
        });
        addServerLog('success', `Sent static redemption: ${selectedFile}`);
      }
    } catch (error) {
      addServerLog('error', `Failed to send static redemption: ${error}`);
    }
  };

  const handleDynamicRedemption = async (
    redemption: RedemptionRequest, 
    config: any, 
    timerDuration: number | null
  ) => {
    try {
      const userMessage = editingRedemptions[redemption.id] || redemption.user_input || '';
      
      const message = config.dynamicTemplate
        .replace(/\[\[USER\]\]/g, redemption.user_name)
        .replace(/\[\[MESSAGE\]\]/g, userMessage);

      addServerLog('info', `Generating TTS for: "${message}"`);

      const ttsSettings = await invoke('load_tts_settings') as any;
      const isRvcMode = ttsSettings?.ttsMode === 'rvc';

      let ttsResult: any;
      if (isRvcMode) {
        ttsResult = await invoke('generate_tts', {
          mode: 'rvc',
          text: message,
          voice: ttsSettings?.ttsVoice || 'en-US-JennyNeural',
          modelFile: ttsSettings?.selectedModel,
          device: ttsSettings?.rvcSettings?.device || 'cpu',
          inferenceRate: ttsSettings?.rvcSettings?.inferenceRate || 0.75,
          filterRadius: ttsSettings?.rvcSettings?.filterRadius || 3,
          resampleRate: ttsSettings?.rvcSettings?.resampleRate || 0.25,
          protectRate: ttsSettings?.rvcSettings?.protectRate || 0.5
        });
      } else {
        ttsResult = await invoke('generate_tts', {
          mode: 'normal',
          text: message,
          voice: ttsSettings?.ttsVoice || 'en-US-JennyNeural'
        });
      }

      if (!ttsResult || !(ttsResult as any).path) {
        throw new Error('TTS generation failed - no audio path returned');
      }

      const title = redemption.reward_title;
      const content = message;
      const filePath = (ttsResult as any).path;

      addServerLog('success', `TTS generated successfully for: "${message}"`);

      setGeneratedTTS(prev => ({
        ...prev,
        [redemption.id]: {
          filePath,
          title,
          content,
          timerDuration: timerDuration || undefined
        }
      }));

      if (isClientConnected) {
        addServerLog('info', `TTS ready - use "Send to Client" button to send to connected client.`);
      } else {
        addServerLog('info', `TTS ready - no client connected. Use "Send to Client" when client is available.`);
      }

    } catch (error) {
      addServerLog('error', `Failed to generate dynamic TTS: ${error}`);
    }
  };

  const sendGeneratedTTS = async (
    redemptionId: string,
    filePath: string,
    title: string,
    content: string,
    timerDuration: number | null,
    removeFromGenerated: boolean = true
  ) => {
    try {
      if (timerDuration) {
        await invoke('send_redemption_with_timer', {
          filePath,
          title,
          content,
          time: timerDuration
        });
        addServerLog('success', `Sent dynamic TTS redemption with timer (${timerDuration}s): "${content}"`);
        
        const redemption = redemptionRequests.find(r => r.id === redemptionId);
        if (redemption) {
          const timerId = `timer_${Date.now()}_${redemptionId}`;
          setActiveTimers(prev => ({
            ...prev,
            [timerId]: {
              id: timerId,
              title,
              content,
              userName: redemption.user_name,
              totalDuration: timerDuration,
              remainingTime: timerDuration,
              startedAt: new Date()
            }
          }));
        }
      } else {
        await invoke('send_redemption_without_timer', {
          filePath,
          title,
          content
        });
        addServerLog('success', `Sent dynamic TTS redemption: "${content}"`);
      }

      if (removeFromGenerated) {
        setGeneratedTTS(prev => {
          const newState = { ...prev };
          delete newState[redemptionId];
          return newState;
        });
      }

    } catch (error) {
      addServerLog('error', `Failed to send TTS: ${error}`);
      throw error;
    }
  };

  const handleRejectRedemption = (redemption: RedemptionRequest) => {
    setRedemptionRequests(prev => prev.filter(r => r.id !== redemption.id));
    addServerLog('info', `Rejected redemption from ${redemption.user_name}`);
  };

  const handleEditUserInput = (redemptionId: string, newValue: string) => {
    setEditingRedemptions(prev => ({
      ...prev,
      [redemptionId]: newValue
    }));
  };

  const getDisplayMessage = (redemption: RedemptionRequest) => {
    return editingRedemptions[redemption.id] !== undefined 
      ? editingRedemptions[redemption.id] 
      : redemption.user_input || '';
  };

  const isMessageEdited = (redemption: RedemptionRequest) => {
    return editingRedemptions[redemption.id] !== undefined && 
           editingRedemptions[redemption.id] !== redemption.user_input;
  };

  const isDynamicTTS = (redemption: RedemptionRequest) => {
    const config = redemptionConfigs[redemption.reward_id];
    return config && config.enabled && config.ttsType === 'dynamic';
  };

  const loadRedemptionConfig = async (rewardId: string) => {
    try {
      const { load } = await import('@tauri-apps/plugin-store');
      const store = await load('redemptions.json', { autoSave: false });
      const configs = await store.get('redemptionConfigs') as Record<string, any>;
      const config = configs?.[rewardId];
      
      if (config) {
        setRedemptionConfigs(prev => ({
          ...prev,
          [rewardId]: config
        }));
      }
    } catch (error) {
      console.error('Failed to load redemption config:', error);
    }
  };

  const handleEndSession = async () => {
    if (!isServerRunning || isEndingSession) return;
    
    setIsEndingSession(true);
    try {
      await invoke('stop_listener');
      addServerLog('info', 'Server shutdown initiated');
    } catch (error) {
      console.error('Failed to stop server:', error);
      addServerLog('error', `Failed to stop server: ${error}`);
      setIsEndingSession(false);
    }
  };

  const copyConnectionInfo = () => {
    if (networkInfo) {
      navigator.clipboard.writeText(`${networkInfo.lan_ip}:${networkInfo.port}`);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-gray-900 via-black to-gray-900 flex flex-col overflow-y-auto overflow-x-hidden">
      {/* Header */}
      <div className="absolute top-0 left-0 right-0 z-10 bg-gray-900/50 backdrop-blur-sm border-b border-gray-800">
        <div className="flex items-center justify-between px-8 py-6">
          <Link to="/">
            <motion.div
              whileHover={{ x: -3 }}
              className="flex items-center text-gray-300 hover:text-white transition-colors cursor-pointer"
            >
              <ArrowLeft className="w-5 h-5 mr-2" />
              <span className="font-medium">Back to Home</span>
            </motion.div>
          </Link>
          
          <div className="flex items-center">
            <div className={`w-3 h-3 rounded-full mr-3 ${isServerRunning ? 'bg-green-400' : 'bg-red-400'}`}></div>
            <h1 className="text-xl font-semibold text-white">Server Management</h1>
          </div>

          {/* End Session Button */}
          {isServerRunning && (
            <motion.button
              whileHover={{ scale: 1.05 }}
              whileTap={{ scale: 0.95 }}
              onClick={handleEndSession}
              disabled={isEndingSession}
              className="flex items-center gap-2 px-4 py-2 bg-red-500 hover:bg-red-600 text-white rounded-lg font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {isEndingSession ? (
                <>
                  <div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin"></div>
                  Ending Session...
                </>
              ) : (
                <>
                  <Power className="w-4 h-4" />
                  End Session
                </>
              )}
            </motion.button>
          )}
        </div>
      </div>

      {/* Main Content */}
      <div className="flex-1 pt-24 pb-8 px-8 overflow-auto">
        <div className="max-w-6xl mx-auto">
          
          {/* Error Display */}
          {error && (
            <motion.div
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: 'auto' }}
              className="bg-red-900/50 border border-red-500/30 rounded-lg p-4 mb-6"
            >
              <div className="flex items-center">
                <AlertCircle className="w-5 h-5 text-red-400 mr-3" />
                <p className="text-red-300">{error}</p>
              </div>
            </motion.div>
          )}

          {/* Server Info and Active Timers Row */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-8 mb-8">
            {/* Server Info Card */}
            <motion.div
              initial={{ y: 20, opacity: 0 }}
              animate={{ y: 0, opacity: 1 }}
              transition={{ duration: 0.5 }}
              className="bg-gradient-to-br from-gray-800/60 to-gray-900/60 border border-gray-700/50 rounded-2xl p-6 backdrop-blur-sm shadow-xl"
            >
              <div className="flex flex-col h-full">
                {/* Header Section */}
                <div className="flex items-center justify-between mb-4">
                  <div className="flex items-center gap-3">
                    <div className={`p-3 rounded-xl ${isServerRunning ? 'bg-green-500/20' : 'bg-red-500/20'}`}>
                      <div className={`w-4 h-4 rounded-full ${isServerRunning ? 'bg-green-400' : 'bg-red-400'}`}></div>
                    </div>
                    <div>
                      <h2 className="text-xl font-bold text-white">Server Status</h2>
                      <p className={`text-sm font-medium ${isServerRunning ? 'text-green-400' : 'text-red-400'}`}>
                        {isServerRunning ? 'Online' : 'Offline'}
                      </p>
                    </div>
                  </div>
                  
                  {/* Status Badge */}
                  <div className={`px-3 py-1.5 rounded-full text-xs font-semibold ${
                    isServerRunning 
                      ? 'bg-green-500/20 text-green-400 border border-green-500/30' 
                      : 'bg-red-500/20 text-red-400 border border-red-500/30'
                  }`}>
                    {isServerRunning ? 'Active' : 'Inactive'}
                  </div>
                </div>

                {/* Description */}
                <p className="text-gray-400 text-sm mb-4">
                  {isServerRunning ? 'Ready to receive requests and process redemptions' : 'Server is not running'}
                </p>

                {/* Connection Status Section */}
                {isServerRunning && (
                  <div className="mb-4">
                    <div className="flex items-center gap-3 p-3 bg-gray-700/30 rounded-lg border border-gray-600/30">
                      <div className={`w-2.5 h-2.5 rounded-full ${isClientConnected ? 'bg-green-400' : 'bg-orange-400'}`}></div>
                      <div className="flex-1">
                        <p className="text-sm font-medium text-white">Client Connection</p>
                        <p className={`text-xs ${isClientConnected ? 'text-green-400' : 'text-orange-400'}`}>
                          {isClientConnected ? 'Client connected and ready' : 'Waiting for client connection'}
                        </p>
                      </div>
                      {isClientConnected && (
                        <div className="w-2 h-2 bg-green-400 rounded-full animate-pulse"></div>
                      )}
                    </div>
                  </div>
                )}

                {/* Network Info Section */}
                {networkInfo && (
                  <div className="mt-auto">
                    <div className="bg-gray-700/40 border border-gray-600/40 rounded-lg p-4">
                      <div className="flex items-center justify-between mb-2">
                        <p className="text-sm font-medium text-gray-300">Network Address</p>
                        <motion.button
                          whileHover={{ scale: 1.05 }}
                          whileTap={{ scale: 0.95 }}
                          onClick={copyConnectionInfo}
                          className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium transition-all duration-200 ${
                            copied 
                              ? 'bg-green-500/20 text-green-400 border border-green-500/30' 
                              : 'bg-cyan-500/20 text-cyan-400 border border-cyan-500/30 hover:bg-cyan-500/30'
                          }`}
                        >
                          {copied ? (
                            <>
                              <CheckCircle className="w-3 h-3" />
                              Copied!
                            </>
                          ) : (
                            <>
                              <Copy className="w-3 h-3" />
                              Copy
                            </>
                          )}
                        </motion.button>
                      </div>
                      <div className="bg-black/30 rounded-lg p-3 border border-gray-600/30">
                        <p className="text-lg font-mono text-white tracking-wide">
                          {networkInfo.lan_ip}:{networkInfo.port}
                        </p>
                      </div>
                    </div>
                  </div>
                )}
              </div>
            </motion.div>

            {/* Active Timers */}
            <motion.div
              initial={{ y: 20, opacity: 0 }}
              animate={{ y: 0, opacity: 1 }}
              transition={{ duration: 0.5, delay: 0.1 }}
              className="bg-gray-800/40 border border-gray-700/40 rounded-xl p-6"
            >
              <div className="flex items-center gap-3 mb-4">
                <Clock className="w-5 h-5 text-blue-400" />
                <h3 className="text-lg font-semibold text-white">Active Timers</h3>
                {Object.keys(activeTimers).length > 0 && (
                  <div className="ml-auto px-2 py-1 bg-blue-500/20 text-blue-400 rounded text-xs font-medium">
                    {Object.keys(activeTimers).length}
                  </div>
                )}
              </div>
              <div className="space-y-3 max-h-96 overflow-y-auto">
                {Object.keys(activeTimers).length === 0 ? (
                  <div className="text-center py-8">
                    <Clock className="w-8 h-8 text-gray-500 mx-auto mb-2" />
                    <div className="text-gray-500 text-sm">No active timers</div>
                  </div>
                ) : (
                  Object.values(activeTimers).map((timer) => {
                    const timeDisplay = formatSecondsToTime(timer.remainingTime);
                    const progress = ((timer.totalDuration - timer.remainingTime) / timer.totalDuration) * 100;
                    const isUrgent = timer.remainingTime <= 10;
                    const isWarning = timer.remainingTime <= 30;
                    
                    return (
                      <motion.div
                        key={timer.id}
                        initial={{ x: -10, opacity: 0 }}
                        animate={{ x: 0, opacity: 1 }}
                        exit={{ x: 10, opacity: 0 }}
                        className={`bg-gray-700/50 border rounded-lg p-3 ${
                          isUrgent 
                            ? 'border-red-400/50' 
                            : isWarning 
                            ? 'border-orange-400/50' 
                            : 'border-gray-600/50'
                        }`}
                      >
                        {/* Header */}
                        <div className="flex items-center justify-between mb-2">
                          <div className="flex items-center gap-2">
                            <User className="w-4 h-4 text-cyan-400" />
                            <span className="font-medium text-white text-sm">{timer.userName}</span>
                          </div>
                          <motion.button
                            whileHover={{ scale: 1.1 }}
                            whileTap={{ scale: 0.9 }}
                            onClick={() => {
                              setActiveTimers(prev => {
                                const updated = { ...prev };
                                delete updated[timer.id];
                                return updated;
                              });
                              addServerLog('info', `Cancelled timer for ${timer.userName}: "${timer.content}"`);
                            }}
                            className="p-1 text-red-400 hover:bg-red-500/20 rounded transition-colors"
                          >
                            <X className="w-3 h-3" />
                          </motion.button>
                        </div>

                        {/* Content */}
                        <p className="text-xs text-gray-400 mb-2 truncate">{timer.title}</p>
                        
                        {/* Timer */}
                        <div className="flex items-center justify-between mb-2">
                          <span className={`text-lg font-mono font-bold ${
                            isUrgent 
                              ? 'text-red-400' 
                              : isWarning 
                              ? 'text-orange-400' 
                              : 'text-green-400'
                          }`}>
                            {timeDisplay}
                          </span>
                          {isUrgent && (
                            <span className="text-xs text-red-400 font-medium animate-pulse">URGENT</span>
                          )}
                        </div>
                        
                        {/* Progress Bar */}
                        <div className="w-full bg-gray-600/50 rounded-full h-2">
                          <div 
                            className={`h-2 rounded-full transition-all duration-1000 ${
                              isUrgent 
                                ? 'bg-red-400' 
                                : isWarning 
                                ? 'bg-orange-400' 
                                : 'bg-green-400'
                            }`}
                            style={{ width: `${100 - progress}%` }}
                          />
                        </div>
                      </motion.div>
                    );
                  })
                )}
              </div>
            </motion.div>
          </div>

          {/* Redemptions and Logs Row */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
            {/* Redemptions List */}
            <motion.div
              initial={{ y: 20, opacity: 0 }}
              animate={{ y: 0, opacity: 1 }}
              transition={{ duration: 0.5, delay: 0.2 }}
              className="bg-gray-800/30 border border-gray-700/30 rounded-xl p-6"
            >
              <h3 className="text-lg font-semibold text-white mb-4">Pending Redemptions</h3>
              <div className="space-y-4 max-h-96 overflow-y-auto">
                {redemptionRequests.length === 0 ? (
                  <div className="text-center py-8">
                    <div className="text-gray-500 italic">No pending redemptions</div>
                  </div>
                ) : (
                  redemptionRequests.map((redemption) => (
                    <motion.div
                      key={redemption.id}
                      initial={{ x: -20, opacity: 0 }}
                      animate={{ x: 0, opacity: 1 }}
                      className="bg-gray-700/40 border border-gray-600/40 rounded-lg p-4"
                    >
                      <div className="flex items-start justify-between mb-3">
                        <div className="flex-1">
                          <div className="flex items-center gap-2 mb-2">
                            <User className="w-4 h-4 text-cyan-400" />
                            <span className="font-semibold text-white">{redemption.user_name}</span>
                            <span className="text-xs text-gray-400">
                              {new Date(redemption.redeemed_at).toLocaleTimeString()}
                            </span>
                          </div>
                          <div className="mb-2">
                            <span className="text-sm font-medium text-yellow-400">{redemption.reward_title}</span>
                            <span className="text-xs text-gray-400 ml-2">({redemption.reward_cost} points)</span>
                          </div>
                          {redemption.user_input && (
                            <div className="mb-2">
                              {isDynamicTTS(redemption) ? (
                                <div className="space-y-2">
                                  <div className="flex items-center gap-2">
                                    <MessageSquare className="w-4 h-4 text-gray-400" />
                                    <span className="text-sm text-gray-400">User Message (Editable):</span>
                                    {isMessageEdited(redemption) && (
                                      <span className="text-xs bg-yellow-500/20 text-yellow-400 px-2 py-0.5 rounded">
                                        Edited
                                      </span>
                                    )}
                                  </div>
                                  <textarea
                                    value={getDisplayMessage(redemption)}
                                    onChange={(e) => handleEditUserInput(redemption.id, e.target.value)}
                                    className="w-full bg-gray-600/30 border border-gray-500/30 rounded px-3 py-2 text-sm text-gray-300 resize-none focus:outline-none focus:border-blue-400 focus:ring-1 focus:ring-blue-400"
                                    rows={2}
                                    placeholder="Enter user message..."
                                  />
                                </div>
                              ) : (
                                <div className="flex items-start gap-2">
                                  <MessageSquare className="w-4 h-4 text-gray-400 mt-0.5" />
                                  <span className="text-sm text-gray-300">{redemption.user_input}</span>
                                </div>
                              )}
                            </div>
                          )}
                          {redemptionConfigs[redemption.reward_id] && (
                            <div className="flex items-center gap-2 mb-2">
                              <div className={`px-2 py-1 rounded text-xs font-medium ${
                                redemptionConfigs[redemption.reward_id].ttsType === 'dynamic' 
                                  ? 'bg-blue-500/20 text-blue-400' 
                                  : 'bg-purple-500/20 text-purple-400'
                              }`}>
                                {redemptionConfigs[redemption.reward_id].ttsType === 'dynamic' ? 'Dynamic TTS' : 'Static Audio'}
                              </div>
                              {redemptionConfigs[redemption.reward_id].timerEnabled && (
                                <div className="flex items-center gap-1 px-2 py-1 bg-orange-500/20 text-orange-400 rounded text-xs">
                                  <Clock className="w-3 h-3" />
                                  {redemptionConfigs[redemption.reward_id].timerDuration}
                                </div>
                              )}
                            </div>
                          )}
                          
                          {/* TTS Generated Status */}
                          {generatedTTS[redemption.id] && (
                            <div className="flex items-center gap-2 mb-2">
                              <div className="w-2 h-2 bg-blue-400 rounded-full"></div>
                              <span className="text-xs text-blue-400">
                                TTS Generated - {isClientConnected ? 'Ready to Send' : 'Waiting for Client'}
                              </span>
                            </div>
                          )}
                        </div>
                      </div>
                      <div className="flex gap-2">
                        {/* Show Send to Client button */}
                        {generatedTTS[redemption.id] && (
                          <motion.button
                            whileHover={isClientConnected ? { scale: 1.05 } : {}}
                            whileTap={isClientConnected ? { scale: 0.95 } : {}}
                            onClick={async () => {
                              const tts = generatedTTS[redemption.id];
                              if (tts && isClientConnected) {
                                try {
                                  await sendGeneratedTTS(redemption.id, tts.filePath, tts.title, tts.content, tts.timerDuration || null);
                                  setRedemptionRequests(prev => prev.filter(r => r.id !== redemption.id));
                                } catch (error) {
                                }
                              }
                            }}
                            disabled={!isClientConnected}
                            className={`flex items-center gap-2 px-3 py-2 rounded-lg font-medium transition-colors ${
                              isClientConnected 
                                ? 'bg-blue-500 hover:bg-blue-600 text-white' 
                                : 'bg-gray-500 text-gray-300 cursor-not-allowed'
                            }`}
                          >
                            <Copy className="w-4 h-4" />
                            {isClientConnected ? 'Send to Client' : 'No Client Connected'}
                          </motion.button>
                        )}
                        
                        {/* Accept/Reject buttons */}
                        {!generatedTTS[redemption.id] && (
                          <>
                            <motion.button
                              whileHover={{ scale: 1.05 }}
                              whileTap={{ scale: 0.95 }}
                              onClick={() => handleAcceptRedemption(redemption)}
                              disabled={processingRedemptions.has(redemption.id)}
                              className="flex items-center gap-2 px-3 py-2 bg-green-500 hover:bg-green-600 text-white rounded-lg font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                            >
                              {processingRedemptions.has(redemption.id) ? (
                                <>
                                  <div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin"></div>
                                  Processing
                                </>
                              ) : (
                                <>
                                  <Check className="w-4 h-4" />
                                  Accept
                                </>
                              )}
                            </motion.button>
                            <motion.button
                              whileHover={{ scale: 1.05 }}
                              whileTap={{ scale: 0.95 }}
                              onClick={() => handleRejectRedemption(redemption)}
                              disabled={processingRedemptions.has(redemption.id)}
                              className="flex items-center gap-2 px-3 py-2 bg-red-500 hover:bg-red-600 text-white rounded-lg font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                            >
                              <X className="w-4 h-4" />
                              Reject
                            </motion.button>
                          </>
                        )}

                        {generatedTTS[redemption.id] && (
                          <motion.button
                            whileHover={{ scale: 1.05 }}
                            whileTap={{ scale: 0.95 }}
                            onClick={() => {
                              handleRejectRedemption(redemption);
                              setGeneratedTTS(prev => {
                                const newState = { ...prev };
                                delete newState[redemption.id];
                                return newState;
                              });
                            }}
                            className="flex items-center gap-2 px-3 py-2 bg-red-500 hover:bg-red-600 text-white rounded-lg font-medium transition-colors"
                          >
                            <X className="w-4 h-4" />
                            Discard
                          </motion.button>
                        )}
                      </div>
                    </motion.div>
                  ))
                )}
              </div>
            </motion.div>

            {/* Server Logs */}
            <motion.div
              initial={{ y: 20, opacity: 0 }}
              animate={{ y: 0, opacity: 1 }}
              transition={{ duration: 0.5, delay: 0.3 }}
              className="bg-gray-800/30 border border-gray-700/30 rounded-xl p-6"
            >
              <div className="flex items-center justify-between mb-4">
                <h3 className="text-lg font-semibold text-white">Server Logs</h3>
                <div className="flex items-center gap-2">
                  {!autoScroll && (
                    <motion.button
                      whileHover={{ scale: 1.05 }}
                      whileTap={{ scale: 0.95 }}
                      onClick={scrollToBottom}
                      className="flex items-center gap-1 px-2 py-1 rounded-lg text-xs font-medium bg-blue-500/20 text-blue-400 border border-blue-500/30 hover:bg-blue-500/30 transition-all duration-200"
                      title="Scroll to bottom"
                    >
                      <ArrowDown className="w-3 h-3" />
                    </motion.button>
                  )}
                  <motion.button
                    whileHover={{ scale: 1.05 }}
                    whileTap={{ scale: 0.95 }}
                    onClick={() => setAutoScroll(!autoScroll)}
                    className={`flex items-center gap-2 px-3 py-1.5 rounded-lg text-xs font-medium transition-all duration-200 ${
                      autoScroll 
                        ? 'bg-green-500/20 text-green-400 border border-green-500/30' 
                        : 'bg-gray-500/20 text-gray-400 border border-gray-500/30 hover:bg-gray-500/30'
                    }`}
                    title={autoScroll ? 'Auto-scroll enabled' : 'Auto-scroll disabled'}
                  >
                    {autoScroll ? (
                      <>
                        <ArrowDownCircle className="w-3 h-3" />
                        Auto-scroll ON
                      </>
                    ) : (
                      <>
                        <ArrowDown className="w-3 h-3" />
                        Auto-scroll OFF
                      </>
                    )}
                  </motion.button>
                </div>
              </div>
              <div 
                ref={logsContainerRef}
                className="bg-black/40 rounded-lg p-4 font-mono text-sm text-gray-300 h-96 overflow-y-auto"
              >
                {isServerRunning && networkInfo ? (
                  <div className="space-y-1">
                    <div className="text-green-400">[INFO] Server started on {networkInfo.lan_ip}:{networkInfo.port}</div>
                    <div className="text-cyan-400">[INFO] Listening for connections</div>
                    <div className="text-purple-400">[INFO] TTS system ready</div>
                    <div className="text-gray-300">[INFO] Ready to receive requests</div>
                    {/* Dynamic server logs */}
                    {serverLogs.map((log, index) => (
                      <div 
                        key={index}
                        className={`${
                          log.type === 'error' ? 'text-red-400' :
                          log.type === 'success' ? 'text-green-400' :
                          'text-yellow-400'
                        }`}
                      >
                        [{log.timestamp}] {log.message}
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="text-gray-500 italic">Server is offline. Start the server to see logs.</div>
                )}
              </div>
            </motion.div>
          </div>
        </div>
      </div>
    </div>
  );
};

export default ServerPage;
