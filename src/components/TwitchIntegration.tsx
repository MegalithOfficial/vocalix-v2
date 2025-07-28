import { useState, useEffect } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';

interface UserInfo {
  id: string;
  login: string;
  display_name: string;
  email?: string;
}

interface ChannelPointsRedemption {
  id: string;
  user_name: string;
  user_input?: string;
  reward_title: string;
  reward_cost: number;
  reward_prompt?: string;
  redeemed_at: string;
}

export function TwitchIntegration() {
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [userInfo, setUserInfo] = useState<UserInfo | null>(null);
  const [clientId, setClientId] = useState('');
  const [clientSecret, setClientSecret] = useState('');
  const [useClientSecret, setUseClientSecret] = useState(false);
  const [isConnecting, setIsConnecting] = useState(false);
  const [status, setStatus] = useState('Not connected');
  const [redemptions, setRedemptions] = useState<ChannelPointsRedemption[]>([]);
  const [deviceCodeInstructions, setDeviceCodeInstructions] = useState<string | null>(null);

  useEffect(() => {
    // Check if already authenticated
    checkAuthStatus();

    // Listen for Twitch events
    const unlistenAuth = listen('TWITCH_AUTH_SUCCESS', (event) => {
      console.log('Twitch auth success:', event.payload);
      setUserInfo(event.payload as UserInfo);
      setIsAuthenticated(true);
      setIsConnecting(false);
      setDeviceCodeInstructions(null);
      setStatus('Connected to Twitch');
    });

    const unlistenDeviceCode = listen('TWITCH_DEVICE_CODE', (event) => {
      const instructions = event.payload as string;
      console.log('Device code instructions:', instructions);
      setDeviceCodeInstructions(instructions);
      setStatus('Waiting for authorization...');
    });

    const unlistenSignOut = listen('TWITCH_SIGNED_OUT', () => {
      setIsAuthenticated(false);
      setUserInfo(null);
      setDeviceCodeInstructions(null);
      setStatus('Signed out from Twitch');
    });

    const unlistenRedemption = listen('TWITCH_CHANNEL_POINTS_REDEMPTION', (event) => {
      const redemption = event.payload as ChannelPointsRedemption;
      console.log('Channel points redemption:', redemption);
      setRedemptions(prev => [redemption, ...prev.slice(0, 9)]); // Keep last 10
      setStatus(`New redemption: ${redemption.user_name} redeemed ${redemption.reward_title}`);
    });

    const unlistenStatus = listen('STATUS_UPDATE', (event) => {
      setStatus(event.payload as string);
    });

    const unlistenError = listen('ERROR', (event) => {
      setStatus(`Error: ${event.payload}`);
      setIsConnecting(false);
      setDeviceCodeInstructions(null);
    });

    return () => {
      unlistenAuth.then(f => f());
      unlistenDeviceCode.then(f => f());
      unlistenSignOut.then(f => f());
      unlistenRedemption.then(f => f());
      unlistenStatus.then(f => f());
      unlistenError.then(f => f());
    };
  }, []);

  const checkAuthStatus = async () => {
    try {
      const authenticated = await invoke<boolean>('twitch_is_authenticated');
      setIsAuthenticated(authenticated);
      
      if (authenticated) {
        const user = await invoke<UserInfo>('twitch_get_user_info');
        setUserInfo(user);
        setStatus('Connected to Twitch');
      }
    } catch (error) {
      console.error('Failed to check auth status:', error);
    }
  };

  const handleAuthenticate = async () => {
    if (!clientId) {
      setStatus('Please enter Client ID');
      return;
    }

    setIsConnecting(true);
    setDeviceCodeInstructions(null);
    setStatus('Starting authentication...');

    try {
      const result = await invoke<string>('twitch_authenticate', {
        clientId,
        clientSecret: useClientSecret && clientSecret ? clientSecret : null
      });
      setStatus(result);
    } catch (error) {
      setStatus(`Authentication failed: ${error}`);
      setIsConnecting(false);
      setDeviceCodeInstructions(null);
    }
  };

  const handleStartEventListener = async () => {
    if (!isAuthenticated) {
      setStatus('Please authenticate first');
      return;
    }

    setStatus('Starting event listener...');
    try {
      await invoke('twitch_start_event_listener');
      setStatus('Event listener started - listening for channel points!');
    } catch (error) {
      setStatus(`Failed to start event listener: ${error}`);
    }
  };

  const handleSignOut = async () => {
    try {
      await invoke('twitch_sign_out');
      setIsAuthenticated(false);
      setUserInfo(null);
      setRedemptions([]);
      setDeviceCodeInstructions(null);
      setStatus('Signed out from Twitch');
    } catch (error) {
      setStatus(`Sign out failed: ${error}`);
    }
  };

  const openTwitchUrl = (url: string) => {
    invoke('open_url', { url });
  };

  return (
    <div className="twitch-integration p-6 bg-gray-900 text-white rounded-lg">
      <h2 className="text-2xl font-bold mb-4 text-purple-400">Twitch Integration</h2>
      
      <div className="status mb-4 p-3 bg-gray-800 rounded">
        <strong>Status:</strong> {status}
      </div>

      {deviceCodeInstructions && (
        <div className="device-code-section mb-4 p-4 bg-purple-900 rounded border border-purple-600">
          <h3 className="text-lg font-semibold mb-2 text-purple-300">Authorization Required</h3>
          <p className="mb-3">{deviceCodeInstructions}</p>
          <div className="flex gap-2">
            <button
              onClick={() => {
                const url = deviceCodeInstructions.match(/https:\/\/[^\s]+/)?.[0];
                if (url) openTwitchUrl(url);
              }}
              className="px-4 py-2 bg-purple-600 hover:bg-purple-700 rounded font-medium"
            >
              Open Authorization Page
            </button>
          </div>
          <p className="text-sm text-gray-300 mt-2">
            After authorizing, the app will automatically continue...
          </p>
        </div>
      )}

      {!isAuthenticated ? (
        <div className="auth-section space-y-4">
          <h3 className="text-lg font-semibold">Authentication Required</h3>
          <p className="text-gray-300">
            To use Twitch features, you need to provide your Twitch application Client ID.
            Get it from the <a href="https://dev.twitch.tv/console" target="_blank" rel="noopener noreferrer" className="text-purple-400 hover:text-purple-300">Twitch Developer Console</a>.
          </p>
          
          <div className="space-y-3">
            <div>
              <label className="block text-sm font-medium mb-1">Client ID:</label>
              <input
                type="text"
                value={clientId}
                onChange={(e) => setClientId(e.target.value)}
                className="w-full px-3 py-2 bg-gray-800 border border-gray-600 rounded text-white"
                placeholder="Your Twitch Client ID"
              />
            </div>

            <div className="flex items-center space-x-2">
              <input
                type="checkbox"
                id="useClientSecret"
                checked={useClientSecret}
                onChange={(e) => setUseClientSecret(e.target.checked)}
                className="rounded"
              />
              <label htmlFor="useClientSecret" className="text-sm">
                Use Client Secret (for confidential applications)
              </label>
            </div>
            
            {useClientSecret && (
              <div>
                <label className="block text-sm font-medium mb-1">Client Secret (Optional):</label>
                <input
                  type="password"
                  value={clientSecret}
                  onChange={(e) => setClientSecret(e.target.value)}
                  className="w-full px-3 py-2 bg-gray-800 border border-gray-600 rounded text-white"
                  placeholder="Your Twitch Client Secret"
                />
                <p className="text-xs text-gray-400 mt-1">
                  Only needed for confidential applications. Most desktop apps should leave this empty.
                </p>
              </div>
            )}
            
            <button
              onClick={handleAuthenticate}
              disabled={isConnecting}
              className="px-4 py-2 bg-purple-600 hover:bg-purple-700 disabled:bg-purple-400 rounded font-medium"
            >
              {isConnecting ? 'Authenticating...' : 'Authenticate with Twitch'}
            </button>

            <div className="mt-4 p-3 bg-blue-900 rounded border border-blue-600">
              <h4 className="font-semibold text-blue-300 mb-2">Using Device Code Grant Flow</h4>
              <p className="text-sm text-gray-300">
                This app uses the Device Code Grant flow for authentication, which is more secure for desktop applications. 
                You'll be asked to visit a Twitch page and enter a code to authorize the application.
              </p>
            </div>
          </div>
        </div>
      ) : (
        <div className="authenticated-section space-y-4">
          <div className="user-info p-4 bg-gray-800 rounded">
            <h3 className="text-lg font-semibold mb-2">Connected Account</h3>
            {userInfo && (
              <div>
                <p><strong>Display Name:</strong> {userInfo.display_name}</p>
                <p><strong>Username:</strong> {userInfo.login}</p>
                <p><strong>User ID:</strong> {userInfo.id}</p>
                {userInfo.email && <p><strong>Email:</strong> {userInfo.email}</p>}
              </div>
            )}
          </div>

          <div className="controls space-x-3">
            <button
              onClick={handleStartEventListener}
              className="px-4 py-2 bg-green-600 hover:bg-green-700 rounded font-medium"
            >
              Start Event Listener
            </button>
            
            <button
              onClick={handleSignOut}
              className="px-4 py-2 bg-red-600 hover:bg-red-700 rounded font-medium"
            >
              Sign Out
            </button>
          </div>

          {redemptions.length > 0 && (
            <div className="redemptions mt-6">
              <h3 className="text-lg font-semibold mb-3">Recent Channel Points Redemptions</h3>
              <div className="space-y-2 max-h-64 overflow-y-auto">
                {redemptions.map((redemption) => (
                  <div key={redemption.id} className="p-3 bg-gray-800 rounded border-l-4 border-purple-500">
                    <div className="flex justify-between items-start">
                      <div>
                        <p className="font-medium text-purple-400">{redemption.reward_title}</p>
                        <p className="text-sm text-gray-300">
                          Redeemed by <strong>{redemption.user_name}</strong> for {redemption.reward_cost} points
                        </p>
                        {redemption.user_input && (
                          <p className="text-sm mt-1 italic">"{redemption.user_input}"</p>
                        )}
                      </div>
                      <span className="text-xs text-gray-400">
                        {new Date(redemption.redeemed_at).toLocaleTimeString()}
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
