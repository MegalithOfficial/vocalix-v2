import { motion } from 'framer-motion';
import { useState } from 'react';
import { ArrowLeft, Play, Square, Users, Shield, Network, Copy, Check } from 'lucide-react';
import { Link, useNavigate } from 'react-router-dom';
import TwitchIntegration from '../components/TwitchIntegration';

const ServerPage = () => {
  const navigate = useNavigate();
  const [isServerRunning, setIsServerRunning] = useState(false);
  const [serverIP, setServerIP] = useState('192.168.1.100');
  const [serverPort, setServerPort] = useState('8080');
  const [connectedClients, setConnectedClients] = useState(0);
  const [copied, setCopied] = useState(false);

  // Handler for when the TwitchIntegration component triggers host as server
  const handleTwitchHostServer = () => {
    navigate('/connecting-eventsub');
  };

  const handleStartServer = () => {
    if (isServerRunning) {
      setIsServerRunning(false);
      setConnectedClients(0);
    } else {
      setIsServerRunning(true);
    }
  };

  const copyConnectionInfo = () => {
    navigator.clipboard.writeText(`${serverIP}:${serverPort}`);
    
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
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
          {/* Server Control Panel */}
          <motion.div
            initial={{ y: 20, opacity: 0 }}
            animate={{ y: 0, opacity: 1 }}
            transition={{ duration: 0.5 }}
            className="bg-gray-800/50 border border-gray-700/50 rounded-2xl p-8 mb-8"
          >
            <div className="flex items-center justify-between mb-8">
              <div>
                <h2 className="text-2xl font-bold text-white mb-2">Server Controls</h2>
                <p className="text-gray-400">Manage your audio communication server</p>
              </div>
              
              <motion.button
                whileHover={{ scale: 1.05 }}
                whileTap={{ scale: 0.95 }}
                onClick={handleStartServer}
                className={`flex items-center px-8 py-4 rounded-xl font-semibold transition-all duration-300 ${
                  isServerRunning
                    ? 'bg-red-500 hover:bg-red-600 text-white'
                    : 'bg-gradient-to-r from-purple-500 to-purple-600 hover:from-purple-600 hover:to-purple-700 text-white'
                }`}
              >
                {isServerRunning ? (
                  <>
                    <Square className="w-5 h-5 mr-2" />
                    Stop Server
                  </>
                ) : (
                  <>
                    <Play className="w-5 h-5 mr-2" />
                    Start Server
                  </>
                )}
              </motion.button>
            </div>

            {/* Server Configuration */}
            <div className="grid grid-cols-2 gap-6 mb-8">
              <div>
                <label className="block text-sm font-medium text-gray-300 mb-2">Server IP</label>
                <input
                  type="text"
                  value={serverIP}
                  onChange={(e) => setServerIP(e.target.value)}
                  disabled={isServerRunning}
                  className="w-full px-4 py-3 bg-gray-700/50 border border-gray-600 rounded-lg text-white placeholder-gray-400 focus:outline-none focus:border-purple-500 disabled:opacity-50 disabled:cursor-not-allowed"
                />
              </div>
              
              <div>
                <label className="block text-sm font-medium text-gray-300 mb-2">Port</label>
                <input
                  type="text"
                  value={serverPort}
                  onChange={(e) => setServerPort(e.target.value)}
                  disabled={isServerRunning}
                  className="w-full px-4 py-3 bg-gray-700/50 border border-gray-600 rounded-lg text-white placeholder-gray-400 focus:outline-none focus:border-purple-500 disabled:opacity-50 disabled:cursor-not-allowed"
                />
              </div>
            </div>

            {/* Connection Info */}
            {isServerRunning && (
              <motion.div
                initial={{ opacity: 0, height: 0 }}
                animate={{ opacity: 1, height: 'auto' }}
                className="bg-gray-700/30 border border-gray-600/30 rounded-lg p-4"
              >
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-sm text-gray-300 mb-1">Connection Address</p>
                    <p className="text-lg font-mono text-white">{serverIP}:{serverPort}</p>
                  </div>
                  <motion.button
                    whileHover={{ scale: 1.05 }}
                    whileTap={{ scale: 0.95 }}
                    onClick={copyConnectionInfo}
                    className="flex items-center px-4 py-2 bg-cyan-500 hover:bg-cyan-600 text-white rounded-lg transition-colors"
                  >
                    {copied ? (
                      <>
                        <Check className="w-4 h-4 mr-2" />
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
              </motion.div>
            )}
          </motion.div>

          {/* Status Cards */}
          <div className="grid grid-cols-3 gap-6">
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

          {/* Twitch Integration Panel */}
          <motion.div
            initial={{ y: 20, opacity: 0 }}
            animate={{ y: 0, opacity: 1 }}
            transition={{ duration: 0.5, delay: 0.4 }}
            className="mt-8 bg-gray-800/50 border border-gray-700/50 rounded-2xl p-8"
          >
            <TwitchIntegration onHostAsServer={handleTwitchHostServer} />
          </motion.div>

          {/* Server Logs */}
          <motion.div
            initial={{ y: 20, opacity: 0 }}
            animate={{ y: 0, opacity: 1 }}
            transition={{ duration: 0.5, delay: 0.5 }}
            className="mt-8 bg-gray-800/30 border border-gray-700/30 rounded-xl p-6"
          >
            <h3 className="text-lg font-semibold text-white mb-4">Server Logs</h3>
            <div className="bg-black/40 rounded-lg p-4 font-mono text-sm text-gray-300 h-48 overflow-y-auto">
              {isServerRunning ? (
                <div className="space-y-1">
                  <div className="text-green-400">[INFO] Server started on {serverIP}:{serverPort}</div>
                  <div className="text-cyan-400">[INFO] Encryption enabled</div>
                  <div className="text-gray-300">[INFO] Waiting for client connections...</div>
                </div>
              ) : (
                <div className="text-gray-500 italic">Server is offline. Start the server to see logs.</div>
              )}
            </div>
          </motion.div>
        </div>
      </div>
    </div>
  );
};

export default ServerPage;
