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
import { RedemptionConfig, TimerBehavior } from '../types/settings';

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

type TimerAdjustmentDescriptor =
  | { kind: 'subtract'; seconds: number }
  | { kind: 'clear' };

type TimerActionDescriptor =
  | { kind: 'none' }
  | { kind: 'start'; durationSeconds: number }
  | { kind: 'adjust'; adjustment: TimerAdjustmentDescriptor };

type TimerActionPayload =
  | { type: 'none' }
  | { type: 'start'; duration_seconds: number }
  | { type: 'adjust'; adjustment: { type: 'subtract'; seconds: number } | { type: 'clear' } };

interface ActiveTimerEntry {
  id: string;
  title: string;
  content: string;
  userName: string;
  totalDuration: number;
  remainingTime: number;
  startedAt: Date;
}

const ServerPage = () => {
  const navigate = useNavigate();
  const [isServerRunning, setIsServerRunning] = useState(false);
  const [networkInfo, setNetworkInfo] = useState<NetworkInfo | null>(null);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isEndingSession, setIsEndingSession] = useState(false);

  const [serverLogs, setServerLogs] = useState<Array<{ type: 'info' | 'error' | 'success', message: string, timestamp: string }>>([]);

  const [redemptionRequests, setRedemptionRequests] = useState<RedemptionRequest[]>([]);
  const [processingRedemptions, setProcessingRedemptions] = useState<Set<string>>(new Set());
  const [editingRedemptions, setEditingRedemptions] = useState<Record<string, string>>({});
  const [redemptionConfigs, setRedemptionConfigs] = useState<Record<string, RedemptionConfig>>({});

  const [isClientConnected, setIsClientConnected] = useState(false);
  const [pairingCode, setPairingCode] = useState<string | null>(null);
  const [generatedTTS, setGeneratedTTS] = useState<Record<string, { filePath: string; title: string; content: string; timerAction: TimerActionDescriptor }>>({});
  const [manualTtsTitle, setManualTtsTitle] = useState('');
  const [manualTtsText, setManualTtsText] = useState('');
  const [manualTtsStatus, setManualTtsStatus] = useState<'idle' | 'generating' | 'ready' | 'sending' | 'error'>('idle');
  const [manualTtsError, setManualTtsError] = useState<string | null>(null);
  const [manualTtsResult, setManualTtsResult] = useState<{
    filePath: string;
    title: string;
    content: string;
    audioBase64?: string;
    mimeType?: string;
  } | null>(null);

  const [activeTimers, setActiveTimers] = useState<Record<string, ActiveTimerEntry>>({});

  const [autoScroll, setAutoScroll] = useState(true);
  const logsContainerRef = useRef<HTMLDivElement>(null);

  const addServerLog = (type: 'info' | 'error' | 'success', message: string) => {
    const timestamp = new Date().toLocaleTimeString();
    setServerLogs(prev => [...prev.slice(-9), { type, message, timestamp }]); 
  };

  const isManualTtsProcessing = manualTtsStatus === 'generating' || manualTtsStatus === 'sending';
  const manualTtsStatusStyles = (() => {
    switch (manualTtsStatus) {
      case 'generating':
        return { label: 'Generating audio…', classes: 'bg-blue-500/20 text-blue-300 border border-blue-500/30' };
      case 'sending':
        return { label: 'Sending to client…', classes: 'bg-cyan-500/20 text-cyan-300 border border-cyan-500/30' };
      case 'ready':
        return { label: 'Ready to send', classes: 'bg-green-500/20 text-green-300 border border-green-500/30' };
      case 'error':
        return { label: 'Needs attention', classes: 'bg-red-500/20 text-red-300 border border-red-500/30' };
      default:
        return { label: 'Idle', classes: 'bg-gray-500/20 text-gray-300 border border-gray-500/30' };
    }
  })();

  const timerBehaviorToDescriptor = (behavior?: TimerBehavior): TimerActionDescriptor => {
    if (!behavior || behavior.mode === 'none') {
      return { kind: 'none' };
    }

    if (behavior.mode === 'start') {
      const seconds = parseTimeToSeconds(behavior.duration ?? '00:00');
      if (seconds <= 0) {
        return { kind: 'none' };
      }
      return { kind: 'start', durationSeconds: seconds };
    }

    if (behavior.mode === 'adjust') {
      if (behavior.adjustment === 'clear') {
        return { kind: 'adjust', adjustment: { kind: 'clear' } };
      }

      if (behavior.adjustment === 'subtract') {
        const seconds = parseTimeToSeconds(behavior.amount ?? '00:00');
        if (seconds <= 0) {
          return { kind: 'none' };
        }
        return { kind: 'adjust', adjustment: { kind: 'subtract', seconds } };
      }
    }

    return { kind: 'none' };
  };

  const descriptorToPayload = (descriptor: TimerActionDescriptor): TimerActionPayload => {
    switch (descriptor.kind) {
      case 'start':
        return { type: 'start', duration_seconds: descriptor.durationSeconds };
      case 'adjust':
        if (descriptor.adjustment.kind === 'subtract') {
          return {
            type: 'adjust',
            adjustment: { type: 'subtract', seconds: descriptor.adjustment.seconds },
          };
        }
        return { type: 'adjust', adjustment: { type: 'clear' } };
      default:
        return { type: 'none' };
    }
  };

  const describeTimerAction = (descriptor: TimerActionDescriptor): string | null => {
    if (descriptor.kind === 'start') {
      return `timer (${formatSecondsToTime(descriptor.durationSeconds)})`;
    }
    if (descriptor.kind === 'adjust') {
      if (descriptor.adjustment.kind === 'clear') {
        return 'timer clear';
      }
      return `timer adjustment (-${formatSecondsToTime(descriptor.adjustment.seconds)})`;
    }
    return null;
  };

  const renderTimerBehaviorBadge = (behavior: TimerBehavior) => {
    if (behavior.mode === 'start') {
      return (
        <div className="flex items-center gap-1 px-2 py-1 bg-orange-500/20 text-orange-400 rounded text-xs">
          <Clock className="w-3 h-3" />
          {behavior.duration}
        </div>
      );
    }

    if (behavior.mode === 'adjust') {
      if (behavior.adjustment === 'clear') {
        return (
          <div className="flex items-center gap-1 px-2 py-1 bg-red-500/20 text-red-300 rounded text-xs">
            <Clock className="w-3 h-3" />
            Clear Timers
          </div>
        );
      }

      const amount = behavior.amount || '00:30';
      return (
        <div className="flex items-center gap-1 px-2 py-1 bg-yellow-500/20 text-yellow-300 rounded text-xs">
          <Clock className="w-3 h-3" />
          -{amount}
        </div>
      );
    }

    return null;
  };

  const applyTimerActionLocally = (
    descriptor: TimerActionDescriptor,
    context: { baseId: string; title: string; content: string; userName: string }
  ) => {
    if (descriptor.kind === 'none') {
      return;
    }

    if (descriptor.kind === 'start') {
      const timerId = `timer_${Date.now()}_${context.baseId}`;
      const totalDuration = descriptor.durationSeconds;
      setActiveTimers(prev => ({
        ...prev,
        [timerId]: {
          id: timerId,
          title: context.title,
          content: context.content,
          userName: context.userName,
          totalDuration,
          remainingTime: totalDuration,
          startedAt: new Date(),
        },
      }));
      addServerLog('info', `Timer started: ${formatSecondsToTime(totalDuration)} for "${context.title}"`);
      return;
    }

    if (descriptor.adjustment.kind === 'clear') {
      let removedCount = 0;
      setActiveTimers(prev => {
        removedCount = Object.keys(prev).length;
        return {};
      });

      if (removedCount === 0) {
        addServerLog('info', 'No active timers to clear');
      } else {
        addServerLog('success', `Cleared ${removedCount} active timer${removedCount === 1 ? '' : 's'}`);
      }
      return;
    }

    const adjustmentSeconds = descriptor.adjustment.seconds;
    if (adjustmentSeconds <= 0) {
      return;
    }

    let summary: { adjusted: number; removed: number } = { adjusted: 0, removed: 0 };

    setActiveTimers(prev => {
      const updated: Record<string, ActiveTimerEntry> = {};

      Object.entries(prev).forEach(([id, timer]) => {
        const remaining = Math.max(timer.remainingTime - adjustmentSeconds, 0);
        if (remaining === 0) {
          summary.removed += 1;
          return;
        }
        summary.adjusted += 1;
        updated[id] = {
          ...timer,
          remainingTime: remaining,
        };
      });

      return updated;
    });

    if (summary.adjusted === 0 && summary.removed === 0) {
      addServerLog('info', 'No active timers to adjust');
      return;
    }

    const parts: string[] = [];
    if (summary.adjusted > 0) {
      parts.push(`reduced ${summary.adjusted} timer${summary.adjusted === 1 ? '' : 's'}`);
    }
    if (summary.removed > 0) {
      parts.push(`removed ${summary.removed} timer${summary.removed === 1 ? '' : 's'}`);
    }
    addServerLog(
      'success',
      `Adjusted timers (${formatSecondsToTime(adjustmentSeconds)}): ${parts.join(', ')}`,
    );
  };

  const normalizeTimerBehavior = (rawConfig: any): TimerBehavior => {
    const behavior = rawConfig?.timerBehavior;
    if (behavior && typeof behavior === 'object') {
      if (behavior.mode === 'start') {
        const duration = typeof behavior.duration === 'string' ? behavior.duration : rawConfig?.timerDuration;
        return { mode: 'start', duration: duration || '00:30' };
      }

      if (behavior.mode === 'adjust') {
        if (behavior.adjustment === 'clear') {
          return { mode: 'adjust', adjustment: 'clear' };
        }

        if (behavior.adjustment === 'subtract') {
          const amount = typeof behavior.amount === 'string' ? behavior.amount : rawConfig?.timerDuration;
          return { mode: 'adjust', adjustment: 'subtract', amount: amount || '00:30' };
        }

        if (behavior.adjustment && typeof behavior.adjustment === 'object') {
          if (behavior.adjustment.type === 'clear') {
            return { mode: 'adjust', adjustment: 'clear' };
          }
          if (behavior.adjustment.type === 'subtract') {
            const amount = typeof behavior.adjustment.amount === 'string'
              ? behavior.adjustment.amount
              : behavior.amount;
            return { mode: 'adjust', adjustment: 'subtract', amount: amount || '00:30' };
          }
        }
      }
    }

    if (rawConfig?.timerEnabled) {
      const duration = typeof rawConfig.timerDuration === 'string' ? rawConfig.timerDuration : '00:30';
      return { mode: 'start', duration };
    }

    return { mode: 'none' };
  };

  const normalizeRedemptionConfig = (raw: any): RedemptionConfig | null => {
    if (!raw || typeof raw !== 'object') {
      return null;
    }

    const timerBehavior = normalizeTimerBehavior(raw);

    return {
      enabled: Boolean(raw.enabled),
      ttsType: raw.ttsType === 'static' ? 'static' : 'dynamic',
      dynamicTemplate:
        typeof raw.dynamicTemplate === 'string' ? raw.dynamicTemplate : '[[USER]] said: [[MESSAGE]]',
      staticFiles: [],
      staticFileNames: Array.isArray(raw.staticFileNames) ? raw.staticFileNames : [],
      timerBehavior,
    };
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
        addServerLog('success', 'Server listener started successfully');
        getNetworkInfo();
      } else if (message.includes('Connection closed')) {
        setIsClientConnected(false);
        setPairingCode(null);
        addServerLog('info', 'Client disconnected');
      } else if (message.includes('Peer confirmed pairing') || message.includes('Both peers confirmed') || message.includes('establishing session')) {
        addServerLog('success', 'Pairing successful - establishing secure connection...');
      } else if (message.includes('Starting listener')) {
        addServerLog('info', 'Initializing server listener...');
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

    const unlistenSuccess = listen('SUCCESS', (event) => {
      if (!mounted) return;

      const message = event.payload as string;
      console.log('Success event:', message);
      addServerLog('success', message);

      if (message.includes('Secure encrypted channel established')) {
        setIsClientConnected(true);
        setPairingCode(null);
        addServerLog('success', 'Client connected and encrypted channel established!');
      }
    });

    const unlistenClientConnected = listen('CLIENT_CONNECTED', () => {
      if (!mounted) return;
      setIsClientConnected(true);
      setPairingCode(null);
      addServerLog('success', 'Client connected (event)');
    });

    const unlistenClientDisconnected = listen('CLIENT_DISCONNECTED', () => {
      if (!mounted) return;
      setIsClientConnected(false);
      setPairingCode(null);
      addServerLog('info', 'Client disconnected (event)');
    });

    const unlistenPeerDisconnect = listen('PEER_DISCONNECT', (event) => {
      if (!mounted) return;
      const reason = event.payload as string;
      setIsClientConnected(false);
      setPairingCode(null);
      addServerLog('error', `Peer disconnected: ${reason}`);
      console.log('Peer disconnect event:', reason);
    });

    const unlistenPairingRequired = listen('PAIRING_REQUIRED', (event) => {
      if (!mounted) return;
      const code = event.payload as string;
      console.log('Pairing code required:', code);
      setPairingCode(code);
      addServerLog('info', `Pairing required - Code: ${code}`);
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
      unlistenSuccess.then(f => f());
      unlistenClientConnected.then(f => f());
      unlistenClientDisconnected.then(f => f());
      unlistenPeerDisconnect.then(f => f());
      unlistenPairingRequired.then(f => f());
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
      setIsServerRunning(true);
      await invoke('start_listener');
      addServerLog('success', 'Server started successfully');
    } catch (error) {
      console.error('Failed to start server:', error);

      const errorStr = error as string;
      if (errorStr.includes('already in use') || errorStr.includes('Address already in use')) {
        console.log('Port already in use, server might already be running');
        setIsServerRunning(true);
        addServerLog('info', 'Server was already running on port 12345');
      } else {
        setIsServerRunning(false);
        setError(`Failed to start server: ${error}`);
        addServerLog('error', `Failed to start server: ${error}`);
      }
    }
  };

  const handleAcceptRedemption = async (redemption: RedemptionRequest) => {
    setProcessingRedemptions(prev => new Set(prev).add(redemption.id));

    try {
      const { load } = await import('@tauri-apps/plugin-store');
      const store = await load('redemptions.json', { autoSave: false, defaults: {} });
      const configs = (await store.get('redemptionConfigs')) as Record<string, any> | undefined;
      const normalizedConfig = normalizeRedemptionConfig(configs?.[redemption.reward_id]);

      if (!normalizedConfig || !normalizedConfig.enabled) {
        addServerLog('error', `No configuration found for redemption ${redemption.reward_title}`);
        return;
      }

      setRedemptionConfigs(prev => ({
        ...prev,
        [redemption.reward_id]: normalizedConfig,
      }));

      const timerDescriptor = timerBehaviorToDescriptor(normalizedConfig.timerBehavior);

      if (normalizedConfig.ttsType === 'static') {
        await handleStaticRedemption(redemption, normalizedConfig, timerDescriptor);
        setRedemptionRequests(prev => prev.filter(r => r.id !== redemption.id));
      } else if (normalizedConfig.ttsType === 'dynamic') {
        await handleDynamicRedemption(redemption, normalizedConfig, timerDescriptor);
      } else {
        addServerLog('error', `Unknown TTS type: ${normalizedConfig.ttsType}`);
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

  const parseTimeToSeconds = (timeStr?: string): number => {
    if (!timeStr || typeof timeStr !== 'string') {
      return 0;
    }
    const parts = timeStr.split(':');
    if (parts.length !== 2) {
      return 0;
    }
    const minutes = Number(parts[0]);
    const seconds = Number(parts[1]);
    if (Number.isNaN(minutes) || Number.isNaN(seconds)) {
      return 0;
    }
    return Math.max(minutes, 0) * 60 + Math.max(seconds, 0);
  };

  const formatSecondsToTime = (totalSeconds: number): string => {
    const safeSeconds = Math.max(totalSeconds, 0);
    const minutes = Math.floor(safeSeconds / 60);
    const seconds = safeSeconds % 60;
    return `${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
  };

  const handleStaticRedemption = async (
    redemption: RedemptionRequest,
    config: RedemptionConfig,
    timerAction: TimerActionDescriptor
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
      await invoke('send_redemption', {
        filePath,
        title,
        content,
        timerAction: descriptorToPayload(timerAction),
      });

      const timerLabel = describeTimerAction(timerAction);
      addServerLog(
        'success',
        `Sent static redemption${timerLabel ? ` with ${timerLabel}` : ''}: ${selectedFile}`,
      );

      applyTimerActionLocally(timerAction, {
        baseId: redemption.id,
        title,
        content,
        userName: redemption.user_name,
      });
    } catch (error) {
      addServerLog('error', `Failed to send static redemption: ${error}`);
    }
  };

  const handleDynamicRedemption = async (
    redemption: RedemptionRequest,
    config: RedemptionConfig,
    timerAction: TimerActionDescriptor
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
          timerAction,
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
    timerAction: TimerActionDescriptor,
    removeFromGenerated: boolean = true
  ) => {
    try {
      await invoke('send_redemption', {
        filePath,
        title,
        content,
        timerAction: descriptorToPayload(timerAction),
      });

      const timerLabel = describeTimerAction(timerAction);
      addServerLog(
        'success',
        `Sent dynamic TTS redemption${timerLabel ? ` with ${timerLabel}` : ''}: "${content}"`,
      );

      const redemption = redemptionRequests.find(r => r.id === redemptionId);
      if (redemption) {
        applyTimerActionLocally(timerAction, {
          baseId: redemptionId,
          title,
          content,
          userName: redemption.user_name,
        });
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

  const handleGenerateManualTts = async () => {
    const trimmedMessage = manualTtsText.trim();
    const trimmedTitle = manualTtsTitle.trim();

    if (!trimmedMessage) {
      setManualTtsError('Enter a message to convert into speech.');
      return;
    }

    setManualTtsStatus('generating');
    setManualTtsError(null);
    setManualTtsResult(null);

    try {
      const ttsSettings = await invoke('load_tts_settings') as any;
      const isRvcMode = ttsSettings?.ttsMode === 'rvc';

      let ttsResult: any;
      if (isRvcMode) {
        ttsResult = await invoke('generate_tts', {
          mode: 'rvc',
          text: trimmedMessage,
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
          text: trimmedMessage,
          voice: ttsSettings?.ttsVoice || 'en-US-JennyNeural'
        });
      }

      if (!ttsResult || !(ttsResult as any).path) {
        throw new Error('TTS generation failed - no audio path returned');
      }

      const manualResult = {
        filePath: (ttsResult as any).path as string,
        title: trimmedTitle || 'Server Message',
        content: trimmedMessage,
        audioBase64: (ttsResult as any).audio_data as string | undefined,
        mimeType: (ttsResult as any).mime_type as string | undefined,
      };

      setManualTtsResult(manualResult);
      setManualTtsStatus('ready');
      addServerLog('success', `Manual TTS generated for "${manualResult.title}"`);
    } catch (err) {
      console.error('Failed to generate manual TTS:', err);
      const message = (err as Error)?.message || String(err);
      setManualTtsStatus('error');
      setManualTtsError(message);
      addServerLog('error', `Failed to generate manual TTS: ${message}`);
    }
  };

  const handleSendManualTts = async () => {
    if (!manualTtsResult) {
      setManualTtsError('Generate TTS before sending.');
      return;
    }

    setManualTtsStatus('sending');
    setManualTtsError(null);

    try {
      await invoke('send_server_message', {
        filePath: manualTtsResult.filePath,
        audioBase64: manualTtsResult.audioBase64 ?? null,
        title: manualTtsResult.title,
        content: manualTtsResult.content,
      });

      addServerLog('success', `Server message sent to client: "${manualTtsResult.title}"`);
      setManualTtsStatus('idle');
      setManualTtsResult(null);
    } catch (err) {
      console.error('Failed to send server message:', err);
      const message = (err as Error)?.message || String(err);
      setManualTtsStatus('ready');
      setManualTtsError(message);
      addServerLog('error', `Failed to send server message: ${message}`);
    }
  };

  const resetManualTts = () => {
    setManualTtsTitle('');
    setManualTtsText('');
    setManualTtsStatus('idle');
    setManualTtsError(null);
    setManualTtsResult(null);
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
      const store = await load('redemptions.json', { autoSave: false, defaults: {} });
      const configs = (await store.get('redemptionConfigs')) as Record<string, any> | undefined;
      const config = configs?.[rewardId];

      const normalized = normalizeRedemptionConfig(config);

      if (normalized) {
        setRedemptionConfigs(prev => ({
          ...prev,
          [rewardId]: normalized,
        }));
      }
    } catch (error) {
      console.error('Failed to load redemption config:', error);
    }
  };

  const handleEndSession = async () => {
    if (!isServerRunning || isEndingSession) return;
    setIsEndingSession(true);
    addServerLog('info', 'Ending session: stopping EventSub (if active) and server listener');
    try {
      try {
        await invoke('twitch_stop_event_listener');
        addServerLog('info', 'EventSub listener stopped');
      } catch (esError) {
        addServerLog('info', `EventSub stop attempt: ${esError}`);
      }
      await invoke('stop_listener');
      addServerLog('info', 'Server shutdown initiated');
      setTimeout(() => {
        navigate('/');
      }, 4000);
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

  const handleConfirmPairing = async () => {
    try {
      await invoke('user_confirm_pairing');
      addServerLog('info', 'Pairing confirmed. Waiting for client to confirm and establish session...');
    } catch (error) {
      console.error('Failed to confirm pairing:', error);
      addServerLog('error', `Failed to confirm pairing: ${error}`);
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

          {/* Pairing Code Display */}
          {pairingCode && (
            <motion.div
              initial={{ opacity: 0, y: -20 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -20 }}
              className="bg-yellow-900/30 border border-yellow-500/50 rounded-xl p-6 mb-6 backdrop-blur-sm"
            >
              <div className="flex items-center justify-between mb-4">
                <div className="flex items-center gap-3">
                  <div className="p-3 rounded-xl bg-yellow-500/20">
                    <User className="w-6 h-6 text-yellow-400" />
                  </div>
                  <div>
                    <h2 className="text-xl font-bold text-white">Client Pairing Required</h2>
                    <p className="text-sm text-yellow-400">A new client is requesting to connect</p>
                  </div>
                </div>
                <div className="px-3 py-1.5 rounded-full text-xs font-semibold bg-yellow-500/20 text-yellow-400 border border-yellow-500/30">
                  Waiting for Confirmation
                </div>
              </div>

              <p className="text-gray-300 mb-4">
                A client is trying to connect to your server. Share this pairing code with the client or confirm if this is expected:
              </p>

              <div className="bg-black/40 border border-yellow-500/30 rounded-lg p-6 mb-4">
                <div className="text-center">
                  <p className="text-sm text-gray-400 mb-2">Pairing Code</p>
                  <p className="text-4xl font-mono font-bold text-yellow-400 tracking-wider">
                    {pairingCode}
                  </p>
                </div>
              </div>

              <div className="flex gap-3">
                <motion.button
                  whileHover={{ scale: 1.02 }}
                  whileTap={{ scale: 0.98 }}
                  onClick={handleConfirmPairing}
                  className="flex-1 py-3 bg-green-500/20 hover:bg-green-500/30 text-green-300 border border-green-500/30 font-medium rounded-lg transition-colors flex items-center justify-center gap-2"
                >
                  <Check className="w-4 h-4" />
                  Confirm Pairing
                </motion.button>
                <motion.button
                  whileHover={{ scale: 1.02 }}
                  whileTap={{ scale: 0.98 }}
                  onClick={() => {
                    setPairingCode(null);
                    addServerLog('info', 'Pairing request dismissed');
                  }}
                  className="px-6 py-3 bg-red-500/20 hover:bg-red-500/30 text-red-300 border border-red-500/30 font-medium rounded-lg transition-colors flex items-center gap-2"
                >
                  <X className="w-4 h-4" />
                  Dismiss
                </motion.button>
              </div>

              <div className="mt-4 p-3 bg-blue-900/20 border border-blue-500/30 rounded-lg">
                <p className="text-xs text-blue-300">
                  <strong>Security Note:</strong> Only confirm this pairing if you expect a client to connect.
                  The pairing code ensures secure communication between server and client.
                </p>
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

                  <div className={`px-3 py-1.5 rounded-full text-xs font-semibold ${isServerRunning
                      ? 'bg-green-500/20 text-green-400 border border-green-500/30'
                      : 'bg-red-500/20 text-red-400 border border-red-500/30'
                    }`}>
                    {isServerRunning ? 'Active' : 'Inactive'}
                  </div>
                </div>

                <p className="text-gray-400 text-sm mb-4">
                  {isServerRunning ? 'Ready to receive requests and process redemptions' : 'Server is not running'}
                </p>

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
                          className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium transition-all duration-200 ${copied
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
                        className={`bg-gray-700/50 border rounded-lg p-3 ${isUrgent
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
                          <span className={`text-lg font-mono font-bold ${isUrgent
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
                            className={`h-2 rounded-full transition-all duration-1000 ${isUrgent
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
                              <div className={`px-2 py-1 rounded text-xs font-medium ${redemptionConfigs[redemption.reward_id].ttsType === 'dynamic'
                                  ? 'bg-blue-500/20 text-blue-400'
                                  : 'bg-purple-500/20 text-purple-400'
                                }`}>
                                {redemptionConfigs[redemption.reward_id].ttsType === 'dynamic' ? 'Dynamic TTS' : 'Static Audio'}
                              </div>
                              {renderTimerBehaviorBadge(redemptionConfigs[redemption.reward_id].timerBehavior)}
                            </div>
                          )}

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
                        {generatedTTS[redemption.id] && (
                          <motion.button
                            whileHover={isClientConnected ? { scale: 1.05 } : {}}
                            whileTap={isClientConnected ? { scale: 0.95 } : {}}
                            onClick={async () => {
                              const tts = generatedTTS[redemption.id];
                              if (tts && isClientConnected) {
                                try {
                                  await sendGeneratedTTS(
                                    redemption.id,
                                    tts.filePath,
                                    tts.title,
                                    tts.content,
                                    tts.timerAction,
                                  );
                                  setRedemptionRequests(prev => prev.filter(r => r.id !== redemption.id));
                                } catch (error) {
                                }
                              }
                            }}
                            disabled={!isClientConnected}
                            className={`flex items-center gap-2 px-3 py-2 rounded-lg font-medium transition-colors ${isClientConnected
                                ? 'bg-blue-500 hover:bg-blue-600 text-white'
                                : 'bg-gray-500 text-gray-300 cursor-not-allowed'
                              }`}
                          >
                            <Copy className="w-4 h-4" />
                            {isClientConnected ? 'Send to Client' : 'No Client Connected'}
                          </motion.button>
                        )}

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
                    className={`flex items-center gap-2 px-3 py-1.5 rounded-lg text-xs font-medium transition-all duration-200 ${autoScroll
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
                    {serverLogs.map((log, index) => (
                      <div
                        key={index}
                        className={`${log.type === 'error' ? 'text-red-400' :
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

            {/* Manual Server Message */}
            <motion.div
              initial={{ y: 20, opacity: 0 }}
              animate={{ y: 0, opacity: 1 }}
              transition={{ duration: 0.5, delay: 0.15 }}
              className="bg-gray-800/40 border border-gray-700/40 rounded-2xl p-6 mb-8"
            >
              <div className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between mb-6">
                <div className="flex items-start gap-3">
                  <div className="p-3 rounded-xl bg-purple-500/20 border border-purple-500/30">
                    <MessageSquare className="w-5 h-5 text-purple-300" />
                  </div>
                  <div>
                    <h3 className="text-xl font-semibold text-white">Manual Server Message</h3>
                    <p className="text-sm text-gray-400">
                      Convert any message into speech and deliver it instantly to the connected client.
                    </p>
                  </div>
                </div>
                <div className={`px-3 py-1 rounded-full text-xs font-semibold ${manualTtsStatusStyles.classes}`}>
                  {manualTtsStatusStyles.label}
                </div>
              </div>

              {manualTtsError && (
                <div className="mb-4 p-3 rounded-lg border border-red-500/30 bg-red-500/10 text-red-200 text-sm">
                  {manualTtsError}
                </div>
              )}

              <div className="grid gap-6 md:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
                <div className="space-y-4">
                  <div>
                    <label className="block text-xs font-medium text-gray-300 mb-2">
                      Display Title <span className="text-gray-500">(optional)</span>
                    </label>
                    <input
                      value={manualTtsTitle}
                      onChange={(event) => setManualTtsTitle(event.target.value)}
                      placeholder="Server Message"
                      className="w-full rounded-lg border border-gray-600/50 bg-black/30 px-3 py-2 text-sm text-gray-100 focus:outline-none focus:ring-2 focus:ring-purple-500/40"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-gray-300 mb-2">Message</label>
                    <textarea
                      value={manualTtsText}
                      onChange={(event) => setManualTtsText(event.target.value)}
                      rows={4}
                      maxLength={500}
                      placeholder="Type the message you want to convert to speech…"
                      className="w-full rounded-lg border border-gray-600/50 bg-black/30 px-3 py-3 text-sm text-gray-100 focus:outline-none focus:ring-2 focus:ring-purple-500/40 resize-none"
                    />
                    <div className="mt-2 text-xs text-gray-500 flex justify-between">
                      <span>{manualTtsText.trim().length} / 500 characters</span>
                      {manualTtsStatus === 'ready' && manualTtsResult && (
                        <span className="text-green-300">Audio ready</span>
                      )}
                    </div>
                  </div>
                </div>

                <div className="space-y-4">
                  {manualTtsResult && (
                    <div className="rounded-lg border border-green-500/30 bg-green-500/10 p-3 text-xs text-green-200">
                      <div className="font-semibold text-sm text-green-100 mb-1">{manualTtsResult.title}</div>
                      <p className="text-xs text-green-200/80 line-clamp-2">{manualTtsResult.content}</p>
                      {!isClientConnected && (
                        <p className="mt-2 text-xs text-yellow-200/80">
                          Client not connected — connect a client to send the audio.
                        </p>
                      )}
                    </div>
                  )}

                  <div className="flex flex-col gap-2">
                    <motion.button
                      whileHover={!isManualTtsProcessing ? { scale: 1.02 } : undefined}
                      whileTap={!isManualTtsProcessing ? { scale: 0.98 } : undefined}
                      onClick={handleGenerateManualTts}
                      disabled={isManualTtsProcessing}
                      className={`flex items-center justify-center gap-2 rounded-lg px-4 py-2 text-sm font-medium transition-colors ${isManualTtsProcessing
                          ? 'bg-purple-600/40 text-white/80 cursor-not-allowed'
                          : 'bg-purple-600 hover:bg-purple-500 text-white'
                        }`}
                    >
                      {manualTtsStatus === 'generating' ? (
                        <>
                          <div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                          Generating…
                        </>
                      ) : (
                        <>
                          <MessageSquare className="w-4 h-4" />
                          Generate TTS
                        </>
                      )}
                    </motion.button>

                    <motion.button
                      whileHover={manualTtsStatus === 'ready' && isClientConnected ? { scale: 1.02 } : undefined}
                      whileTap={manualTtsStatus === 'ready' && isClientConnected ? { scale: 0.98 } : undefined}
                      onClick={handleSendManualTts}
                      disabled={!manualTtsResult || manualTtsStatus === 'sending' || !isClientConnected}
                      className={`flex items-center justify-center gap-2 rounded-lg px-4 py-2 text-sm font-medium transition-colors ${!manualTtsResult || !isClientConnected
                          ? 'bg-gray-600/40 text-gray-300 cursor-not-allowed'
                          : manualTtsStatus === 'sending'
                            ? 'bg-cyan-600/40 text-white'
                            : 'bg-cyan-600 hover:bg-cyan-500 text-white'
                        }`}
                    >
                      {manualTtsStatus === 'sending' ? (
                        <>
                          <div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                          Sending…
                        </>
                      ) : (
                        <>
                          <ArrowDownCircle className="w-4 h-4" />
                          Send to Client
                        </>
                      )}
                    </motion.button>

                    <motion.button
                      whileHover={{ scale: 1.02 }}
                      whileTap={{ scale: 0.98 }}
                      onClick={resetManualTts}
                      className="flex items-center justify-center gap-2 rounded-lg px-4 py-2 text-sm font-medium border border-gray-600/50 text-gray-200 hover:bg-gray-700/40"
                    >
                      <X className="w-4 h-4" />
                      Clear
                    </motion.button>
                  </div>
                </div>
              </div>
            </motion.div>
          </div>
        </div>
      </div>
    </div>
  );
};

export default ServerPage;
