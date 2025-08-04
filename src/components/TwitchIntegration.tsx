import { useState, useEffect } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { motion } from 'framer-motion';
import { Settings, Twitch, Shield, CheckCircle, AlertCircle, ExternalLink, Copy } from 'lucide-react';
import { logger } from '../utils/logger';

interface UserInfo {
  id: string;
  login: string;
  display_name: string;
  email?: string;
}

interface DeviceCodeInstructions {
  device_code: string;
  user_code: string;
  verification_uri: string;
  expires_in: number;
  interval: number;
}

interface TwitchIntegrationProps {
  onHostAsServer?: () => void;
}

type SetupStatus = 'checking' | 'needs_credentials' | 'needs_auth' | 'authenticating' | 'ready' | 'error';

export default function TwitchIntegration({}: TwitchIntegrationProps) {
  const [setupStatus, setSetupStatus] = useState<SetupStatus>('checking');
  const [userInfo, setUserInfo] = useState<UserInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [clientId, setClientId] = useState('');
  const [showCredentialsForm, setShowCredentialsForm] = useState(false);
  
  const [deviceInstructions, setDeviceInstructions] = useState<DeviceCodeInstructions | null>(null);
  const [timeRemaining, setTimeRemaining] = useState<number | null>(null);

  useEffect(() => {
    checkTwitchSetup();

    const unlistenDeviceCode = listen('TWITCH_DEVICE_CODE', (event) => {
      try {
        const deviceCodeInfo = event.payload as any;
        logger.info('TwitchIntegration', `Received device code info: ${JSON.stringify(deviceCodeInfo)}`);
        
        setDeviceInstructions({
          device_code: deviceCodeInfo.device_code || '',
          user_code: deviceCodeInfo.user_code,
          verification_uri: deviceCodeInfo.verification_uri,
          expires_in: deviceCodeInfo.expires_in || 1800,
          interval: 5
        });
        setTimeRemaining(deviceCodeInfo.expires_in || 1800);
        setSetupStatus('authenticating');
      } catch (error) {
        console.error('Failed to parse device code instructions:', error);
        setError('Failed to parse device code information');
      }
    });

    const unlistenAuth = listen('TWITCH_AUTH_SUCCESS', () => {
      setDeviceInstructions(null);
      setTimeRemaining(null);
      setSetupStatus('ready');
      checkTwitchSetup(); 
    });

    const unlistenAuthError = listen('ERROR', (event) => {
      setDeviceInstructions(null);
      setTimeRemaining(null);
      const errorMsg = event.payload as string;
      setError(`Authentication failed: ${errorMsg}`);
      setSetupStatus('needs_auth');
    });

    return () => {
      unlistenDeviceCode.then(f => f());
      unlistenAuth.then(f => f());
      unlistenAuthError.then(f => f());
    };
  }, []);

  useEffect(() => {
    if (timeRemaining === null || timeRemaining <= 0) return;

    const timer = setInterval(() => {
      setTimeRemaining(prev => {
        if (prev === null || prev <= 1) {
          setDeviceInstructions(null);
          setSetupStatus('needs_auth');
          setError('Authentication expired. Please try again.');
          return null;
        }
        return prev - 1;
      });
    }, 1000);

    return () => clearInterval(timer);
  }, [timeRemaining]);

  const checkTwitchSetup = async () => {
    setSetupStatus('checking');
    setError(null);

    try {
      const hasCredentials = await invoke<boolean>('twitch_has_saved_credentials');
      
      if (!hasCredentials) {
        setSetupStatus('needs_credentials');
        return;
      }

      const [savedClientId] = await invoke<[string, string | null]>('twitch_load_credentials');
      setClientId(savedClientId);

      const authStatus = await invoke<string>('twitch_get_auth_status');
      
      if (authStatus === 'valid' || authStatus === 'expiring_soon') {
        const user = await invoke<UserInfo>('twitch_get_user_info');
        setUserInfo(user);
        setSetupStatus('ready');
      } else {
        setSetupStatus('needs_auth');
      }
    } catch (error) {
      console.error('Failed to check Twitch setup:', error);
      setSetupStatus('error');
      setError(`Setup check failed: ${error}`);
    }
  };

  const handleSaveCredentials = async () => {
    if (!clientId.trim()) {
      setError('Please enter a valid Client ID');
      return;
    }

    try {
      await invoke('twitch_save_credentials', {
        clientId: clientId.trim(),
        clientSecret: null
      });
      
      setShowCredentialsForm(false);
      setError(null);
      await checkTwitchSetup();
    } catch (error) {
      setError(`Failed to save credentials: ${error}`);
    }
  };

  const handleDeleteCredentials = async () => {
    try {
      await invoke('twitch_delete_credentials');
      setClientId('');
      setUserInfo(null);
      setShowCredentialsForm(false);
      await checkTwitchSetup();
    } catch (error) {
      setError(`Failed to delete credentials: ${error}`);
    }
  };

  const handleAuthenticate = async () => {
    try {
      setError(null);
      
      const result = await invoke<string>('twitch_authenticate', {
        clientId,
        clientSecret: null
      });
      
      logger.info('TwitchIntegration', `Authentication initiated: ${result}`);
    } catch (error) {
      setError(`Authentication failed: ${error}`);
    }
  };

  const openVerificationUrl = () => {
    if (deviceInstructions?.verification_uri) {
      invoke('open_url', { url: deviceInstructions.verification_uri });
    }
  };

  const formatTime = (seconds: number): string => {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins}:${secs.toString().padStart(2, '0')}`;
  };

  const copyUserCode = () => {
    if (deviceInstructions?.user_code) {
      navigator.clipboard.writeText(deviceInstructions.user_code);
    }
  };

  const openTwitchConsole = () => {
    invoke('open_url', { url: 'https://dev.twitch.tv/console' });
  };

  const renderStatusIndicator = () => {
    switch (setupStatus) {
      case 'checking':
        return (
          <div className="flex items-center">
            <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-yellow-400 mr-2"></div>
            <span className="text-yellow-400 text-sm">Checking setup...</span>
          </div>
        );
      case 'needs_credentials':
        return (
          <div className="flex items-center">
            <AlertCircle className="w-4 h-4 text-red-400 mr-2" />
            <span className="text-red-400 text-sm">Credentials required</span>
          </div>
        );
      case 'needs_auth':
        return (
          <div className="flex items-center">
            <AlertCircle className="w-4 h-4 text-orange-400 mr-2" />
            <span className="text-orange-400 text-sm">Authentication required</span>
          </div>
        );
      case 'authenticating':
        return (
          <div className="flex items-center">
            <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-blue-400 mr-2"></div>
            <span className="text-blue-400 text-sm">Authenticating...</span>
          </div>
        );
      case 'ready':
        return (
          <div className="flex items-center">
            <CheckCircle className="w-4 h-4 text-green-400 mr-2" />
            <span className="text-green-400 text-sm">Ready to host</span>
          </div>
        );
      case 'error':
        return (
          <div className="flex items-center">
            <AlertCircle className="w-4 h-4 text-red-400 mr-2" />
            <span className="text-red-400 text-sm">Setup error</span>
          </div>
        );
    }
  };

  const renderCredentialsForm = () => (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -20 }}
      className="space-y-4"
    >
      <div className="p-4 bg-purple-500/10 border border-purple-500/20 rounded-lg">
        <div className="flex items-center space-x-2 mb-3">
          <ExternalLink className="w-4 h-4 text-purple-400" />
          <span className="text-purple-300 text-sm font-medium">Need a Client ID?</span>
          <motion.button
            whileHover={{ scale: 1.02 }}
            whileTap={{ scale: 0.98 }}
            onClick={openTwitchConsole}
            className="text-purple-400 hover:text-purple-300 text-sm underline"
          >
            Create Twitch App
          </motion.button>
        </div>
      </div>

      <div className="space-y-4">
        <div>
          <label className="block text-sm font-medium text-gray-300 mb-2">
            Client ID <span className="text-red-400">*</span>
          </label>
          <input
            type="text"
            value={clientId}
            onChange={(e) => setClientId(e.target.value)}
            className="w-full px-3 py-2 bg-gray-700/50 border border-gray-600 rounded-lg text-white focus:outline-none focus:border-purple-500"
            placeholder="your_client_id_here"
          />
        </div>

        <div className="flex gap-3">
          <motion.button
            whileHover={{ scale: 1.02 }}
            whileTap={{ scale: 0.98 }}
            onClick={handleSaveCredentials}
            disabled={!clientId.trim()}
            className="flex-1 px-4 py-2 bg-green-600 hover:bg-green-700 disabled:bg-green-400 disabled:cursor-not-allowed text-white rounded transition-colors"
          >
            Save Credentials
          </motion.button>
          <motion.button
            whileHover={{ scale: 1.02 }}
            whileTap={{ scale: 0.98 }}
            onClick={() => setShowCredentialsForm(false)}
            className="px-4 py-2 bg-gray-600 hover:bg-gray-700 text-white rounded transition-colors"
          >
            Cancel
          </motion.button>
        </div>
      </div>
    </motion.div>
  );

  const renderSetupContent = () => {
    if (showCredentialsForm) {
      return renderCredentialsForm();
    }

    switch (setupStatus) {
      case 'needs_credentials':
        return (
          <div className="space-y-4">
            <div className="text-center py-6">
              <Twitch className="w-12 h-12 text-purple-400 mx-auto mb-3" />
              <h3 className="text-lg font-medium text-white mb-2">Twitch Setup Required</h3>
              <p className="text-gray-400 text-sm mb-4">
                Configure your Twitch application credentials to enable server hosting.
              </p>
              <motion.button
                whileHover={{ scale: 1.02 }}
                whileTap={{ scale: 0.98 }}
                onClick={() => setShowCredentialsForm(true)}
                className="px-6 py-3 bg-purple-600 hover:bg-purple-700 text-white rounded-lg transition-colors"
              >
                <Settings className="w-4 h-4 inline mr-2" />
                Setup Twitch Integration
              </motion.button>
            </div>
          </div>
        );

      case 'needs_auth':
        return (
          <div className="space-y-4">
            <div className="text-center py-6">
              <Shield className="w-12 h-12 text-orange-400 mx-auto mb-3" />
              <h3 className="text-lg font-medium text-white mb-2">Authentication Required</h3>
              <p className="text-gray-400 text-sm mb-4">
                Your Twitch credentials are configured, but you need to authenticate your account.
              </p>
              <motion.button
                whileHover={{ scale: 1.02 }}
                whileTap={{ scale: 0.98 }}
                onClick={handleAuthenticate}
                className="px-6 py-3 bg-orange-600 hover:bg-orange-700 text-white rounded-lg transition-colors"
              >
                Authenticate with Twitch
              </motion.button>
            </div>
            
            <div className="border-t border-gray-600/30 pt-4">
              <div className="flex items-center justify-between">
                <div>
                  <h4 className="text-gray-300 font-medium">Current Credentials</h4>
                  <p className="text-gray-400 text-sm">Client ID: {clientId.substring(0, 8)}...</p>
                </div>
                <div className="flex gap-2">
                  <motion.button
                    whileHover={{ scale: 1.02 }}
                    whileTap={{ scale: 0.98 }}
                    onClick={() => setShowCredentialsForm(!showCredentialsForm)}
                    className="px-3 py-2 bg-gray-600 hover:bg-gray-700 text-white text-sm rounded transition-colors"
                  >
                    Edit
                  </motion.button>
                  <motion.button
                    whileHover={{ scale: 1.02 }}
                    whileTap={{ scale: 0.98 }}
                    onClick={handleDeleteCredentials}
                    className="px-3 py-2 bg-red-600 hover:bg-red-700 text-white text-sm rounded transition-colors"
                  >
                    Delete
                  </motion.button>
                </div>
              </div>
            </div>
          </div>
        );

      case 'authenticating':
        return (
          <div className="space-y-6">
            {deviceInstructions ? (
              <div>
                <div className="text-center mb-6">
                  <Shield className="w-12 h-12 text-blue-400 mx-auto mb-3" />
                  <h3 className="text-lg font-medium text-white mb-2">Complete Authentication</h3>
                  <p className="text-gray-400 text-sm">
                    Visit Twitch to authorize this application
                  </p>
                </div>
                
                <div className="space-y-4">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-4">
                      <div>
                        <label className="block text-sm text-gray-400 mb-2">Your Code</label>
                        <div className="flex items-center gap-3">
                          <code className="text-3xl font-mono text-white tracking-wider">
                            {deviceInstructions.user_code}
                          </code>
                          <motion.button
                            whileHover={{ scale: 1.05 }}
                            whileTap={{ scale: 0.95 }}
                            onClick={copyUserCode}
                            className="p-2 rounded-lg bg-gray-700 hover:bg-gray-600 text-gray-300 hover:text-white transition-all duration-200"
                            title="Copy code"
                          >
                            <Copy className="w-5 h-5" />
                          </motion.button>
                        </div>
                      </div>
                    </div>
                    
                    {timeRemaining && (
                      <div className="text-right">
                        <label className="block text-sm text-gray-400 mb-2">Time remaining</label>
                        <div className="text-2xl font-mono text-yellow-400">
                          {formatTime(timeRemaining)}
                        </div>
                      </div>
                    )}
                  </div>
                  
                  <div className="flex gap-4 justify-center pt-4">
                    <motion.button
                      whileHover={{ scale: 1.02 }}
                      whileTap={{ scale: 0.98 }}
                      onClick={openVerificationUrl}
                      className="px-8 py-3 bg-gradient-to-r from-green-600 to-green-700 hover:from-green-700 hover:to-green-800 text-white rounded-xl font-medium transition-all duration-200 flex items-center gap-2 shadow-lg hover:shadow-green-500/25"
                    >
                      <ExternalLink className="w-4 h-4" />
                      Open Twitch
                    </motion.button>
                    
                    <motion.button
                      whileHover={{ scale: 1.02 }}
                      whileTap={{ scale: 0.98 }}
                      onClick={() => {
                        setDeviceInstructions(null);
                        setTimeRemaining(null);
                        setSetupStatus('needs_auth');
                      }}
                      className="px-6 py-3 bg-gray-700 hover:bg-gray-600 text-gray-300 hover:text-white rounded-xl transition-all duration-200 shadow-lg hover:shadow-gray-500/25"
                    >
                      Cancel
                    </motion.button>
                  </div>
                </div>
                
                <p className="text-gray-500 text-sm text-center mt-6">
                  Waiting for authorization...
                </p>
              </div>
            ) : (
              <div className="text-center py-6">
                <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-400 mx-auto mb-3"></div>
                <p className="text-gray-400">Initializing authentication...</p>
              </div>
            )}
          </div>
        );

      case 'ready':
        return (
          <div className="space-y-6">
            {userInfo && (
              <div className="bg-gray-700/30 border border-gray-600/30 rounded-lg p-4">
                <div className="flex items-center justify-between">
                  <div className="flex items-center space-x-3">
                    <div className="w-10 h-10 bg-purple-500/20 rounded-lg flex items-center justify-center">
                      <Twitch className="w-5 h-5 text-purple-400" />
                    </div>
                    <div>
                      <h4 className="text-white font-medium">{userInfo.display_name}</h4>
                      <p className="text-gray-400 text-sm">@{userInfo.login}</p>
                    </div>
                  </div>
                  <div className="flex items-center space-x-2">
                    <div className="w-2 h-2 bg-green-400 rounded-full"></div>
                    <span className="text-green-400 text-sm">Connected</span>
                  </div>
                </div>
              </div>
            )}
            <div className="border-t border-gray-600/30 pt-4">
              <div className="flex items-center justify-between">
                <div>
                  <h4 className="text-gray-300 font-medium">Manage Integration</h4>
                  <p className="text-gray-400 text-sm">Update credentials or disconnect</p>
                </div>
                <div className="flex gap-2">
                  <motion.button
                    whileHover={{ scale: 1.02 }}
                    whileTap={{ scale: 0.98 }}
                    onClick={() => setShowCredentialsForm(!showCredentialsForm)}
                    className="px-3 py-2 bg-gray-600 hover:bg-gray-700 text-white text-sm rounded transition-colors"
                  >
                    <Settings className="w-4 h-4" />
                  </motion.button>
                  <motion.button
                    whileHover={{ scale: 1.02 }}
                    whileTap={{ scale: 0.98 }}
                    onClick={handleDeleteCredentials}
                    className="px-3 py-2 bg-red-600 hover:bg-red-700 text-white text-sm rounded transition-colors"
                  >
                    Disconnect
                  </motion.button>
                </div>
              </div>
            </div>
          </div>
        );

      case 'error':
        return (
          <div className="text-center py-6">
            <AlertCircle className="w-12 h-12 text-red-400 mx-auto mb-3" />
            <h3 className="text-lg font-medium text-white mb-2">Setup Error</h3>
            <p className="text-red-400 text-sm mb-4">{error}</p>
            <motion.button
              whileHover={{ scale: 1.02 }}
              whileTap={{ scale: 0.98 }}
              onClick={() => {
                setError(null);
                checkTwitchSetup();
              }}
              className="px-4 py-2 bg-red-600 hover:bg-red-700 text-white rounded transition-colors"
            >
              Retry Setup
            </motion.button>
          </div>
        );

      default:
        return (
          <div className="text-center py-6">
            <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-purple-400 mx-auto mb-3"></div>
            <p className="text-gray-400">Checking Twitch integration status...</p>
          </div>
        );
    }
  };

  return (
    <div>
      <div className="flex items-center mb-6">
        <div className="w-12 h-12 bg-purple-500/20 rounded-xl flex items-center justify-center mr-4">
          <Twitch className="w-6 h-6 text-purple-400" />
        </div>
        <div className="flex-1">
          <div className="flex items-center justify-between">
            <div>
              <h2 className="text-xl font-bold text-white">Twitch Integration</h2>
              <p className="text-gray-400 text-sm">Configure Twitch account authentication</p>
            </div>
            {renderStatusIndicator()}
          </div>
        </div>
      </div>

      {error && (
        <div className="mb-4 p-3 bg-red-500/10 border border-red-500/20 rounded-lg">
          <div className="flex items-center space-x-2">
            <AlertCircle className="w-4 h-4 text-red-400" />
            <span className="text-red-300 text-sm">{error}</span>
          </div>
        </div>
      )}

      {renderSetupContent()}


    </div>
  );
}
