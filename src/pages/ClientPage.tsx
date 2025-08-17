import { motion } from 'framer-motion';
import { useState, useEffect, useRef } from 'react';
import { ArrowLeft, Wifi, WifiOff, Pause, Clock, MessageSquare, AlertCircle, RefreshCw, ChevronDown, ChevronUp, List, AlertTriangle, Server } from 'lucide-react';
import { Link } from 'react-router-dom';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';

type ConnectingHeroProps = {
   visible: boolean;
   address?: string;
   attempt?: number;
   nextRetrySec?: number | null;
   lastError?: string | null;
   connecting: boolean;
   paused: boolean;
   onPause: () => void;
   onResume: () => void;
   onDisable: () => void;
   onChangeServer: () => void;
   onRetryNow?: () => void;
};

export const ConnectingHero: React.FC<ConnectingHeroProps> = ({
   visible,
   address,
   attempt = 1,
   nextRetrySec = null,
   lastError = null,
   connecting,
   paused,
   onPause,
   onResume,
   onDisable,
   onChangeServer,
   onRetryNow,
}) => {
   if (!visible) return null;

   const StatusIcon = paused ? Pause : RefreshCw;
   const statusColor =
      paused ? "bg-amber-500/10 text-amber-300 border-amber-400/30" : "bg-blue-500/10 text-blue-300 border-blue-400/30";
   const statusLabel = paused ? "Auto-connect paused" : "Connecting to the server";
   const subtitle = paused
      ? "You can resume the loop anytime."
      : "Establishing a secure channel. This may take a moment.";

   return (
      <motion.div
         initial={{ opacity: 0, y: 8 }}
         animate={{ opacity: 1, y: 0 }}
         exit={{ opacity: 0, y: 8 }}
         className="relative mx-auto w-full max-w-3xl rounded-2xl border border-white/10 bg-slate-950/70 ring-1 ring-black/30 backdrop-blur px-6 py-6 md:px-8 md:py-8"
      >
         {/* Header: status badge + server chip + attempt */}
         <div className="flex flex-wrap items-center justify-between gap-3">
            <div className={`inline-flex items-center gap-2 rounded-full border px-3 py-1 text-sm ${statusColor}`}>
               <StatusIcon className="h-3.5 w-3.5" />
               <span className="font-medium">{statusLabel}</span>
            </div>

            <div className="flex flex-wrap items-center gap-2">
               {address && (
                  <span className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-slate-900/70 px-3 py-1 text-xs text-slate-300">
                     <Server className="h-3.5 w-3.5" />
                     <span className="font-mono">{address}</span>
                  </span>
               )}
               <span className="inline-flex items-center gap-1 rounded-full border border-white/10 bg-slate-900/70 px-2.5 py-1 text-xs text-slate-300">
                  <Wifi className="h-3.5 w-3.5" />
                  Attempt: <b className="text-white">{attempt}</b>
               </span>
               {typeof nextRetrySec === "number" && nextRetrySec >= 0 && (
                  <span className="inline-flex items-center gap-1 rounded-full border border-white/10 bg-slate-900/70 px-2.5 py-1 text-xs text-slate-300">
                     <Clock className="h-3.5 w-3.5" />
                     Next retry in <b className="text-white">{nextRetrySec}s</b>
                  </span>
               )}
            </div>
         </div>

         {/* Body: icon ring + title + subtitle */}
         <div className="mt-6 flex flex-col items-center text-center">
            <div className="relative h-14 w-14">
               <div className="absolute inset-0 rounded-full border-2 border-white/10" />
               {connecting && (
                  <div className="absolute inset-0 rounded-full border-2 border-blue-400/70 border-t-transparent animate-spin" />
               )}
               {paused && <div className="absolute inset-0 rounded-full border-2 border-amber-400/70" />}
            </div>

            <h2 className="mt-4 text-2xl md:text-3xl font-semibold tracking-tight text-white">{statusLabel}</h2>
            <p className="mt-1 text-slate-300">{subtitle}</p>
         </div>

         {/* Actions */}
         <div className="mt-7 flex flex-wrap items-center justify-center gap-3">
            {paused ? (
               <button
                  onClick={onResume}
                  className="inline-flex items-center justify-center rounded-xl bg-blue-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-blue-500 transition-colors"
               >
                  <RefreshCw className="mr-2 h-4 w-4" />
                  Resume
               </button>
            ) : (
               <button
                  onClick={onPause}
                  className="inline-flex items-center justify-center rounded-xl bg-slate-800 px-4 py-2.5 text-sm font-semibold text-white hover:bg-slate-700 transition-colors"
               >
                  <WifiOff className="mr-2 h-4 w-4" />
                  Pause
               </button>
            )}

            <button
               onClick={onChangeServer}
               className="inline-flex items-center justify-center rounded-xl bg-slate-900/60 px-4 py-2.5 text-sm font-medium text-slate-200 hover:bg-slate-800/70 border border-white/10 transition-colors"
            >
               Change server…
            </button>

            <button
               onClick={onDisable}
               className="inline-flex items-center justify-center rounded-xl bg-transparent px-4 py-2.5 text-sm font-medium text-slate-300 hover:text-white border border-white/10 hover:border-white/20 transition-colors"
            >
               Disable auto-connect
            </button>

            {!paused && onRetryNow && (
               <button
                  onClick={onRetryNow}
                  className="inline-flex items-center justify-center rounded-xl bg-slate-900/60 px-3.5 py-2 text-xs font-medium text-slate-200 hover:bg-slate-800/70 border border-white/10 transition-colors"
                  title="Retry now"
               >
                  <RefreshCw className="h-4 w-4" />
               </button>
            )}
         </div>

         {/* Error details (collapsible inline) */}
         {lastError && (
            <div className="mt-6 rounded-xl border border-red-500/30 bg-red-500/5 p-4">
               <div className="flex items-start gap-3">
                  <AlertTriangle className="mt-0.5 h-5 w-5 text-red-400" />
                  <div className="text-left">
                     <p className="text-sm font-semibold text-red-300">Connection error</p>
                     <p className="mt-1 text-sm text-red-200/90 break-words">{lastError}</p>
                  </div>
               </div>
            </div>
         )}
      </motion.div>
   );
};




