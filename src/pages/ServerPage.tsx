import { motion } from 'framer-motion';
import { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { 
  ArrowLeft, 
  Copy, 
  CheckCircle, 
  Users, 
  Wifi,
  AlertCircle,
  Network,
  Shield
} from 'lucide-react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';

interface NetworkInfo {
  lan_ip: string;
  port: number;
  is_running: boolean;
}

const ServerPage = () => {
  const [isServerRunning, setIsServerRunning] = useState(false);
  const [networkInfo, setNetworkInfo] = useState<NetworkInfo | null>(null);
  const [connectedClients, setConnectedClients] = useState(0);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  
  // Pairing states
  const [connectionStatus, setConnectionStatus] = useState<'waiting' | 'pairing' | 'connected'>('waiting');
  const [pairingCode, setPairingCode] = useState<string | null>(null);
  const [statusMessage, setStatusMessage] = useState('');

  // Server logs state
  const [serverLogs, setServerLogs] = useState<Array<{type: 'info' | 'error' | 'success', message: string, timestamp: string}>>([]);

  const addServerLog = (type: 'info' | 'error' | 'success', message: string) => {
    const timestamp = new Date().toLocaleTimeString();
    setServerLogs(prev => [...prev.slice(-9), { type, message, timestamp }]); // Keep last 10 logs
  };

  useEffect(() => {
    let mounted = true;
    let serverInitialized = false;

    // Get network info and auto-start server
    const initializeServer = async () => {
      if (serverInitialized) return; // Prevent multiple initializations
      serverInitialized = true;
      
      try {
        if (mounted && !isServerRunning) {
          await handleStartServer();
          // Get network info after server starts
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

    // Listen for status updates
    const unlistenStatus = listen('STATUS_UPDATE', (event) => {
      if (!mounted) return;
      
      const message = event.payload as string;
      console.log('Server status:', message);
      setStatusMessage(message);
      
      if (message.includes('Listening on')) {
        setIsServerRunning(true);
        setConnectionStatus('waiting');
        setError(null);
        // Refresh network info when server starts
        getNetworkInfo();
      } else if (message.includes('Accepted connection')) {
        setConnectedClients(prev => prev + 1);
      } else if (
        message.includes('New peer') ||
        message.includes('Known peer found') ||
        message.includes('Authentication successful') ||
        message.toLowerCase().includes('both peers confirmed')
      ) {
        // Keep UI in pairing until final SUCCESS is received
        setConnectionStatus('pairing');
      }
    });

    // Listen for pairing code requirement
    const unlistenPairing = listen('PAIRING_REQUIRED', (event) => {
      if (!mounted) return;
      
      const code = event.payload as string;
      console.log('Pairing code required:', code);
      setPairingCode(code);
      setConnectionStatus('pairing');
      setStatusMessage('Please verify the 6-digit code with your client');
    });

    // Listen for successful connection - only this should set connected
    const unlistenSuccess = listen('SUCCESS', (event) => {
      if (!mounted) return;
      
      const message = event.payload as string;
      console.log('Connection success:', message);
      
      if (message.includes('Secure encrypted channel established')) {
        setConnectionStatus('connected');
        setStatusMessage('Secure connection established!');
        setPairingCode(null);
        
        // Transition to main server UI after a brief moment
        setTimeout(() => {
          if (mounted) {
            setStatusMessage('Ready to receive audio requests');
          }
        }, 2000);
      }
    });

    // Listen for errors
    const unlistenError = listen('ERROR', (event) => {
      if (!mounted) return;
      
      const errorMessage = event.payload as string;
      console.error('P2P error:', errorMessage);
      setError(errorMessage);
      setConnectionStatus('waiting');
      setPairingCode(null);
    });

    // Listen for Twitch redemptions
    const unlistenTwitchRedemption = listen('TWITCH_CHANNEL_POINTS_REDEMPTION', (event) => {
      if (!mounted) return;
      
      const redemptionData = event.payload as any;
      console.log('Twitch redemption received:', redemptionData);
      addServerLog('info', `Redemption: ${redemptionData.user_name} redeemed "${redemptionData.reward_title}" (${redemptionData.reward_cost} points)`);
    });

    return () => {
      mounted = false;
      unlistenStatus.then(f => f());
      unlistenPairing.then(f => f());
      unlistenSuccess.then(f => f());
      unlistenError.then(f => f());
      unlistenTwitchRedemption.then(f => f());
    };
  }, []); // Empty dependency array to run only once

  const getNetworkInfo = async () => {
    try {
      const info = await invoke('get_lan_ip') as string;
      setNetworkInfo({
        lan_ip: info,
        port: 12345, // P2P system uses port 12345
        is_running: true // Set as running since we're getting this after server starts
      });
      console.log('Network info retrieved:', info);
    } catch (error) {
      console.error('Failed to get network info:', error);
      setError('Failed to get network information');
    }
  };

  const handleStartServer = async () => {
    // Prevent starting if already running
    if (isServerRunning) {
      console.log('Server is already running, skipping start attempt');
      return;
    }

    try {
      setError(null);
      console.log('Starting P2P listener...');
      // Start the P2P listener
      await invoke('start_listener');
      // The status update event will set isServerRunning to true
    } catch (error) {
      console.error('Failed to start server:', error);
      
      // Check if it's a "already in use" error, which we can ignore
      const errorStr = error as string;
      if (errorStr.includes('already in use') || errorStr.includes('Address already in use')) {
        console.log('Port already in use, server might already be running');
        setIsServerRunning(true);
        setConnectionStatus('waiting');
      } else {
        setError(`Failed to start server: ${error}`);
      }
    }
  };

  const handleConfirmPairing = async () => {
    try {
      await invoke('user_confirm_pairing');
      // Keep in pairing state and inform operator that we're waiting on the client
      setConnectionStatus('pairing');
      setStatusMessage('Pairing confirmed locally. Waiting for the client to confirm...');
    } catch (error) {
      console.error('Failed to confirm pairing:', error);
      setError(`Failed to confirm pairing: ${error}`);
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
            <div className="w-3 h-3 bg-purple-400 rounded-full mr-3"></div>
            <h1 className="text-xl font-semibold text-white">Server Management</h1>
          </div>
        </div>
      </div>

      {/* Main Content */}
      <div className="flex-1 pt-24 pb-8 px-8 overflow-auto">
        <div className="max-w-4xl mx-auto">
          
          {/* Connection Status Display */}
          <motion.div
            initial={{ y: 20, opacity: 0 }}
            animate={{ y: 0, opacity: 1 }}
            transition={{ duration: 0.5 }}
            className="bg-gray-800/50 border border-gray-700/50 rounded-2xl p-8 mb-8"
          >
            {/* Waiting for Client */}
            {connectionStatus === 'waiting' && (
              <div className="text-center">
                <motion.div
                  animate={{ rotate: 360 }}
                  transition={{ duration: 2, repeat: Infinity, ease: "linear" }}
                  className="w-16 h-16 bg-gradient-to-br from-purple-500 to-cyan-400 rounded-2xl flex items-center justify-center mx-auto mb-6"
                >
                  <Wifi className="w-8 h-8 text-white" />
                </motion.div>
                <h2 className="text-2xl font-bold text-white mb-4">Waiting for Client Connection</h2>
                <p className="text-gray-400 mb-6">{statusMessage || 'Server is ready and listening for connections'}</p>
                
                {networkInfo && (
                  <div className="bg-gray-700/30 border border-gray-600/30 rounded-lg p-4 mb-6">
                    <p className="text-sm text-gray-300 mb-2">Share this address with your client:</p>
                    <div className="flex items-center justify-center gap-4">
                      <p className="text-xl font-mono text-white">{networkInfo.lan_ip}:{networkInfo.port}</p>
                      <motion.button
                        whileHover={{ scale: 1.05 }}
                        whileTap={{ scale: 0.95 }}
                        onClick={copyConnectionInfo}
                        className="flex items-center px-3 py-2 bg-cyan-500 hover:bg-cyan-600 text-white rounded-lg transition-colors"
                      >
                        {copied ? (
                          <>
                            <CheckCircle className="w-4 h-4 mr-2" />
                            Copied!
                          </>
                        ) : (
                          <>
                            <Copy className="w-4 h-4 mr-2" />
                            Copy
                          </>
                        )}
                      </motion.button>
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* Pairing Required */}
            {connectionStatus === 'pairing' && (
              <div className="text-center">
                <motion.div
                  initial={{ scale: 0.8, opacity: 0 }}
                  animate={{ scale: 1, opacity: 1 }}
                  className="w-16 h-16 bg-gradient-to-br from-purple-500 to-cyan-400 rounded-2xl flex items-center justify-center mx-auto mb-6"
                >
                  <Shield className="w-8 h-8 text-white" />
                </motion.div>
                <h2 className="text-2xl font-bold text-white mb-4">Client Pairing Required</h2>
                <p className="text-gray-400 mb-6">{statusMessage}</p>
                
                {pairingCode && (
                  <div className="bg-gradient-to-br from-purple-900/50 to-cyan-900/50 border border-purple-500/30 rounded-xl p-8 mb-6">
                    <h3 className="text-lg font-semibold text-white mb-4">Verification Code</h3>
                    <div className="text-4xl font-mono font-bold text-white tracking-widest mb-4">
                      {pairingCode}
                    </div>
                    <p className="text-gray-300 text-sm mb-6">
                      Please verify this 6-digit code matches on your client device
                    </p>
                    <motion.button
                      whileHover={{ scale: 1.05 }}
                      whileTap={{ scale: 0.95 }}
                      onClick={handleConfirmPairing}
                      className="bg-gradient-to-r from-green-500 to-green-600 hover:from-green-600 hover:to-green-700 text-white px-8 py-3 rounded-lg font-semibold transition-all"
                    >
                      Confirm Pairing
                    </motion.button>
                    <p className="text-gray-300 text-xs mt-3">After confirming, please wait for the client. The connection will complete automatically once both sides confirm.</p>
                  </div>
                )}
              </div>
            )}

            {/* Connected */}
            {connectionStatus === 'connected' && (
              <div className="text-center">
                <motion.div
                  initial={{ scale: 0.8, opacity: 0 }}
                  animate={{ scale: 1, opacity: 1 }}
                  className="w-16 h-16 bg-gradient-to-br from-green-500 to-green-600 rounded-2xl flex items-center justify-center mx-auto mb-6"
                >
                  <CheckCircle className="w-8 h-8 text-white" />
                </motion.div>
                <h2 className="text-2xl font-bold text-white mb-4">Client Connected Successfully</h2>
                <p className="text-gray-400 mb-6">{statusMessage}</p>
                
                <div className="bg-green-900/30 border border-green-500/30 rounded-lg p-4">
                  <p className="text-green-300 font-semibold">Secure encrypted channel established!</p>
                  <p className="text-green-400 text-sm mt-1">Ready to receive audio requests</p>
                </div>
              </div>
            )}

            {/* Error Display */}
            {error && (
              <motion.div
                initial={{ opacity: 0, height: 0 }}
                animate={{ opacity: 1, height: 'auto' }}
                className="bg-red-900/50 border border-red-500/30 rounded-lg p-4 mt-6"
              >
                <div className="flex items-center">
                  <AlertCircle className="w-5 h-5 text-red-400 mr-3" />
                  <p className="text-red-300">{error}</p>
                </div>
              </motion.div>
            )}
          </motion.div>

          {/* Status Cards - Only show when connected */}
          {connectionStatus === 'connected' && (
            <div className="grid grid-cols-3 gap-6 mb-8">
              {/* Server Status */}
              <motion.div
                initial={{ y: 20, opacity: 0 }}
                animate={{ y: 0, opacity: 1 }}
                transition={{ duration: 0.5, delay: 0.1 }}
                className="bg-gray-800/40 border border-gray-700/40 rounded-xl p-6"
              >
                <div className="flex items-center mb-4">
                  <div className={`w-10 h-10 rounded-lg flex items-center justify-center mr-3 ${
                    isServerRunning ? 'bg-green-500/20' : 'bg-gray-600/20'
                  }`}>
                    <Network className={`w-5 h-5 ${isServerRunning ? 'text-green-400' : 'text-gray-400'}`} />
                  </div>
                  <div>
                    <h3 className="text-sm font-medium text-gray-300">Server Status</h3>
                  </div>
                </div>
                <div className="flex items-center">
                  <div className={`w-2 h-2 rounded-full mr-2 ${
                    isServerRunning ? 'bg-green-400' : 'bg-gray-500'
                  }`}></div>
                  <span className={`text-sm font-medium ${
                    isServerRunning ? 'text-green-400' : 'text-gray-400'
                  }`}>
                    {isServerRunning ? 'Online' : 'Offline'}
                  </span>
                </div>
              </motion.div>

              {/* Connected Clients */}
              <motion.div
                initial={{ y: 20, opacity: 0 }}
                animate={{ y: 0, opacity: 1 }}
                transition={{ duration: 0.5, delay: 0.2 }}
                className="bg-gray-800/40 border border-gray-700/40 rounded-xl p-6"
              >
                <div className="flex items-center mb-4">
                  <div className="w-10 h-10 bg-cyan-500/20 rounded-lg flex items-center justify-center mr-3">
                    <Users className="w-5 h-5 text-cyan-400" />
                  </div>
                  <div>
                    <h3 className="text-sm font-medium text-gray-300">Connected Clients</h3>
                  </div>
                </div>
                <div className="flex items-center">
                  <span className="text-2xl font-bold text-white mr-2">{connectedClients}</span>
                  <span className="text-sm text-gray-400">active</span>
                </div>
              </motion.div>

              {/* Security Status */}
              <motion.div
                initial={{ y: 20, opacity: 0 }}
                animate={{ y: 0, opacity: 1 }}
                transition={{ duration: 0.5, delay: 0.3 }}
                className="bg-gray-800/40 border border-gray-700/40 rounded-xl p-6"
              >
                <div className="flex items-center mb-4">
                  <div className="w-10 h-10 bg-purple-500/20 rounded-lg flex items-center justify-center mr-3">
                    <Shield className="w-5 h-5 text-purple-400" />
                  </div>
                  <div>
                    <h3 className="text-sm font-medium text-gray-300">Security</h3>
                  </div>
                </div>
                <div className="flex items-center">
                  <div className="w-2 h-2 bg-purple-400 rounded-full mr-2"></div>
                  <span className="text-sm font-medium text-purple-400">Encrypted</span>
                </div>
              </motion.div>
            </div>
          )}

          {/* Server Logs - Only show when connected */}
          {connectionStatus === 'connected' && (
            <motion.div
              initial={{ y: 20, opacity: 0 }}
              animate={{ y: 0, opacity: 1 }}
              transition={{ duration: 0.5, delay: 0.5 }}
              className="bg-gray-800/30 border border-gray-700/30 rounded-xl p-6"
            >
              <h3 className="text-lg font-semibold text-white mb-4">Server Logs</h3>
              <div className="bg-black/40 rounded-lg p-4 font-mono text-sm text-gray-300 h-48 overflow-y-auto">
                {isServerRunning && networkInfo ? (
                  <div className="space-y-1">
                    <div className="text-green-400">[INFO] Server started on {networkInfo.lan_ip}:{networkInfo.port}</div>
                    <div className="text-cyan-400">[INFO] Encryption enabled</div>
                    <div className="text-green-400">[INFO] Client connected and authenticated</div>
                    <div className="text-purple-400">[INFO] Secure encrypted channel established</div>
                    <div className="text-gray-300">[INFO] Ready to receive audio requests</div>
                    {connectedClients > 0 && (
                      <div className="text-cyan-400">[INFO] {connectedClients} client(s) connected</div>
                    )}
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
          )}
        </div>
      </div>
    </div>
  );
};

export default ServerPage;
