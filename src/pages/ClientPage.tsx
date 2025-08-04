import { motion } from 'framer-motion';
import { useState, useEffect } from 'react';
import { ArrowLeft, Wifi, WifiOff, Pause, Volume2, Clock, User, MessageSquare, AlertCircle, RefreshCw } from 'lucide-react';
import { Link } from 'react-router-dom';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';

interface RedemptionData {
  id: string;
  title: string;
  content: string;
  filePath: string;
  timerDuration?: number;
  receivedAt: Date;
}

interface TimerData {
  id: string;
  title: string;
  content: string;
  userName: string;
  totalDuration: number;
  remainingTime: number;
  startedAt: Date;
}

const ClientPage = () => {
   const [serverAddress, setServerAddress] = useState('');
   const [isConnecting, setIsConnecting] = useState(false);
   const [error, setError] = useState<string | null>(null);
   const [pairingCode, setPairingCode] = useState<string | null>(null);
   const [connectionState, setConnectionState] = useState<'disconnected' | 'connecting' | 'pairing' | 'connected'>('disconnected');
   const [logs, setLogs] = useState<Array<{type: 'info' | 'error' | 'success', message: string}>>([]);

   const [latestRedemption, setLatestRedemption] = useState<RedemptionData | null>(null);
   const [activeTimers, setActiveTimers] = useState<Record<string, TimerData>>({});
   const [isPlaying, setIsPlaying] = useState(false);
   const [isLoadingAudio, setIsLoadingAudio] = useState(false);
   const [audioDeviceId, setAudioDeviceId] = useState<string>('default');
   const [currentAudio, setCurrentAudio] = useState<HTMLAudioElement | null>(null);

   const addLog = (type: 'info' | 'error' | 'success', message: string) => {
      setLogs(prev => [...prev, { type, message }].slice(-10)); 
   };

   useEffect(() => {
      const loadAudioSettings = async () => {
         try {
            const { load } = await import('@tauri-apps/plugin-store');
            const store = await load('audio-settings.json', { autoSave: false });
            const settings = await store.get('audioSettings') as any;
            if (settings?.outputDevice) {
               setAudioDeviceId(settings.outputDevice);
            }
         } catch (error) {
            console.error('Failed to load audio settings:', error);
         }
      };
      loadAudioSettings();
   }, []);

   useEffect(() => {
      const timerInterval = setInterval(() => {
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
                  addLog('info', `Timer completed: ${updated[timerId]?.title || 'Unknown'}`);
               }
            });

            return hasChanges ? updated : prev;
         });
      }, 1000); 

      return () => clearInterval(timerInterval);
   }, []);

   const formatSecondsToTime = (totalSeconds: number): string => {
      const minutes = Math.floor(totalSeconds / 60);
      const seconds = totalSeconds % 60;
      return `${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
   };

   const playAudio = async (base64Data: string, mimeType: string = 'audio/mpeg') => {
      try {
         if (currentAudio) {
            currentAudio.pause();
            currentAudio.currentTime = 0;
         }

         if (!base64Data || base64Data.trim() === '') {
            throw new Error('No audio data provided');
         }

         let cleanBase64 = base64Data;
         if (base64Data.includes(',')) {
            cleanBase64 = base64Data.split(',')[1];
         }

         setIsLoadingAudio(true);
         setIsPlaying(false);
         
         let audioBlob: Blob;
         try {
            const binaryData = Uint8Array.from(atob(cleanBase64), c => c.charCodeAt(0));
            audioBlob = new Blob([binaryData], { type: mimeType });
         } catch (error) {
            throw new Error('Invalid base64 audio data');
         }
         
         const audioUrl = URL.createObjectURL(audioBlob);
         const audio = new Audio(audioUrl);
         
         if ('setSinkId' in audio && audioDeviceId !== 'default') {
            try {
               await (audio as any).setSinkId(audioDeviceId);
               addLog('info', `Audio output set to device: ${audioDeviceId}`);
            } catch (error) {
               console.warn('Failed to set audio output device:', error);
               addLog('info', 'Using default audio device (device selection not supported)');
            }
         }

         audio.onended = () => {
            setIsPlaying(false);
            setIsLoadingAudio(false);
            setCurrentAudio(null);
            URL.revokeObjectURL(audioUrl);
            addLog('info', 'Audio playback completed');
         };

         audio.onerror = (event) => {
            setIsPlaying(false);
            setIsLoadingAudio(false);
            setCurrentAudio(null);
            URL.revokeObjectURL(audioUrl);
            addLog('error', 'Audio playback failed - file may be corrupted');
            console.error('Audio error:', event);
         };

         audio.onloadstart = () => {
            addLog('info', 'Loading audio...');
         };

         audio.oncanplay = () => {
            setIsLoadingAudio(false);
            setIsPlaying(true);
            addLog('info', 'Audio ready to play');
         };

         setCurrentAudio(audio);
         await audio.play();

         addLog('success', 'Audio playback started');
      } catch (error) {
         console.error('Failed to play audio:', error);
         addLog('error', `Audio playback failed: ${error}`);
         setIsPlaying(false);
         setIsLoadingAudio(false);
         setCurrentAudio(null);
      }
   };

   const stopAudio = () => {
      if (currentAudio) {
         currentAudio.pause();
         currentAudio.currentTime = 0;
         setCurrentAudio(null);
         setIsPlaying(false);
         setIsLoadingAudio(false);
         addLog('info', 'Audio playback stopped');
      }
   };

   const replayAudio = async () => {
      if (latestRedemption && latestRedemption.filePath) {
         await playAudio(latestRedemption.filePath);
      }
   };

   useEffect(() => {
      const unlistenStatus = listen('STATUS_UPDATE', (event) => {
         const message = event.payload as string;
         console.log('Client status:', message);
         addLog('info', message);
         
         if (message.includes('Connecting to')) {
            setConnectionState('connecting');
         } else if (
            message.includes('New peer') ||
            message.includes('Known peer found') ||
            message.includes('Challenge received') ||
            message.includes('Authentication') ||
            message.toLowerCase().includes('both peers confirmed')
         ) {
            setConnectionState('pairing');
         }
      });

      const unlistenPairing = listen('PAIRING_REQUIRED', (event) => {
         const code = event.payload as string;
         console.log('Pairing code required:', code);
         setPairingCode(code);
         setConnectionState('pairing');
         addLog('info', `Pairing code: ${code}`);
      });

      const unlistenSuccess = listen('SUCCESS', (event) => {
         const message = event.payload as string;
         console.log('Connection success:', message);
         addLog('success', message);
         
         if (message.includes('Secure encrypted channel established')) {
            setConnectionState('connected');
            setIsConnecting(false);
            setPairingCode(null);
            setError(null);
         }
      });

      const unlistenRedemption = listen('REDEMPTION_RECEIVED', async (event) => {
         const redemptionData = event.payload as any;
         console.log('Redemption received:', redemptionData);

         let parsedData = redemptionData;
         if (typeof redemptionData === 'string') {
            try {
               parsedData = JSON.parse(redemptionData);
            } catch (error) {
               console.error('Failed to parse redemption data:', error);
               addLog('error', 'Failed to parse redemption data');
               return;
            }
         }

         const redemption: RedemptionData = {
            id: parsedData.id || `redemption_${Date.now()}`,
            title: parsedData.title || 'Unknown Redemption',
            content: parsedData.content || '',
            filePath: parsedData.filePath || parsedData.file_path || parsedData.audioData || '',
            timerDuration: parsedData.timerDuration || parsedData.timer_duration || parsedData.time,
            receivedAt: new Date()
         };

         setLatestRedemption(redemption);
         addLog('success', `Redemption received: ${redemption.title}`);

         if (redemption.timerDuration && redemption.timerDuration > 0) {
            const timerId = `timer_${Date.now()}_${redemption.id}`;
            setActiveTimers(prev => ({
               ...prev,
               [timerId]: {
                  id: timerId,
                  title: redemption.title,
                  content: redemption.content,
                  userName: parsedData.userName || 'Server',
                  totalDuration: redemption.timerDuration!,
                  remainingTime: redemption.timerDuration!,
                  startedAt: new Date()
               }
            }));
            addLog('info', `Timer started: ${redemption.timerDuration}s for "${redemption.title}"`);
         }

         if (redemption.filePath) {
            await playAudio(redemption.filePath);
         }
      });

      const unlistenError = listen('ERROR', (event) => {
         const errorMessage = event.payload as string;
         console.error('P2P error:', errorMessage);
         setError(errorMessage);
         addLog('error', errorMessage);
         setIsConnecting(false);
         setConnectionState('disconnected');
         setPairingCode(null);
      });

      return () => {
         unlistenStatus.then(f => f());
         unlistenPairing.then(f => f());
         unlistenSuccess.then(f => f());
         unlistenRedemption.then(f => f());
         unlistenError.then(f => f());
      };
   }, [audioDeviceId]);

   const handleConnect = async () => {
      if (!serverAddress.trim()) return;

      setIsConnecting(true);
      setError(null);
      setConnectionState('connecting');
      addLog('info', `Attempting to connect to ${serverAddress}`);
      
      try {
         await invoke('start_initiator', { address: serverAddress });
      } catch (error) {
         console.error('Failed to start connection:', error);
         setError(`Failed to connect: ${error}`);
         addLog('error', `Connection failed: ${error}`);
         setIsConnecting(false);
         setConnectionState('disconnected');
      }
   };

   const handleConfirmPairing = async () => {
      try {
         await invoke('user_confirm_pairing');
         setConnectionState('pairing');
         addLog('info', 'Pairing confirmed locally. Waiting for the other side to confirm...');
      } catch (error) {
         console.error('Failed to confirm pairing:', error);
         setError(`Failed to confirm pairing: ${error}`);
         addLog('error', `Pairing confirmation failed: ${error}`);
      }
   };

   const handleDisconnect = async () => {
      try {
         await invoke('disconnect_client');
         setConnectionState('disconnected');
         setIsConnecting(false);
         setPairingCode(null);
         setError(null);
         addLog('info', 'Disconnected from server');
      } catch (error) {
         console.error('Failed to disconnect:', error);
         addLog('error', `Disconnect failed: ${error}`);
      }
   };

   return (
      <div className="min-h-screen bg-gradient-to-br from-gray-900 via-black to-gray-900 flex flex-col">
         {/* Header */}
         <div className="bg-gray-900/50 backdrop-blur-sm border-b border-gray-800">
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
                  <div className={`w-3 h-3 rounded-full mr-3 ${connectionState === 'connected' ? 'bg-green-400' : 'bg-red-400'}`}></div>
                  <h1 className="text-xl font-semibold text-white">Client Mode</h1>
               </div>

               {/* Connection Status */}
               <div className={`px-3 py-1.5 rounded-full text-xs font-semibold ${
                  connectionState === 'connected' 
                     ? 'bg-green-500/20 text-green-400 border border-green-500/30' 
                     : 'bg-red-500/20 text-red-400 border border-red-500/30'
               }`}>
                  {connectionState === 'connected' ? 'Connected' : 'Disconnected'}
               </div>
            </div>
         </div>

         {/* Main Content */}
         <div className="flex-1 p-8 overflow-auto">
            <div className="max-w-6xl mx-auto space-y-8">
               
               {/* Error Display */}
               {error && (
                  <motion.div
                     initial={{ opacity: 0, height: 0 }}
                     animate={{ opacity: 1, height: 'auto' }}
                     className="bg-red-900/50 border border-red-500/30 rounded-lg p-4"
                  >
                     <div className="flex items-center">
                        <AlertCircle className="w-5 h-5 text-red-400 mr-3" />
                        <p className="text-red-300">{error}</p>
                     </div>
                  </motion.div>
               )}

               {/* Connection Section */}
               {connectionState === 'disconnected' && (
                  <motion.div
                     initial={{ y: 20, opacity: 0 }}
                     animate={{ y: 0, opacity: 1 }}
                     className="bg-gray-800/40 border border-gray-700/40 rounded-xl p-6"
                  >
                     <h2 className="text-xl font-bold text-white mb-4">Connect to Server</h2>
                     <div className="space-y-4">
                        <div>
                           <label className="block text-sm font-medium text-gray-300 mb-2">
                              Server Address (IP:Port)
                           </label>
                           <input
                              type="text"
                              value={serverAddress}
                              onChange={(e) => setServerAddress(e.target.value)}
                              placeholder="192.168.1.100:12345"
                              className="w-full bg-gray-700/50 border border-gray-600/50 rounded-lg px-4 py-3 text-white placeholder-gray-400 focus:outline-none focus:border-blue-400 focus:ring-1 focus:ring-blue-400"
                              disabled={isConnecting}
                           />
                        </div>
                        <motion.button
                           whileHover={{ scale: 1.02 }}
                           whileTap={{ scale: 0.98 }}
                           onClick={handleConnect}
                           disabled={isConnecting || !serverAddress.trim()}
                           className="w-full bg-blue-500 hover:bg-blue-600 text-white font-medium py-3 rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
                        >
                           {isConnecting ? (
                              <>
                                 <div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin"></div>
                                 Connecting...
                              </>
                           ) : (
                              <>
                                 <Wifi className="w-4 h-4" />
                                 Connect
                              </>
                           )}
                        </motion.button>
                     </div>
                  </motion.div>
               )}

               {/* Pairing Section */}
               {connectionState === 'pairing' && pairingCode && (
                  <motion.div
                     initial={{ y: 20, opacity: 0 }}
                     animate={{ y: 0, opacity: 1 }}
                     className="bg-yellow-900/20 border border-yellow-500/30 rounded-xl p-6"
                  >
                     <h2 className="text-xl font-bold text-white mb-4">Pairing Required</h2>
                     <p className="text-gray-300 mb-4">
                        Enter this pairing code on the server to establish a secure connection:
                     </p>
                     <div className="bg-black/40 border border-yellow-500/30 rounded-lg p-4 mb-4">
                        <p className="text-2xl font-mono font-bold text-yellow-400 text-center tracking-wider">
                           {pairingCode}
                        </p>
                     </div>
                     <motion.button
                        whileHover={{ scale: 1.02 }}
                        whileTap={{ scale: 0.98 }}
                        onClick={handleConfirmPairing}
                        className="w-full py-2 bg-yellow-500/30 text-yellow-300 font-semibold rounded-xl hover:bg-yellow-500/40 transition-colors duration-200 mb-4"
                     >
                        Confirm Pairing
                     </motion.button>
                     <p className="text-sm text-gray-400">
                        After confirming, please wait for the other side. The connection will complete automatically once both sides confirm.
                     </p>
                  </motion.div>
               )}

               {/* Connected Content */}
               {connectionState === 'connected' && (
                  <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
                     {/* Latest Redemption */}
                     <motion.div
                        initial={{ y: 20, opacity: 0 }}
                        animate={{ y: 0, opacity: 1 }}
                        transition={{ duration: 0.5 }}
                        className="bg-gradient-to-br from-gray-800/60 to-gray-900/60 border border-gray-700/50 rounded-xl p-6"
                     >
                        <div className="flex items-center justify-between mb-4">
                           <h3 className="text-lg font-semibold text-white">Latest Redemption</h3>
                           <div className="flex items-center gap-2">
                              {latestRedemption && (
                                 <motion.button
                                    whileHover={{ scale: 1.05 }}
                                    whileTap={{ scale: 0.95 }}
                                    onClick={() => {
                                       if (isPlaying) {
                                          stopAudio();
                                       } else {
                                          replayAudio();
                                       }
                                    }}
                                    disabled={isLoadingAudio}
                                    className={`flex items-center gap-2 px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${
                                       isLoadingAudio
                                          ? 'bg-gray-500/20 text-gray-400 border border-gray-500/30 cursor-not-allowed'
                                          : isPlaying 
                                          ? 'bg-red-500/20 text-red-400 border border-red-500/30'
                                          : 'bg-blue-500/20 text-blue-400 border border-blue-500/30 hover:bg-blue-500/30'
                                    }`}
                                 >
                                    {isLoadingAudio ? (
                                       <>
                                          <div className="w-3 h-3 border border-gray-400/30 border-t-gray-400 rounded-full animate-spin"></div>
                                          Loading
                                       </>
                                    ) : isPlaying ? (
                                       <>
                                          <Pause className="w-3 h-3" />
                                          Stop
                                       </>
                                    ) : (
                                       <>
                                          <RefreshCw className="w-3 h-3" />
                                          Replay
                                       </>
                                    )}
                                 </motion.button>
                              )}
                           </div>
                        </div>

                        {latestRedemption ? (
                           <div className="space-y-4">
                              {/* Redemption Header */}
                              <div className="bg-gray-700/40 border border-gray-600/40 rounded-lg p-4">
                                 <div className="flex items-center gap-3 mb-2">
                                    <div className="p-2 bg-blue-500/20 rounded-lg">
                                       <MessageSquare className="w-4 h-4 text-blue-400" />
                                    </div>
                                    <div className="flex-1">
                                       <h4 className="font-semibold text-white">{latestRedemption.title}</h4>
                                       <p className="text-xs text-gray-400">
                                          Received at {latestRedemption.receivedAt.toLocaleTimeString()}
                                       </p>
                                    </div>
                                 </div>
                                 
                                 {latestRedemption.content && (
                                    <div className="mt-3 p-3 bg-gray-600/30 rounded-lg">
                                       <p className="text-sm text-gray-300">{latestRedemption.content}</p>
                                    </div>
                                 )}

                                 {/* Timer Info */}
                                 {latestRedemption.timerDuration && (
                                    <div className="mt-3 flex items-center gap-2 text-xs text-orange-400">
                                       <Clock className="w-3 h-3" />
                                       <span>Timer: {formatSecondsToTime(latestRedemption.timerDuration)}</span>
                                    </div>
                                 )}
                              </div>

                              {/* Audio Controls */}
                              <div className="bg-gray-700/30 border border-gray-600/30 rounded-lg p-4">
                                 <div className="flex items-center justify-between">
                                    <div className="flex items-center gap-3">
                                       <Volume2 className="w-4 h-4 text-gray-400" />
                                       <div>
                                          <p className="text-sm font-medium text-white">Audio Playback</p>
                                          <p className="text-xs text-gray-400">
                                             {isLoadingAudio ? 'Loading audio...' : isPlaying ? 'Currently playing...' : 'Ready to play'}
                                          </p>
                                       </div>
                                    </div>
                                    
                                    <div className={`w-3 h-3 rounded-full ${
                                       isLoadingAudio ? 'bg-yellow-400 animate-pulse' : 
                                       isPlaying ? 'bg-green-400 animate-pulse' : 'bg-gray-500'
                                    }`}></div>
                                 </div>
                              </div>
                           </div>
                        ) : (
                           <div className="text-center py-12">
                              <MessageSquare className="w-12 h-12 text-gray-500 mx-auto mb-4" />
                              <p className="text-gray-500">No redemptions received yet</p>
                              <p className="text-xs text-gray-600 mt-1">Waiting for server data...</p>
                           </div>
                        )}
                     </motion.div>

                     {/* Active Timers */}
                     <motion.div
                        initial={{ y: 20, opacity: 0 }}
                        animate={{ y: 0, opacity: 1 }}
                        transition={{ duration: 0.5, delay: 0.1 }}
                        className="bg-gray-800/40 border border-gray-700/40 rounded-xl p-6"
                     >
                        <div className="flex items-center gap-3 mb-4">
                           <Clock className="w-5 h-5 text-orange-400" />
                           <h3 className="text-lg font-semibold text-white">Active Timers</h3>
                           {Object.keys(activeTimers).length > 0 && (
                              <div className="ml-auto px-2 py-1 bg-orange-500/20 text-orange-400 rounded text-xs font-medium">
                                 {Object.keys(activeTimers).length}
                              </div>
                           )}
                        </div>

                        <div className="space-y-3 max-h-96 overflow-y-auto">
                           {Object.keys(activeTimers).length === 0 ? (
                              <div className="text-center py-12">
                                 <Clock className="w-12 h-12 text-gray-500 mx-auto mb-4" />
                                 <p className="text-gray-500">No active timers</p>
                                 <p className="text-xs text-gray-600 mt-1">Timers will appear here when redemptions with timers are received</p>
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
                                       className={`bg-gray-700/50 border rounded-lg p-4 ${
                                          isUrgent 
                                             ? 'border-red-400/50' 
                                             : isWarning 
                                             ? 'border-orange-400/50' 
                                             : 'border-gray-600/50'
                                       }`}
                                    >
                                       {/* Timer Header */}
                                       <div className="flex items-center justify-between mb-3">
                                          <div className="flex items-center gap-2">
                                             <User className="w-4 h-4 text-cyan-400" />
                                             <span className="font-medium text-white text-sm">{timer.userName}</span>
                                          </div>
                                          <span className={`text-xl font-mono font-bold ${
                                             isUrgent 
                                                ? 'text-red-400' 
                                                : isWarning 
                                                ? 'text-orange-400' 
                                                : 'text-green-400'
                                          }`}>
                                             {timeDisplay}
                                          </span>
                                       </div>

                                       {/* Timer Details */}
                                       <div className="mb-3">
                                          <p className="text-sm font-medium text-white mb-1">{timer.title}</p>
                                          {timer.content && (
                                             <p className="text-xs text-gray-400 truncate">{timer.content}</p>
                                          )}
                                       </div>

                                       {/* Progress Bar */}
                                       <div className="mb-2">
                                          <div className="flex items-center justify-between text-xs text-gray-400 mb-1">
                                             <span>Progress</span>
                                             <span>{Math.round(progress)}%</span>
                                          </div>
                                          <div className="w-full bg-gray-600/50 rounded-full h-2">
                                             <div 
                                                className={`h-2 rounded-full transition-all duration-1000 ${
                                                   isUrgent 
                                                      ? 'bg-red-400' 
                                                      : isWarning 
                                                      ? 'bg-orange-400' 
                                                      : 'bg-green-400'
                                                }`}
                                                style={{ width: `${progress}%` }}
                                             />
                                          </div>
                                       </div>

                                       {/* Urgency Indicator */}
                                       {isUrgent && (
                                          <div className="text-center">
                                             <span className="text-xs text-red-400 font-medium animate-pulse bg-red-500/20 px-2 py-1 rounded">
                                                ⚠️ URGENT - TIME ALMOST UP!
                                             </span>
                                          </div>
                                       )}
                                    </motion.div>
                                 );
                              })
                           )}
                        </div>
                     </motion.div>
                  </div>
               )}

               {/* Disconnect Button */}
               {connectionState === 'connected' && (
                  <motion.div
                     initial={{ y: 20, opacity: 0 }}
                     animate={{ y: 0, opacity: 1 }}
                     className="text-center"
                  >
                     <motion.button
                        whileHover={{ scale: 1.02 }}
                        whileTap={{ scale: 0.98 }}
                        onClick={handleDisconnect}
                        className="bg-red-500 hover:bg-red-600 text-white font-medium py-3 px-6 rounded-lg transition-colors flex items-center gap-2 mx-auto"
                     >
                        <WifiOff className="w-4 h-4" />
                        Disconnect
                     </motion.button>
                  </motion.div>
               )}

               {/* Connection Log */}
               <motion.div
                  initial={{ y: 20, opacity: 0 }}
                  animate={{ y: 0, opacity: 1 }}
                  transition={{ duration: 0.5, delay: 0.4 }}
                  className="bg-gray-800/30 border border-gray-700/30 rounded-xl p-6"
               >
                  <h3 className="text-lg font-semibold text-white mb-4">Activity Log</h3>
                  <div className="bg-black/40 rounded-lg p-4 font-mono text-sm text-gray-300 h-32 overflow-y-auto">
                     {logs.length === 0 ? (
                        <div className="text-gray-500 italic">No activity yet</div>
                     ) : (
                        <div className="space-y-1">
                           {logs.map((log, index) => (
                              <div 
                                 key={index}
                                 className={`${
                                    log.type === 'error' ? 'text-red-400' :
                                    log.type === 'success' ? 'text-green-400' :
                                    'text-cyan-400'
                                 }`}
                              >
                                 [{log.type.toUpperCase()}] {log.message}
                              </div>
                           ))}
                        </div>
                     )}
                  </div>
               </motion.div>
            </div>
         </div>
      </div>
   );
};

export default ClientPage;