interface RedemptionData {
   id: string;
   title: string;
   content: string;
   audioData?: string;
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
   const [logs, setLogs] = useState<Array<{ type: 'info' | 'error' | 'success', message: string }>>([]);

   const [recentServers, setRecentServers] = useState<string[]>([]);
   const [autoConnectEnabled, setAutoConnectEnabled] = useState<boolean>(false);
   const [autoConnectAddress, setAutoConnectAddress] = useState<string>('');
   const [manualOverride, setManualOverride] = useState<boolean>(false);
   const autoConnectAttemptsRef = useRef(0);
   const [autoConnectAttemptCount, setAutoConnectAttemptCount] = useState(0);
   const [nextRetryDelayMs, setNextRetryDelayMs] = useState<number | null>(null);
   const [lastAutoConnectError, setLastAutoConnectError] = useState<string | null>(null);
   const settingsStoreRef = useRef<any>(null);
   const autoLoopActiveRef = useRef(false);
   const retryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
   const attemptTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
   const connectInProgressRef = useRef(false);
   const stopRequestedRef = useRef(false);
   const isMountedRef = useRef(true);

   const [latestRedemption, setLatestRedemption] = useState<RedemptionData | null>(null);
   const [activeTimers, setActiveTimers] = useState<Record<string, TimerData>>({});
   const [isPlaying, setIsPlaying] = useState(false);
   const [isLoadingAudio, setIsLoadingAudio] = useState(false);
   const [audioDeviceId, setAudioDeviceId] = useState<string>('default');
   const [currentAudio, setCurrentAudio] = useState<HTMLAudioElement | null>(null);
   const [audioSrc, setAudioSrc] = useState<string | null>(null);

   const [showLog, setShowLog] = useState(false);
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
                  const title = updated[timerId]?.title || 'Unknown';
                  delete updated[timerId];
                  hasChanges = true;
                  addLog('info', `Timer completed: ${title}`);
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
      isMountedRef.current = true;

