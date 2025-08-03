import { motion } from 'framer-motion';
import { useState, useEffect } from 'react';
import { ArrowLeft, Wifi, WifiOff, Shield, Mic, MicOff, Volume2, AlertCircle } from 'lucide-react';
import { Link } from 'react-router-dom';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';

const ClientPage = () => {
   const [isConnected, setIsConnected] = useState(false);
   const [serverAddress, setServerAddress] = useState('');
   const [isConnecting, setIsConnecting] = useState(false);
   const [isMuted, setIsMuted] = useState(false);
   const [error, setError] = useState<string | null>(null);
   const [statusMessage, setStatusMessage] = useState('');
   const [pairingCode, setPairingCode] = useState<string | null>(null);
   const [connectionState, setConnectionState] = useState<'disconnected' | 'connecting' | 'pairing' | 'connected'>('disconnected');
   const [logs, setLogs] = useState<Array<{type: 'info' | 'error' | 'success', message: string}>>([]);

   const addLog = (type: 'info' | 'error' | 'success', message: string) => {
      setLogs(prev => [...prev, { type, message }].slice(-10)); // Keep last 10 logs
   };

   useEffect(() => {
      // Listen for status updates
      const unlistenStatus = listen('STATUS_UPDATE', (event) => {
         const message = event.payload as string;
         console.log('Client status:', message);
         setStatusMessage(message);
         addLog('info', message);
         
         if (message.includes('Connecting to')) {
            setConnectionState('connecting');
         } else if (message.includes('New peer') || message.includes('Known peer found')) {
            setConnectionState('pairing');
         } else if (message.includes('Challenge received') || message.includes('Authentication')) {
            setConnectionState('pairing');
         }
      });

      // Listen for pairing code requirement
      const unlistenPairing = listen('PAIRING_REQUIRED', (event) => {
         const code = event.payload as string;
         console.log('Pairing code required:', code);
         setPairingCode(code);
         setConnectionState('pairing');
         addLog('info', `Pairing code: ${code}`);
      });

      // Listen for successful connection
      const unlistenSuccess = listen('SUCCESS', (event) => {
         const message = event.payload as string;
         console.log('Connection success:', message);
         addLog('success', message);
         
         if (message.includes('Secure encrypted channel established')) {
            setIsConnected(true);
            setConnectionState('connected');
            setIsConnecting(false);
            setPairingCode(null);
            setError(null);
         }
      });

      // Listen for errors
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
         unlistenError.then(f => f());
      };
   }, []);

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
         addLog('info', 'Pairing confirmed! Waiting for server confirmation...');
      } catch (error) {
         console.error('Failed to confirm pairing:', error);
         setError(`Failed to confirm pairing: ${error}`);
         addLog('error', `Pairing confirmation failed: ${error}`);
      }
   };

   const handleDisconnect = () => {
      setIsConnected(false);
      setIsMuted(false);
      setConnectionState('disconnected');
      setError(null);
      setPairingCode(null);
      setStatusMessage('');
      addLog('info', 'Disconnected from server');
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
                  <div className={`w-3 h-3 rounded-full mr-3 ${
                     connectionState === 'connected' ? 'bg-green-400' : 
                     connectionState === 'connecting' || connectionState === 'pairing' ? 'bg-yellow-400' :
                     'bg-red-400'
                  }`}></div>
                  <h1 className="text-xl font-semibold text-white">Client Connection</h1>
               </div>
            </div>
         </div>

         {/* Main Content */}
         <div className="flex-1 pt-24 pb-8 px-8 overflow-auto">
            <div className="max-w-4xl mx-auto">
               {/* Error Display */}
               {error && (
                  <motion.div
                     initial={{ y: -20, opacity: 0 }}
                     animate={{ y: 0, opacity: 1 }}
                     className="bg-red-500/10 border border-red-500/20 rounded-xl p-4 mb-6"
                  >
                     <div className="flex items-center gap-2">
                        <AlertCircle size={16} className="text-red-400" />
                        <span className="text-red-300 text-sm">{error}</span>
                     </div>
                  </motion.div>
               )}

               {/* Connection Panel */}
               <motion.div
                  initial={{ y: 20, opacity: 0 }}
                  animate={{ y: 0, opacity: 1 }}
                  transition={{ duration: 0.5 }}
                  className="bg-gray-800/50 border border-gray-700/50 rounded-2xl p-8 mb-8"
               >
                  <div className="mb-8">
                     <h2 className="text-2xl font-bold text-white mb-2">Server Connection</h2>
                     <p className="text-gray-400">Connect to a secure audio server</p>
                     {statusMessage && (
                        <p className="text-cyan-400 text-sm mt-2">{statusMessage}</p>
                     )}
                  </div>

                  {/* Pairing Code Display */}
                  {pairingCode && (
                     <div className="mb-6 p-4 bg-yellow-500/20 border border-yellow-500/30 rounded-xl">
                        <h3 className="text-yellow-300 font-semibold mb-2">Pairing Required</h3>
                        <p className="text-yellow-200 text-sm mb-3">
                           Please confirm this pairing code on the server:
                        </p>
                        <div className="text-2xl font-mono font-bold text-yellow-300 mb-4 text-center bg-black/20 rounded-lg py-2">
                           {pairingCode}
                        </div>
                        <motion.button
                           whileHover={{ scale: 1.02 }}
                           whileTap={{ scale: 0.98 }}
                           onClick={handleConfirmPairing}
                           className="w-full py-2 bg-yellow-500/30 text-yellow-300 font-semibold rounded-xl hover:bg-yellow-500/40 transition-colors duration-200"
                        >
                           Confirm Pairing
                        </motion.button>
                     </div>
                  )}

                  {connectionState === 'disconnected' ? (
                     <div className="space-y-6">
                        <div>
                           <label className="block text-sm font-medium text-gray-300 mb-2">Server Address</label>
                           <input
                              type="text"
                              value={serverAddress}
                              onChange={(e) => setServerAddress(e.target.value)}
                              placeholder="192.168.1.100:8080"
                              disabled={isConnecting}
                              className="w-full px-4 py-3 bg-gray-700/50 border border-gray-600 rounded-lg text-white placeholder-gray-400 focus:outline-none focus:border-cyan-500 disabled:opacity-50"
                           />
                        </div>

                        <motion.button
                           whileHover={{ scale: isConnecting ? 1 : 1.02 }}
                           whileTap={{ scale: isConnecting ? 1 : 0.98 }}
                           onClick={handleConnect}
                           disabled={isConnecting || !serverAddress.trim()}
                           className="w-full bg-gradient-to-r from-cyan-500 to-cyan-600 hover:from-cyan-600 hover:to-cyan-700 text-white py-4 rounded-xl font-semibold transition-all duration-300 disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center"
                        >
                           {isConnecting ? (
                              <>
                                 <div className="w-5 h-5 border-2 border-white/30 border-t-white rounded-full animate-spin mr-2"></div>
                                 Connecting...
                              </>
                           ) : (
                              'Connect to Server'
                           )}
                        </motion.button>
                     </div>
                  ) : connectionState === 'connected' ? (
                     <div className="space-y-6">
                        <div className="bg-green-500/10 border border-green-500/20 rounded-lg p-4">
                           <div className="flex items-center justify-between">
                              <div>
                                 <p className="text-sm text-gray-300 mb-1">Connected to</p>
                                 <p className="text-lg font-mono text-white">{serverAddress}</p>
                              </div>
                              <div className="flex items-center text-green-400">
                                 <div className="w-2 h-2 bg-green-400 rounded-full mr-2 animate-pulse"></div>
                                 <span className="text-sm font-medium">Connected</span>
                              </div>
                           </div>
                        </div>

                        {/* Audio Controls */}
                        <div className="flex items-center justify-center space-x-4">
                           <motion.button
                              whileHover={{ scale: 1.05 }}
                              whileTap={{ scale: 0.95 }}
                              onClick={() => setIsMuted(!isMuted)}
                              className={`flex items-center px-6 py-3 rounded-xl font-medium transition-all duration-300 ${isMuted
                                    ? 'bg-red-500 hover:bg-red-600 text-white'
                                    : 'bg-gray-700 hover:bg-gray-600 text-white'
                                 }`}
                           >
                              {isMuted ? (
                                 <>
                                    <MicOff className="w-5 h-5 mr-2" />
                                    Unmute
                                 </>
                              ) : (
                                 <>
                                    <Mic className="w-5 h-5 mr-2" />
                                    Mute
                                 </>
                              )}
                           </motion.button>

                           <motion.button
                              whileHover={{ scale: 1.05 }}
                              whileTap={{ scale: 0.95 }}
                              onClick={handleDisconnect}
                              className="flex items-center px-6 py-3 bg-red-500 hover:bg-red-600 text-white rounded-xl font-medium transition-colors"
                           >
                              <WifiOff className="w-5 h-5 mr-2" />
                              Disconnect
                           </motion.button>
                        </div>
                     </div>
                  ) : (
                     <div className="text-center py-8">
                        <div className="w-12 h-12 border-4 border-cyan-500/30 border-t-cyan-500 rounded-full animate-spin mx-auto mb-4"></div>
                        <p className="text-gray-300">
                           {connectionState === 'connecting' ? 'Connecting to server...' : 
                            connectionState === 'pairing' ? 'Establishing secure connection...' : 
                            'Please wait...'}
                        </p>
                     </div>
                  )}
               </motion.div>

               {/* Status Cards */}
               <div className="grid grid-cols-3 gap-6">
                  {/* Connection Status */}
                  <motion.div
                     initial={{ y: 20, opacity: 0 }}
                     animate={{ y: 0, opacity: 1 }}
                     transition={{ duration: 0.5, delay: 0.1 }}
                     className="bg-gray-800/40 border border-gray-700/40 rounded-xl p-6"
                  >
                     <div className="flex items-center mb-4">
                        <div className={`w-10 h-10 rounded-lg flex items-center justify-center mr-3 ${
                           connectionState === 'connected' ? 'bg-green-500/20' : 'bg-red-500/20'
                        }`}>
                           {connectionState === 'connected' ? (
                              <Wifi className="w-5 h-5 text-green-400" />
                           ) : (
                              <WifiOff className="w-5 h-5 text-red-400" />
                           )}
                        </div>
                        <div>
                           <h3 className="text-sm font-medium text-gray-300">Connection</h3>
                        </div>
                     </div>
                     <div className="flex items-center">
                        <div className={`w-2 h-2 rounded-full mr-2 ${
                           connectionState === 'connected' ? 'bg-green-400' : 'bg-red-400'
                        }`}></div>
                        <span className={`text-sm font-medium ${
                           connectionState === 'connected' ? 'text-green-400' : 'text-red-400'
                        }`}>
                           {connectionState === 'connected' ? 'Connected' : 
                            connectionState === 'connecting' ? 'Connecting' :
                            connectionState === 'pairing' ? 'Pairing' :
                            'Disconnected'}
                        </span>
                     </div>
                  </motion.div>

                  {/* Audio Status */}
                  <motion.div
                     initial={{ y: 20, opacity: 0 }}
                     animate={{ y: 0, opacity: 1 }}
                     transition={{ duration: 0.5, delay: 0.2 }}
                     className="bg-gray-800/40 border border-gray-700/40 rounded-xl p-6"
                  >
                     <div className="flex items-center mb-4">
                        <div className={`w-10 h-10 rounded-lg flex items-center justify-center mr-3 ${
                           connectionState === 'connected' && !isMuted ? 'bg-cyan-500/20' : 'bg-gray-600/20'
                        }`}>
                           <Volume2 className={`w-5 h-5 ${
                              connectionState === 'connected' && !isMuted ? 'text-cyan-400' : 'text-gray-400'
                           }`} />
                        </div>
                        <div>
                           <h3 className="text-sm font-medium text-gray-300">Audio</h3>
                        </div>
                     </div>
                     <div className="flex items-center">
                        <div className={`w-2 h-2 rounded-full mr-2 ${
                           connectionState === 'connected' && !isMuted ? 'bg-cyan-400' : 'bg-gray-500'
                        }`}></div>
                        <span className={`text-sm font-medium ${
                           connectionState === 'connected' && !isMuted ? 'text-cyan-400' : 'text-gray-400'
                        }`}>
                           {connectionState === 'connected' ? (isMuted ? 'Muted' : 'Active') : 'Inactive'}
                        </span>
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
                        <div className={`w-10 h-10 rounded-lg flex items-center justify-center mr-3 ${
                           connectionState === 'connected' ? 'bg-purple-500/20' : 'bg-gray-600/20'
                        }`}>
                           <Shield className={`w-5 h-5 ${
                              connectionState === 'connected' ? 'text-purple-400' : 'text-gray-400'
                           }`} />
                        </div>
                        <div>
                           <h3 className="text-sm font-medium text-gray-300">Security</h3>
                        </div>
                     </div>
                     <div className="flex items-center">
                        <div className={`w-2 h-2 rounded-full mr-2 ${
                           connectionState === 'connected' ? 'bg-purple-400' : 'bg-gray-500'
                        }`}></div>
                        <span className={`text-sm font-medium ${
                           connectionState === 'connected' ? 'text-purple-400' : 'text-gray-400'
                        }`}>
                           {connectionState === 'connected' ? 'Encrypted' : 'Not Secure'}
                        </span>
                     </div>
                  </motion.div>
               </div>

               {/* Connection Log */}
               <motion.div
                  initial={{ y: 20, opacity: 0 }}
                  animate={{ y: 0, opacity: 1 }}
                  transition={{ duration: 0.5, delay: 0.4 }}
                  className="mt-8 bg-gray-800/30 border border-gray-700/30 rounded-xl p-6"
               >
                  <h3 className="text-lg font-semibold text-white mb-4">Connection Log</h3>
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
