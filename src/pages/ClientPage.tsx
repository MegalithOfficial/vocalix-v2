import { motion } from 'framer-motion';
import { useState, useEffect, useRef } from 'react';
import { ArrowLeft, Wifi, WifiOff, Pause, Clock, User, MessageSquare, AlertCircle, RefreshCw, ChevronDown, ChevronUp, List } from 'lucide-react';
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

   const [recentServers, setRecentServers] = useState<string[]>([]);
   const [autoConnectEnabled, setAutoConnectEnabled] = useState<boolean>(false);
   const [autoConnectAddress, setAutoConnectAddress] = useState<string>('');
   const [manualOverride, setManualOverride] = useState<boolean>(false);
   const settingsStoreRef = useRef<any>(null);
   const autoConnectAttemptedRef = useRef(false);
   const retryIntervalRef = useRef<ReturnType<typeof setTimeout> | null>(null);

   const [latestRedemption, setLatestRedemption] = useState<RedemptionData | null>(null);
   const [activeTimers, setActiveTimers] = useState<Record<string, TimerData>>({});
   const [isPlaying, setIsPlaying] = useState(false);
   const [isLoadingAudio, setIsLoadingAudio] = useState(false);
   const [audioDeviceId, setAudioDeviceId] = useState<string>('default');
   const [currentAudio, setCurrentAudio] = useState<HTMLAudioElement | null>(null);
   const [audioSrc, setAudioSrc] = useState<string | null>(null);

   const [showLog, setShowLog] = useState(false); // hidden by default per new requirement
   const [autoScrollLog, setAutoScrollLog] = useState(true);
   const logContainerRef = useRef<HTMLDivElement>(null);

   const addLog = (type: 'info' | 'error' | 'success', message: string) => {
      setLogs(prev => [...prev, { type, message }].slice(-10)); 
   };
   useEffect(() => {
      if (autoScrollLog && logContainerRef.current) {
         logContainerRef.current.scrollTop = logContainerRef.current.scrollHeight;
      }
   }, [logs, autoScrollLog]);

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
         
         if (audioSrc) {
            URL.revokeObjectURL(audioSrc);
         }
         
         setAudioSrc(audioUrl);

         const audioElement = document.getElementById('main-audio') as HTMLAudioElement;
         if (audioElement) {
            audioElement.src = audioUrl;
            
            if ('setSinkId' in audioElement && audioDeviceId !== 'default') {
               try {
                  await (audioElement as any).setSinkId(audioDeviceId);
                  addLog('info', `Audio output set to device: ${audioDeviceId}`);
               } catch (error) {
                  console.warn('Failed to set audio output device:', error);
                  addLog('info', 'Using default audio device (device selection not supported)');
               }
            }

            audioElement.onended = () => {
               setIsPlaying(false);
               setIsLoadingAudio(false);
               setCurrentAudio(null);
               URL.revokeObjectURL(audioUrl);
               setAudioSrc(null);
               addLog('info', 'Audio playback completed');
            };

            audioElement.onerror = (event) => {
               setIsPlaying(false);
               setIsLoadingAudio(false);
               setCurrentAudio(null);
               URL.revokeObjectURL(audioUrl);
               setAudioSrc(null);
               addLog('error', 'Audio playback failed - file may be corrupted');
               console.error('Audio error:', event);
            };

            audioElement.onloadstart = () => {
               addLog('info', 'Loading audio...');
            };

            audioElement.oncanplay = () => {
               setIsLoadingAudio(false);
               setIsPlaying(true);
               addLog('info', 'Audio ready to play');
            };

            setCurrentAudio(audioElement);
            await audioElement.play();

            addLog('success', 'Audio playback started');
         } else {
            throw new Error('Audio element not found in DOM');
         }
      } catch (error) {
         console.error('Failed to play audio:', error);
         addLog('error', `Audio playback failed: ${error}`);
         setIsPlaying(false);
         setIsLoadingAudio(false);
         setCurrentAudio(null);
         if (audioSrc) {
            URL.revokeObjectURL(audioSrc);
            setAudioSrc(null);
         }
      }
   };

   const stopAudio = () => {
      const audioElement = document.getElementById('main-audio') as HTMLAudioElement;
      if (audioElement) {
         audioElement.pause();
         audioElement.currentTime = 0;
      }
      if (currentAudio) {
         currentAudio.pause();
         currentAudio.currentTime = 0;
      }
      setCurrentAudio(null);
      setIsPlaying(false);
      setIsLoadingAudio(false);
      if (audioSrc) {
         URL.revokeObjectURL(audioSrc);
         setAudioSrc(null);
      }
      addLog('info', 'Audio playback stopped');
   };

   const replayAudio = async () => {
      if (latestRedemption && (latestRedemption.filePath || audioSrc)) {
         if (latestRedemption.filePath) {
            await playAudio(latestRedemption.filePath);
         } else if (audioSrc) {
            const audioElement = document.getElementById('main-audio') as HTMLAudioElement;
            if (audioElement) {
               audioElement.currentTime = 0;
               await audioElement.play();
               setIsPlaying(true);
               addLog('info', 'Replaying audio');
            }
         }
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
            persistRecentServer(serverAddress);
         }
      });

      const unlistenClientConnected = listen('CLIENT_CONNECTED', () => {
         setConnectionState('connected');
         setIsConnecting(false);
         setPairingCode(null);
         addLog('success', 'Client connected (event)');
         persistRecentServer(serverAddress);
      });
      const unlistenClientDisconnected = listen('CLIENT_DISCONNECTED', () => {
         setConnectionState('disconnected');
         setIsConnecting(false);
         setPairingCode(null);
         addLog('info', 'Disconnected (event)');
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
         if (audioSrc) {
            URL.revokeObjectURL(audioSrc);
         }
         const audioElement = document.getElementById('main-audio') as HTMLAudioElement;
         if (audioElement) {
            audioElement.pause();
            audioElement.src = '';
         }
         
         unlistenStatus.then(f => f());
         unlistenPairing.then(f => f());
         unlistenSuccess.then(f => f());
         unlistenClientConnected.then(f => f());
         unlistenClientDisconnected.then(f => f());
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

   const persistRecentServer = async (addr: string) => {
      const address = addr.trim();
      if (!address) return;
      try {
         if (!settingsStoreRef.current) {
            const { load } = await import('@tauri-apps/plugin-store');
            settingsStoreRef.current = await load('client-settings.json', { autoSave: true });
         }
         let current: string[] = (await settingsStoreRef.current.get('recentServers')) as string[] || [];
         current = [address, ...current.filter(a => a !== address)];
         if (current.length > 8) current = current.slice(0, 8);
         await settingsStoreRef.current.set('recentServers', current);
         setRecentServers(current);
      } catch (e) {
         console.warn('Failed to persist recent server:', e);
      }
   };

   useEffect(() => {
      const loadClientSettings = async () => {
         try {
            const { load } = await import('@tauri-apps/plugin-store');
            const store = await load('client-settings.json', { autoSave: true });
            settingsStoreRef.current = store;
            const recents = (await store.get('recentServers')) as string[] | undefined;
            const autoEn = (await store.get('autoConnectEnabled')) as boolean | undefined;
            const autoAddr = (await store.get('autoConnectAddress')) as string | undefined;
            if (recents && recents.length) setRecentServers(recents);
            if (autoEn !== undefined) setAutoConnectEnabled(autoEn);
            if (autoAddr) setAutoConnectAddress(autoAddr);
         } catch (e) {
            console.warn('Failed to load client settings:', e);
         }
      };
      loadClientSettings();
   }, []);

   useEffect(() => {
      if (!autoConnectEnabled || manualOverride || connectionState === 'connected') {
         if (retryIntervalRef.current) {
            clearTimeout(retryIntervalRef.current as any);
            retryIntervalRef.current = null;
         }
         return;
      }

      let target = autoConnectAddress.trim();
      if (!target) {
         target = recentServers[0] || '';
      }
      if (!target) return;

      if (!autoConnectAttemptedRef.current) {
         autoConnectAttemptedRef.current = true;
         setServerAddress(target);
         addLog('info', `Auto-connect enabled. Attempting to connect to ${target}`);
         setIsConnecting(true);
         handleConnect();
      }

   retryIntervalRef.current = setTimeout(() => {
      const cs: any = connectionState;
      if (!isConnecting && cs !== 'connected' && !manualOverride && autoConnectEnabled) {
            addLog('info', `Retrying auto-connect to ${target}...`);
            setServerAddress(target);
            setIsConnecting(true);
            handleConnect();
         }
      }, 5000);

      return () => {
         if (retryIntervalRef.current) {
            clearTimeout(retryIntervalRef.current as any);
            retryIntervalRef.current = null;
         }
      };
   }, [autoConnectEnabled, autoConnectAddress, recentServers, connectionState, isConnecting, manualOverride]);

   const handleToggleAutoConnect = async () => {
      const next = !autoConnectEnabled;
      setAutoConnectEnabled(next);
      try {
         if (!settingsStoreRef.current) {
            const { load } = await import('@tauri-apps/plugin-store');
            settingsStoreRef.current = await load('client-settings.json', { autoSave: true });
         }
         await settingsStoreRef.current.set('autoConnectEnabled', next);
      } catch (e) {
         console.warn('Failed to persist auto-connect setting:', e);
      }
   };

   const handleManualOverride = () => {
      setManualOverride(true);
      setIsConnecting(false);
      if (retryIntervalRef.current) {
         clearTimeout(retryIntervalRef.current as any);
         retryIntervalRef.current = null;
      }
      addLog('info', 'Manual override activated. You can enter a different IP.');
   };

   return (
      <div className="min-h-screen bg-gradient-to-br from-gray-900 via-black to-gray-900 flex flex-col">
         <audio id="main-audio" style={{ display: 'none' }} />
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
               
               <div className="flex items-center gap-6">
                 <div className="flex items-center">
                   <div className={`w-3 h-3 rounded-full mr-3 ${connectionState === 'connected' ? 'bg-green-400' : 'bg-red-400'}`}></div>
                   <h1 className="text-xl font-semibold text-white">Client Mode</h1>
                 </div>
                 <div className="flex items-center gap-3">
                   <div className={`px-3 py-1.5 rounded-full text-xs font-semibold ${connectionState === 'connected' ? 'bg-green-500/20 text-green-400 border border-green-500/30' : 'bg-red-500/20 text-red-400 border border-red-500/30'}`}>
                     {connectionState === 'connected' ? 'Connected' : 'Disconnected'}
                   </div>
                   {connectionState === 'connected' && (
                     <motion.button
                       whileHover={{ scale: 1.05 }}
                       whileTap={{ scale: 0.95 }}
                       onClick={handleDisconnect}
                       className="flex items-center gap-2 px-4 py-2 bg-red-500/20 hover:bg-red-500/30 text-red-300 border border-red-500/30 rounded-lg text-xs font-medium"
                     >
                       <WifiOff className="w-4 h-4" />
                       Disconnect
                     </motion.button>
                   )}
                 </div>
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
               {connectionState === 'disconnected' && !autoConnectEnabled && (
                  <motion.div
                     initial={{ y: 20, opacity: 0 }}
                     animate={{ y: 0, opacity: 1 }}
                     className="bg-gray-800/40 border border-gray-700/40 rounded-xl p-6"
                  >
                     <h2 className="text-xl font-bold text-white mb-4 flex items-center justify-between">
                        <span>Connect to Server</span>
                        {recentServers.length > 0 && (
                           <span className="text-xs text-gray-400 font-normal">Recent: {recentServers.length}</span>
                        )}
                     </h2>
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
                           {recentServers.length > 0 && (
                              <div className="mt-3 flex flex-wrap gap-2">
                                 {recentServers.map((addr, idx) => (
                                    <button
                                       key={addr}
                                       onClick={() => setServerAddress(addr)}
                                       className={`px-2.5 py-1 rounded-full text-xs border transition-colors ${
                                          addr === serverAddress
                                             ? 'bg-blue-500/30 border-blue-400/40 text-blue-300'
                                             : 'bg-gray-700/40 border-gray-600/40 text-gray-300 hover:bg-gray-700/60'
                                       }`}
                                    >
                                       {idx === 0 ? 'Last: ' : ''}{addr}
                                    </button>
                                 ))}
                              </div>
                           )}
                        </div>
                        <div className="flex items-center justify-between bg-gray-700/30 border border-gray-600/40 rounded-lg px-4 py-3">
                           <div>
                              <p className="text-sm font-medium text-white">Auto-connect to last server</p>
                              <p className="text-xs text-gray-400">Automatically attempts connection on launch</p>
                           </div>
                           <button
                              onClick={handleToggleAutoConnect}
                              className={`relative w-12 h-6 rounded-full transition-colors ${autoConnectEnabled ? 'bg-blue-500' : 'bg-gray-600'}`}
                           >
                              <span className={`absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white transition-transform ${autoConnectEnabled ? 'translate-x-6' : ''}`}></span>
                           </button>
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

               {connectionState === 'disconnected' && autoConnectEnabled && !manualOverride && (
                  <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="bg-gray-800/40 border border-gray-700/40 rounded-xl p-8 text-center">
                     <h2 className="text-xl font-bold text-white mb-4">Auto-Connect Enabled</h2>
                     <p className="text-gray-300 mb-4">Trying to connect to {autoConnectAddress || recentServers[0] || 'configured server'}...</p>
                     <div className="flex items-center justify-center mb-6">
                        <div className="w-6 h-6 border-4 border-blue-500/30 border-t-blue-400 rounded-full animate-spin" />
                     </div>
                     <button onClick={handleManualOverride} className="px-4 py-2 rounded-lg bg-gray-700/60 hover:bg-gray-700 text-gray-200 text-sm border border-gray-600/60">Enter a different IP...</button>
                  </motion.div>
               )}

               {connectionState === 'disconnected' && autoConnectEnabled && manualOverride && (
                  <motion.div initial={{ y: 12, opacity: 0 }} animate={{ y:0, opacity: 1 }} className="bg-gray-800/40 border border-gray-700/40 rounded-xl p-6">
                     <div className="flex items-center justify-between mb-4">
                        <h2 className="text-xl font-bold text-white">Manual Connect (Override)</h2>
                        <button
                           onClick={() => { setManualOverride(false); autoConnectAttemptedRef.current = false; }}
                           className="text-xs text-blue-400 hover:text-blue-300 underline"
                        >Return to auto-connect</button>
                     </div>
                     <div className="space-y-4">
                        <input
                           type="text"
                           value={serverAddress}
                           onChange={(e) => setServerAddress(e.target.value)}
                           placeholder="192.168.1.100:12345"
                           className="w-full bg-gray-700/50 border border-gray-600/50 rounded-lg px-4 py-3 text-white placeholder-gray-400 focus:outline-none focus:border-blue-400 focus:ring-1 focus:ring-blue-400"
                           disabled={isConnecting}
                        />
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
                 <div className="flex flex-col lg:flex-row h-[calc(100vh-200px)] gap-6">
                   {/* Center Redemption Display */}
                   <div className="flex-1 flex items-center justify-center">
                     <motion.div initial={{ opacity: 0, scale: 0.95 }} animate={{ opacity: 1, scale: 1 }} className="w-full max-w-3xl">
                       {latestRedemption ? (
                         <div className="bg-gradient-to-br from-gray-800/70 to-gray-900/70 border border-gray-700/50 rounded-2xl p-10 shadow-lg relative">
                           <div className="absolute top-4 right-4 flex items-center gap-2 text-xs text-gray-400">
                             <span>{latestRedemption.receivedAt.toLocaleTimeString()}</span>
                           </div>
                           <h2 className="text-4xl md:text-5xl font-extrabold tracking-tight text-white mb-6 text-center break-words">
                             {latestRedemption.title}
                           </h2>
                           {latestRedemption.content && (
                             <p className="text-xl leading-relaxed text-gray-300 text-center mb-8 whitespace-pre-wrap break-words">
                               {latestRedemption.content}
                             </p>
                           )}
                           {latestRedemption.timerDuration && (
                             <div className="flex items-center justify-center gap-3 mb-4">
                               <Clock className="w-6 h-6 text-orange-400" />
                               <span className="text-2xl font-mono text-orange-400">
                                 {formatSecondsToTime(latestRedemption.timerDuration)}
                               </span>
                             </div>
                           )}
                           <div className="flex items-center justify-center gap-4">
                             {isPlaying ? (
                               <motion.button
                                 whileHover={{ scale: 1.05 }}
                                 whileTap={{ scale: 0.95 }}
                                 onClick={stopAudio}
                                 className="px-6 py-3 rounded-lg bg-red-500/20 hover:bg-red-500/30 text-red-300 border border-red-500/30 font-medium flex items-center gap-2"
                               >
                                 <Pause className="w-5 h-5" /> Stop
                               </motion.button>
                             ) : latestRedemption.filePath ? (
                               <motion.button
                                 whileHover={{ scale: 1.05 }}
                                 whileTap={{ scale: 0.95 }}
                                 disabled={isLoadingAudio}
                                 onClick={() => replayAudio()}
                                 className="px-6 py-3 rounded-lg bg-blue-500/20 hover:bg-blue-500/30 text-blue-300 border border-blue-500/30 font-medium flex items-center gap-2 disabled:opacity-50"
                               >
                                 {isLoadingAudio ? (
                                   <div className="w-5 h-5 border-2 border-blue-300/40 border-t-blue-300 rounded-full animate-spin"></div>
                                 ) : (
                                   <RefreshCw className="w-5 h-5" />
                                 )}
                                 {isLoadingAudio ? 'Loading' : 'Replay'}
                               </motion.button>
                             ) : null}
                           </div>
                         </div>
                       ) : (
                         <div className="text-center text-gray-500">
                           <MessageSquare className="w-16 h-16 mx-auto mb-6 text-gray-600" />
                           <p className="text-xl">Waiting for redemptions...</p>
                           <p className="text-sm mt-2 text-gray-600">They will appear here in large format once received.</p>
                         </div>
                       )}
                     </motion.div>
                   </div>
                   {/* Timers Side Panel */}
                   <div className="w-full lg:w-80 xl:w-96 flex-shrink-0">
                     <motion.div initial={{ x: 40, opacity: 0 }} animate={{ x: 0, opacity: 1 }} className="h-full flex flex-col bg-gray-800/40 border border-gray-700/40 rounded-xl p-6">
                       <div className="flex items-center gap-3 mb-4">
                         <div className="p-2 rounded-lg bg-blue-500/20">
                           <Clock className="w-5 h-5 text-blue-400" />
                         </div>
                         <h3 className="text-lg font-semibold text-white">Active Timers</h3>
                         {Object.keys(activeTimers).length > 0 && (
                           <div className="ml-auto px-2 py-1 bg-blue-500/20 text-blue-400 rounded text-xs font-medium">
                             {Object.keys(activeTimers).length}
                           </div>
                         )}
                       </div>
                       <div className="space-y-3 overflow-y-auto pr-2 custom-scrollbar">
                         {Object.keys(activeTimers).length === 0 ? (
                           <div className="text-center py-10">
                             <Clock className="w-10 h-10 text-gray-600 mx-auto mb-3" />
                             <p className="text-gray-500">No active timers</p>
                           </div>
                         ) : (
                           Object.values(activeTimers).map(timer => {
                             const timeDisplay = formatSecondsToTime(timer.remainingTime);
                             const progress = ((timer.totalDuration - timer.remainingTime) / timer.totalDuration) * 100;
                             const isUrgent = timer.remainingTime <= 10;
                             const isWarning = timer.remainingTime <= 30;
                             return (
                               <motion.div key={timer.id} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} className={`bg-gray-700/40 border rounded-lg p-4 ${isUrgent ? 'border-red-400/50' : isWarning ? 'border-orange-400/50' : 'border-gray-600/40'}`}> 
                                 <div className="flex items-center justify-between mb-1">
                                   <span className="text-xs font-medium text-gray-300 truncate max-w-[140px]">{timer.title}</span>
                                   <span className={`text-sm font-mono font-semibold ${isUrgent ? 'text-red-400' : isWarning ? 'text-orange-400' : 'text-green-400'}`}>{timeDisplay}</span>
                                 </div>
                                 <p className="text-[10px] text-gray-500 mb-2 truncate">{timer.content}</p>
                                 <div className="w-full bg-gray-600/40 rounded-full h-2 mb-1">
                                   <div className={`h-2 rounded-full transition-all duration-1000 ${isUrgent ? 'bg-red-400' : isWarning ? 'bg-orange-400' : 'bg-green-400'}`} style={{ width: `${progress}%` }} />
                                 </div>
                                 <div className="flex items-center justify-between">
                                   <span className="text-[10px] text-cyan-400 flex items-center gap-1"><User className="w-3 h-3" />{timer.userName}</span>
                                   {isUrgent && <span className="text-[10px] text-red-400 font-semibold animate-pulse">URGENT</span>}
                                 </div>
                               </motion.div>
                             );
                           })
                         )}
                       </div>
                     </motion.div>
                   </div>
                 </div>
               )}

               {/* Activity Log moved to bottom (hidden from main layout when connected) */}
            </div>
         </div>
      {/* Bottom Activity Log Drawer */}
      <div className="fixed bottom-0 left-0 right-0 z-40 pointer-events-none">
        <div className="max-w-6xl mx-auto px-4 pb-4">
          <div className="ml-auto w-full sm:w-auto pointer-events-auto">
            <motion.div initial={false} animate={{ y: showLog ? 0 : 140 }} className="relative">
              <div className="absolute -top-10 right-0 flex gap-2">
                <motion.button whileHover={{ scale: 1.05 }} whileTap={{ scale: 0.95 }} onClick={() => setShowLog(v => !v)} className="px-3 py-2 rounded-t-lg bg-gray-800/80 backdrop-blur border border-gray-700/60 text-xs font-medium flex items-center gap-2 text-gray-300 shadow-lg">
                  <List className="w-4 h-4" /> {showLog ? 'Hide Log' : 'Show Log'} {showLog ? <ChevronDown className="w-4 h-4" /> : <ChevronUp className="w-4 h-4" />}
                </motion.button>
              </div>
              <motion.div initial={false} animate={{ opacity: showLog ? 1 : 0 }} className="bg-gray-900/85 backdrop-blur-md border border-gray-700/60 rounded-xl shadow-2xl p-4 w-full sm:min-w-[480px] max-h-56 flex flex-col">
                <div className="flex items-center justify-between mb-3">
                  <h4 className="text-sm font-semibold text-white flex items-center gap-2"><span className="p-1.5 bg-cyan-500/20 rounded"><List className="w-3.5 h-3.5 text-cyan-400" /></span> Activity Log</h4>
                  <div className="flex items-center gap-2">
                    <button onClick={() => setAutoScrollLog(a => !a)} className={`text-[10px] px-2 py-1 rounded border ${autoScrollLog ? 'border-green-400/50 text-green-400 bg-green-500/10' : 'border-gray-500/40 text-gray-400 hover:bg-gray-700/40'}`}>{autoScrollLog ? 'Auto' : 'Manual'}</button>
                    <button onClick={() => setLogs([])} className="text-[10px] px-2 py-1 rounded border border-red-400/50 text-red-400 hover:bg-red-500/10">Clear</button>
                  </div>
                </div>
                <div ref={logContainerRef} className="flex-1 overflow-y-auto font-mono text-[11px] leading-relaxed pr-1 space-y-0.5 custom-scrollbar">
                  {logs.length === 0 ? (
                    <div className="text-gray-500 italic">No activity yet</div>
                  ) : (
                    logs.map((log, i) => (
                      <div key={i} className={`${log.type === 'error' ? 'text-red-400' : log.type === 'success' ? 'text-green-400' : 'text-cyan-400'}`}>[{log.type.toUpperCase()}] {log.message}</div>
                    ))
                  )}
                </div>
              </motion.div>
            </motion.div>
          </div>
        </div>
      </div>
      </div>
   );
};

export default ClientPage;