      const unlistenStatus = listen('STATUS_UPDATE', (event) => {
         if (!isMountedRef.current) return;
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
            message.toLowerCase().includes('both peers confirmed') ||
            message.includes('establishing session')
         ) {
            setConnectionState('pairing');
         } else if (message.includes('Secure encrypted channel established')) {
            setConnectionState('connected');
         }
      });

      const unlistenPairing = listen('PAIRING_REQUIRED', (event) => {
         if (!isMountedRef.current) return;
         const code = event.payload as string;
         console.log('Pairing code required:', code);
         setPairingCode(code);
         setConnectionState('pairing');
         addLog('info', `Pairing code: ${code}`);
      });

      const unlistenSuccess = listen('SUCCESS', (event) => {
         if (!isMountedRef.current) return;
         const message = event.payload as string;
         console.log('Connection success:', message);
         addLog('success', message);

         if (message.includes('Secure encrypted channel established')) {
            setConnectionState('connected');
            setIsConnecting(false);
            setPairingCode(null);
            setError(null);
            connectInProgressRef.current = false;
            persistRecentServer(serverAddress);
            stopAutoReconnectLoop('connected');
         }
      });

      const unlistenClientConnected = listen('CLIENT_CONNECTED', () => {
         if (!isMountedRef.current) return;
         setConnectionState('connected');
         setIsConnecting(false);
         setPairingCode(null);
         connectInProgressRef.current = false;
         addLog('success', 'Client connected (event)');
         persistRecentServer(serverAddress);
         stopAutoReconnectLoop('connected');
      });

      const unlistenClientDisconnected = listen('CLIENT_DISCONNECTED', () => {
         if (!isMountedRef.current) return;
         setConnectionState('disconnected');
         setIsConnecting(false);
         setPairingCode(null);
         connectInProgressRef.current = false;
         addLog('info', 'Disconnected (event)');
         if (autoConnectEnabled && !manualOverride && !stopRequestedRef.current) {
            setTimeout(() => {
               if (isMountedRef.current && autoConnectEnabled && !manualOverride) {
                  startAutoReconnectLoop();
               }
            }, 1000);
         }
      });

      const unlistenPeerDisconnect = listen('PEER_DISCONNECT', (event) => {
         if (!isMountedRef.current) return;
         const reason = event.payload as string;
         setConnectionState('disconnected');
         setIsConnecting(false);
         setPairingCode(null);
         connectInProgressRef.current = false;
         addLog('error', `Peer disconnected: ${reason}`);
         console.log('Peer disconnect event:', reason);

         stopAutoReconnectLoop('peer_disconnect');

         if (autoConnectEnabled && !manualOverride && !stopRequestedRef.current) {
            setTimeout(() => {
               if (isMountedRef.current && autoConnectEnabled && !manualOverride) {
                  startAutoReconnectLoop();
               }
            }, 2000);
         }
      });

      const unlistenRedemption = listen('REDEMPTION_RECEIVED', async (event) => {
         if (!isMountedRef.current) return;
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
            filePath: parsedData.filePath || parsedData.file_path || '',
            audioData: parsedData.audioData || parsedData.audio_base64 || parsedData.audioBase64 || '',
            timerDuration: parsedData.timerDuration ?? parsedData.timer_duration ?? parsedData.time,
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


         if (redemption.audioData && typeof redemption.audioData === 'string' && redemption.audioData.trim() !== '') {
            const clean = redemption.audioData.includes(',') ? redemption.audioData.split(',')[1] : redemption.audioData;
            let mime: string = parsedData.mimeType || 'audio/mpeg';
            if (!parsedData.mimeType && clean) {
               if (clean.startsWith('UklG')) mime = 'audio/wav';
               else if (clean.startsWith('SUQz')) mime = 'audio/mpeg';
               else if (clean.startsWith('T2dn')) mime = 'audio/ogg';
            }
            await playAudio(redemption.audioData, mime);
         } else if (redemption.filePath) {
            await playAudio(redemption.filePath);
         }
      });

      const unlistenError = listen('ERROR', (event) => {
         if (!isMountedRef.current) return;
         const errorMessage = event.payload as string;
         console.error('P2P error:', errorMessage);
         setError(errorMessage);
         addLog('error', errorMessage);
         setIsConnecting(false);
         setConnectionState('disconnected');
         setPairingCode(null);
         connectInProgressRef.current = false;

         if (autoConnectEnabled && !manualOverride && autoLoopActiveRef.current && !stopRequestedRef.current) {
            setLastAutoConnectError(errorMessage);
            scheduleNextAutoRun();
         }
      });

      return () => {
         isMountedRef.current = false;
         stopRequestedRef.current = true;

         if (attemptTimeoutRef.current) {
            clearTimeout(attemptTimeoutRef.current);
            attemptTimeoutRef.current = null;
         }
         if (retryTimerRef.current) {
            clearTimeout(retryTimerRef.current);
            retryTimerRef.current = null;
         }

         autoLoopActiveRef.current = false;
         connectInProgressRef.current = false;

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
         unlistenPeerDisconnect.then(f => f());
         unlistenRedemption.then(f => f());
         unlistenError.then(f => f());
      };
   }, []);

   const handleConnect = async (addrOverride?: string) => {
      const target = (addrOverride ?? serverAddress).trim();
      if (!target) {
         addLog('error', 'No server address provided');
         return;
      }

      if (connectInProgressRef.current || isConnecting || connectionState === 'connected') {
         console.log('Connection already in progress or connected, skipping');
         return;
      }

      if (addrOverride) setServerAddress(target);
      setIsConnecting(true);
      setError(null);
      setConnectionState('connecting');
      addLog('info', `Attempting to connect to ${target}`);
      connectInProgressRef.current = true;

      try {
         await invoke('start_initiator', { address: target });
      } catch (error) {
         if (!isMountedRef.current) return;

         console.error('Failed to start connection:', error);
         const errMsg = typeof error === 'string' ? error : (error as any)?.toString?.() || 'Unknown error';
         setError(`Failed to connect: ${errMsg}`);
         addLog('error', `Connection failed: ${errMsg}`);
         setIsConnecting(false);
         setConnectionState('disconnected');
         connectInProgressRef.current = false;

         if (autoConnectEnabled && !manualOverride && autoLoopActiveRef.current && !stopRequestedRef.current) {
            setLastAutoConnectError(errMsg);
            scheduleNextAutoRun();
         }
      }
   };

   const handleConfirmPairing = async () => {
      try {
         await invoke('user_confirm_pairing');
         setConnectionState('pairing');
         addLog('info', 'Pairing confirmed locally. Waiting for the other side to confirm and establish session...');
      } catch (error) {
         console.error('Failed to confirm pairing:', error);
         setError(`Failed to confirm pairing: ${error}`);
         addLog('error', `Pairing confirmation failed: ${error}`);
      }
   };

   const handleDisconnect = async () => {
      try {
         stopAutoReconnectLoop('manual_disconnect');
         setIsConnecting(false);
         connectInProgressRef.current = false;

         try {
            await invoke('send_disconnect_notice', { reason: 'Client disconnecting' });
         } catch (_) { }

         await invoke('disconnect_client');
         setConnectionState('disconnected');
         setPairingCode(null);
         setError(null);
         addLog('info', 'Disconnected from server');
      } catch (error) {
         console.error('Failed to disconnect:', error);
         addLog('error', `Disconnect failed: ${error}`);
         setConnectionState('disconnected');
         setIsConnecting(false);
         connectInProgressRef.current = false;
         setPairingCode(null);
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

   const runAutoAttempt = () => {
      if (!isMountedRef.current || !autoConnectEnabled || manualOverride || connectionState === 'connected' || stopRequestedRef.current) {
         stopAutoReconnectLoop('conditions_changed');
         return;
      }

      if (connectInProgressRef.current || isConnecting) {
         console.log('Connection attempt already in progress, skipping auto attempt');
         scheduleNextAutoRun();
         return;
      }

      const target = (autoConnectAddress.trim() || recentServers[0] || serverAddress || '').trim();
      if (!target) {
         stopAutoReconnectLoop('no_target');
         addLog('error', 'No target address for auto-connect');
         return;
      }

      autoConnectAttemptsRef.current += 1;
      setAutoConnectAttemptCount(autoConnectAttemptsRef.current);
      setLastAutoConnectError(null);
      setNextRetryDelayMs(null);

      addLog('info', `Auto-connect attempt #${autoConnectAttemptsRef.current} to ${target}`);
      handleConnect(target);

      if (attemptTimeoutRef.current) {
         clearTimeout(attemptTimeoutRef.current);
      }

      attemptTimeoutRef.current = setTimeout(() => {
         if (!isMountedRef.current) return;

         if ((isConnecting || connectInProgressRef.current) && connectionState === 'connecting') {
            console.log('Auto-connect attempt timed out');
            setIsConnecting(false);
            connectInProgressRef.current = false;
            setConnectionState('disconnected');
            setLastAutoConnectError('Connection timeout');

            if (autoLoopActiveRef.current && !stopRequestedRef.current) {
               scheduleNextAutoRun();
            }
         }
      }, 15000);
   };

   const scheduleNextAutoRun = () => {
      if (!isMountedRef.current || !autoLoopActiveRef.current) return;
      if (!autoConnectEnabled || manualOverride || connectionState === 'connected' || stopRequestedRef.current) {
         stopAutoReconnectLoop('conditions_changed');
         return;
      }

      if (retryTimerRef.current) {
         clearTimeout(retryTimerRef.current);
      }

      const attempt = autoConnectAttemptsRef.current;
      const base = 5000;
      const maxDelay = 60000;
      const exponentialDelay = Math.min(base * Math.pow(2, Math.max(0, attempt - 1)), maxDelay);
      const jitter = Math.floor(Math.random() * 1000);
      const finalDelay = exponentialDelay + jitter;

      setNextRetryDelayMs(finalDelay);
      addLog('info', `Next auto-connect attempt #${attempt + 1} in ${(finalDelay / 1000).toFixed(1)}s`);

      retryTimerRef.current = setTimeout(() => {
         if (isMountedRef.current && autoLoopActiveRef.current) {
            runAutoAttempt();
         }
      }, finalDelay);
   };

   const startAutoReconnectLoop = () => {
      if (!isMountedRef.current || autoLoopActiveRef.current || !autoConnectEnabled || manualOverride || connectionState === 'connected') {
         console.log('Skipping auto-reconnect start - conditions not met');
         return;
      }

      stopRequestedRef.current = false;
      autoLoopActiveRef.current = true;
      autoConnectAttemptsRef.current = 0;
      setAutoConnectAttemptCount(0);
      setLastAutoConnectError(null);
      setNextRetryDelayMs(null);

      addLog('info', 'Auto-reconnect loop started');

      setTimeout(() => {
         if (isMountedRef.current && autoLoopActiveRef.current) {
            runAutoAttempt();
         }
      }, 2000);
   };

   const stopAutoReconnectLoop = (reason?: string) => {
      if (!autoLoopActiveRef.current) return;

      autoLoopActiveRef.current = false;
      stopRequestedRef.current = true;

      if (retryTimerRef.current) {
         clearTimeout(retryTimerRef.current);
         retryTimerRef.current = null;
      }
      if (attemptTimeoutRef.current) {
         clearTimeout(attemptTimeoutRef.current);
         attemptTimeoutRef.current = null;
      }

      setNextRetryDelayMs(null);

      if (reason) {
         addLog('info', `Auto-reconnect stopped (${reason})`);
      }
   };

   useEffect(() => {
      if (autoConnectEnabled && !manualOverride && connectionState === 'disconnected' && !stopRequestedRef.current) {
         const timer = setTimeout(() => {
            if (isMountedRef.current && autoConnectEnabled && !manualOverride && connectionState === 'disconnected') {
               startAutoReconnectLoop();
            }
         }, 1000);
         return () => clearTimeout(timer);
      } else if (!autoConnectEnabled || manualOverride || connectionState === 'connected') {
         stopAutoReconnectLoop('settings_changed');
      }
   }, [autoConnectEnabled, manualOverride, connectionState]);

   const handleToggleAutoConnect = async () => {
      const next = !autoConnectEnabled;
      setAutoConnectEnabled(next);
      if (!next) {
         stopAutoReconnectLoop('user_toggle_off');
      } else {
         startAutoReconnectLoop();
      }
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

   const handleAutoConnectAddressChange = async (address: string) => {
      setAutoConnectAddress(address);
      try {
         if (!settingsStoreRef.current) {
            const { load } = await import('@tauri-apps/plugin-store');
            settingsStoreRef.current = await load('client-settings.json', { autoSave: true });
         }
         await settingsStoreRef.current.set('autoConnectAddress', address);
      } catch (e) {
         console.warn('Failed to persist auto-connect address:', e);
      }
   };

   const handleManualOverride = () => {
      setManualOverride(true);
      setIsConnecting(false);
      connectInProgressRef.current = false;
      stopAutoReconnectLoop('manual_override');
      setNextRetryDelayMs(null);
      setLastAutoConnectError(null);
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
                                       className={`px-2.5 py-1 rounded-full text-xs border transition-colors ${addr === serverAddress
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
                        {/* Auto-Connect Section */}
                        <div className="space-y-4">
                           <div className="flex items-center gap-3">
                              <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-blue-500/20 to-purple-500/20 border border-blue-500/30 flex items-center justify-center">
                                 <svg viewBox="0 0 24 24" className="w-5 h-5 text-blue-300"><path fill="currentColor" d="M7 2h2v6H7V2m8 0h2v6h-2V2M6 8h12v3a5 5 0 0 1-5 5v4h-2v-4a5 5 0 0 1-5-5V8z" /></svg>
                              </div>
                              <div className="flex-1">
                                 <h3 className="text-base font-semibold text-white">Auto-Connect</h3>
                                 <p className="text-sm text-gray-400">Automatically connect to your preferred server</p>
                              </div>
                              <div className="flex items-center gap-3">
                                 <div className={`px-3 py-1.5 rounded-full text-xs font-medium border ${autoConnectEnabled
                                    ? 'bg-green-500/20 text-green-400 border-green-500/30'
                                    : 'bg-gray-500/20 text-gray-400 border-gray-500/30'
                                    }`}>
                                    {autoConnectEnabled ? 'Enabled' : 'Disabled'}
                                 </div>
                                 <motion.button
                                    whileHover={{ scale: 1.05 }}
                                    whileTap={{ scale: 0.95 }}
                                    onClick={handleToggleAutoConnect}
                                    className={`relative w-14 h-7 rounded-full transition-all duration-300 shadow-inner ${autoConnectEnabled
                                       ? 'bg-gradient-to-r from-blue-500 to-blue-600 shadow-blue-500/25'
                                       : 'bg-gradient-to-r from-gray-600 to-gray-700 shadow-gray-500/25'
                                       }`}
                                    aria-pressed={autoConnectEnabled}
                                    aria-label="Toggle auto-connect"
                                 >
                                    <motion.span
                                       className={`absolute top-0.5 w-6 h-6 rounded-full bg-white shadow-lg transform transition-all duration-300 flex items-center justify-center ${autoConnectEnabled ? 'left-7' : 'left-0.5'
                                          }`}
                                       initial={false}
                                       animate={{
                                          x: autoConnectEnabled ? 0 : 0,
                                          rotate: autoConnectEnabled ? 180 : 0
                                       }}
                                    >
                                       {autoConnectEnabled ? (
                                          <div className="w-2 h-2 rounded-full bg-blue-500"></div>
                                       ) : (
                                          <div className="w-2 h-2 rounded-full bg-gray-400"></div>
                                       )}
                                    </motion.span>
                                 </motion.button>
                              </div>
                           </div>

                           {/* Auto-Connect Configuration */}
                           <motion.div
                              initial={false}
                              animate={{
                                 height: autoConnectEnabled ? 'auto' : 0,
                                 opacity: autoConnectEnabled ? 1 : 0,
                                 marginTop: autoConnectEnabled ? 16 : 0
                              }}
                              className="overflow-hidden"
                           >
                              <div className="bg-gradient-to-r from-blue-500/5 to-purple-500/5 border border-blue-500/20 rounded-xl p-4 space-y-3">
                                 <div className="flex items-center gap-2 mb-3">
                                    <div className="w-2 h-2 rounded-full bg-blue-400 animate-pulse"></div>
                                    <span className="text-sm font-medium text-blue-300">Configuration</span>
                                 </div>

                                 <div className="space-y-2">
                                    <label className="text-xs font-medium text-gray-300">Preferred Server</label>
                                    <div className="relative">
                                       <input
                                          type="text"
                                          value={autoConnectAddress}
                                          onChange={(e) => handleAutoConnectAddressChange(e.target.value)}
                                          placeholder={recentServers[0] || "192.168.1.100:12345"}
                                          className="w-full bg-gray-800/50 border border-gray-600/50 rounded-lg px-3 py-2.5 text-sm text-white placeholder-gray-500 focus:outline-none focus:border-blue-400 focus:ring-2 focus:ring-blue-400/20 transition-all"
                                       />
                                       <div className="absolute inset-y-0 right-0 flex items-center pr-3">
                                          <div className="w-2 h-2 rounded-full bg-gray-500"></div>
                                       </div>
                                    </div>
                                    <p className="text-xs text-gray-500">
                                       {autoConnectAddress.trim()
                                          ? `Will connect to: ${autoConnectAddress}`
                                          : `Will use last server: ${recentServers[0] || 'none'}`
                                       }
                                    </p>
                                 </div>

                                 <div className="flex items-center justify-between pt-2 border-t border-blue-500/10">
                                    <div className="flex items-center gap-2">
                                       <RefreshCw className="w-3 h-3 text-blue-400" />
                                       <span className="text-xs text-blue-300">Smart retry with backoff</span>
                                    </div>
                                    <div className="text-xs text-gray-400">5s → 60s max</div>
                                 </div>
                              </div>
                           </motion.div>
                        </div>
                        <motion.button
                           whileHover={{ scale: 1.02 }}
                           whileTap={{ scale: 0.98 }}
                           onClick={() => handleConnect()}
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
                  <ConnectingHero
                     visible={connectionState === 'disconnected' && autoConnectEnabled && !manualOverride}
                     connecting={isConnecting || connectInProgressRef.current}
                     paused={!autoLoopActiveRef.current}
                     address={(autoConnectAddress || recentServers[0] || serverAddress) || undefined}
                     attempt={autoConnectAttemptCount || 1}
                     nextRetrySec={nextRetryDelayMs !== null ? Math.round(nextRetryDelayMs / 1000) : null}
                     lastError={lastAutoConnectError}
                     onPause={() => stopAutoReconnectLoop('user_pause')}
                     onResume={() => startAutoReconnectLoop()}
                     onDisable={() => handleToggleAutoConnect()}
                     onChangeServer={handleManualOverride}
                     onRetryNow={() => {
                        // istersen anında bir deneme tetikleyebilirsin:
                        // scheduleNextAutoRun(0);
                     }}
                  />

               )}


               {connectionState === 'disconnected' && autoConnectEnabled && manualOverride && (
                  <motion.div initial={{ y: 12, opacity: 0 }} animate={{ y: 0, opacity: 1 }} className="bg-gray-800/40 border border-gray-700/40 rounded-xl p-6">
                     <div className="flex items-center justify-between mb-4">
                        <h2 className="text-xl font-bold text-white">Manual Connect (Override)</h2>
                        <button
                           onClick={() => { setManualOverride(false); startAutoReconnectLoop(); }}
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
                           onClick={() => handleConnect()}
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
                                    ) : (latestRedemption.filePath || audioSrc) ? (
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
                                    return (
                                       <div key={timer.id} className="group bg-gray-800/60 border border-gray-700/50 hover:border-gray-600/60 rounded-xl px-4 py-3 transition">
                                          <div className="flex items-start justify-between gap-4">
                                             <div className="min-w-0">
                                                <div className="flex items-center gap-2">
                                                   <span className="inline-flex items-center px-2 py-0.5 rounded-md text-[11px] font-medium bg-blue-500/15 text-blue-300 border border-blue-500/30">
                                                      Timer
                                                   </span>
                                                   <span className="text-xs text-gray-400">#{timer.id.slice(-6)}</span>
                                                </div>
                                                <h4 className="mt-1 text-sm font-semibold text-white truncate">{timer.title}</h4>
                                                {timer.content && (
                                                   <p className="text-xs text-gray-400 mt-0.5 line-clamp-1">{timer.content}</p>
                                                )}
                                             </div>
                                             <div className="flex flex-col items-end">
                                                <span className="font-mono text-sm text-white bg-gray-700/60 border border-gray-600/60 rounded-md px-2 py-1">
                                                   {timeDisplay}
                                                </span>
                                                {typeof timer.totalDuration === 'number' && (
                                                   <span className="mt-1 text-[10px] text-gray-400">/ {Math.round(timer.totalDuration)}s</span>
                                                )}
                                             </div>
                                          </div>
                                          {typeof timer.totalDuration === 'number' && timer.totalDuration > 0 && (
                                             <div className="mt-2 h-1.5 w-full bg-gray-700/60 rounded-full overflow-hidden">
                                                <div
                                                   className="h-full bg-gradient-to-r from-blue-400 to-blue-600 transition-[width] duration-500"
                                                   style={{ width: `${Math.min(100, Math.max(0, (1 - (timer.remainingTime / timer.totalDuration)) * 100))}%` }}
                                                />
                                             </div>
                                          )}
                                       </div>
                                    );
                                 })
                              )}
                           </div>
                        </motion.div>
                     </div>
                  </div>
               )}

            </div>
         </div>
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
