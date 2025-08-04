export type SettingsTab = 'twitch' | 'audio' | 'tts' | 'python-env' | 'security' | 'logs';

export interface TwitchRedemption {
  id: string;
  title: string;
  cost: number;
  enabled: boolean;
  is_enabled: boolean;
  prompt?: string;
}

export interface RedemptionConfig {
  enabled: boolean;
  ttsType: 'dynamic' | 'static';
  dynamicTemplate: string;
  staticFiles: File[];
  staticFileNames: string[];
  timerEnabled: boolean;
  timerDuration: string; // MM:SS format
}

export interface SerializableRedemptionConfig {
  enabled: boolean;
  ttsType: 'dynamic' | 'static';
  dynamicTemplate: string;
  staticFiles: Array<{
    name: string;
    size: number;
    type: string;
    lastModified: number;
  }>;
  staticFileNames: string[];
  timerEnabled: boolean;
  timerDuration: string;
}

export interface RvcSettings {
  device: string;
  inferenceRate: number;
  filterRadius: number;
  resampleRate: number;
  protectRate: number;
}

export type TwitchAuthStatus = 'checking' | 'needs_credentials' | 'needs_auth' | 'authenticating' | 'ready' | 'error';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogEntry {
  timestamp: string;
  level: LogLevel;
  component: string;
  message: string;
}

export interface LogsSettings {
  maxLogEntries: number;
  logLevel: LogLevel;
  showDebugLogs: boolean;
  autoScroll: boolean;
}
