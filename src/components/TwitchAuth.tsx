import { useState, useEffect } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';

interface DeviceCodeInstructions {
  device_code: string;
  user_code: string;
  verification_uri: string;
  expires_in: number;
  interval: number;
}

interface TwitchAuthProps {
  onAuthSuccess?: (userInfo: any) => void;
  onAuthError?: (error: string) => void;
  clientId: string;
  clientSecret?: string;
}

export function TwitchAuth({ onAuthSuccess, onAuthError, clientId, clientSecret }: TwitchAuthProps) {
  const [isAuthenticating, setIsAuthenticating] = useState(false);
  const [deviceInstructions, setDeviceInstructions] = useState<DeviceCodeInstructions | null>(null);
  const [status, setStatus] = useState('');
  const [timeRemaining, setTimeRemaining] = useState<number | null>(null);

  useEffect(() => {
    // Listen for device code instructions
    const unlistenDeviceCode = listen('TWITCH_DEVICE_CODE', (event) => {
      try {
        const deviceCodeInfo = event.payload as any;
        console.log('Received device code info:', deviceCodeInfo);
        
        setDeviceInstructions({
          device_code: deviceCodeInfo.device_code || '',
          user_code: deviceCodeInfo.user_code,
          verification_uri: deviceCodeInfo.verification_uri,
          expires_in: deviceCodeInfo.expires_in || 1800,
          interval: 5
        });
        setTimeRemaining(deviceCodeInfo.expires_in || 1800);
      } catch (error) {
        console.error('Failed to parse device code instructions:', error);
        setStatus('Failed to parse device code information');
      }
    });

    const unlistenAuth = listen('TWITCH_AUTH_SUCCESS', (event) => {
      setIsAuthenticating(false);
      setDeviceInstructions(null);
      setTimeRemaining(null);
      setStatus('Authentication successful!');
      onAuthSuccess?.(event.payload);
    });

    const unlistenError = listen('ERROR', (event) => {
      setIsAuthenticating(false);
      setDeviceInstructions(null);
      setTimeRemaining(null);
      const errorMsg = event.payload as string;
      setStatus(`Error: ${errorMsg}`);
      onAuthError?.(errorMsg);
    });

    return () => {
      unlistenDeviceCode.then(f => f());
      unlistenAuth.then(f => f());
      unlistenError.then(f => f());
    };
  }, [onAuthSuccess, onAuthError]);

  // Countdown timer
  useEffect(() => {
    if (timeRemaining === null || timeRemaining <= 0) return;

    const timer = setInterval(() => {
      setTimeRemaining(prev => {
        if (prev === null || prev <= 1) {
          setDeviceInstructions(null);
          setIsAuthenticating(false);
          setStatus('Authentication expired. Please try again.');
          return null;
        }
        return prev - 1;
      });
    }, 1000);

    return () => clearInterval(timer);
  }, [timeRemaining]);

  const startAuthentication = async () => {
    if (!clientId) {
      setStatus('Client ID is required');
      onAuthError?.('Client ID is required');
      return;
    }

    setIsAuthenticating(true);
    setStatus('Starting authentication...');
    setDeviceInstructions(null);

    try {
      await invoke('twitch_authenticate', {
        clientId,
        clientSecret: clientSecret || null
      });
    } catch (error) {
      setIsAuthenticating(false);
      const errorMsg = `Authentication failed: ${error}`;
      setStatus(errorMsg);
      onAuthError?.(errorMsg);
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

  return (
    <div className="twitch-auth p-4 bg-gray-800 rounded-lg border border-gray-700">
      <h3 className="text-lg font-semibold text-white mb-4">Twitch Authentication</h3>
      
      {!isAuthenticating && !deviceInstructions ? (
        <div className="space-y-4">
          <p className="text-gray-300 text-sm">
            Connect your Twitch account to enable channel points integration and other features.
          </p>
          <button
            onClick={startAuthentication}
            className="w-full px-4 py-2 bg-purple-600 hover:bg-purple-700 text-white rounded font-medium transition-colors"
          >
            Authenticate with Twitch
          </button>
        </div>
      ) : deviceInstructions ? (
        <div className="space-y-4">
          <div className="bg-purple-900 border border-purple-600 rounded-lg p-4">
            <h4 className="text-purple-300 font-medium mb-2">Authorization Required</h4>
            <p className="text-gray-300 text-sm mb-3">
              Go to the verification page and enter the code below:
            </p>
            
            <div className="flex items-center justify-between mb-3">
              <div>
                <label className="block text-xs text-gray-400 mb-1">User Code:</label>
                <div className="flex items-center space-x-2">
                  <code className="text-lg font-mono bg-gray-700 px-3 py-1 rounded text-white">
                    {deviceInstructions.user_code}
                  </code>
                  <button
                    onClick={copyUserCode}
                    className="px-2 py-1 bg-gray-600 hover:bg-gray-500 text-xs text-white rounded transition-colors"
                  >
                    Copy
                  </button>
                </div>
              </div>
              
              {timeRemaining && (
                <div className="text-right">
                  <label className="block text-xs text-gray-400 mb-1">Expires in:</label>
                  <div className="text-lg font-mono text-yellow-400">
                    {formatTime(timeRemaining)}
                  </div>
                </div>
              )}
            </div>
            
            <button
              onClick={openVerificationUrl}
              className="w-full px-4 py-2 bg-purple-600 hover:bg-purple-700 text-white rounded font-medium transition-colors"
            >
              Open Verification Page
            </button>
            
            <p className="text-xs text-gray-400 mt-2 text-center">
              The app will automatically continue once you complete authorization
            </p>
          </div>
        </div>
      ) : (
        <div className="text-center">
          <div className="inline-block w-6 h-6 border-2 border-purple-400 border-t-transparent rounded-full animate-spin mb-2"></div>
          <p className="text-gray-300 text-sm">Starting authentication...</p>
        </div>
      )}
      
      {status && (
        <div className="mt-3 p-2 bg-gray-700 rounded text-sm text-gray-300">
          {status}
        </div>
      )}
    </div>
  );
}