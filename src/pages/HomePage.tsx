import { motion } from 'framer-motion';
import { Link } from 'react-router-dom';
import { Server, Monitor, Settings, AudioWaveform } from 'lucide-react';

const HomePage = () => {
  const containerVariants = {
    hidden: { opacity: 0 },
    visible: {
      opacity: 1,
      transition: {
        delayChildren: 0.1,
        staggerChildren: 0.05
      }
    }
  };

  const itemVariants = {
    hidden: { y: 20, opacity: 0 },
    visible: {
      y: 0,
      opacity: 1,
      transition: {
        type: "spring" as const,
        damping: 20,
        stiffness: 300
      }
    }
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-gray-900 via-black to-gray-900 flex overflow-y-auto overflow-x-hidden">
      {/* Left Panel - Branding */}
      <motion.div
        initial={{ x: -50, opacity: 0 }}
        animate={{ x: 0, opacity: 1 }}
        transition={{ duration: 0.6, ease: "easeOut" }}
        className="w-2/5 flex flex-col justify-center items-start pl-16 pr-8"
      >
        <div className="mb-8">
          <motion.div
            initial={{ scale: 0.8, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            transition={{ delay: 0.2, duration: 0.5 }}
            className="flex items-center mb-6"
          >
            <div className="w-16 h-16 bg-gradient-to-br from-purple-500 to-cyan-400 rounded-2xl flex items-center justify-center mr-4">
              <AudioWaveform className="w-8 h-8 text-white" />
            </div>
            <div>
              <h1 className="text-4xl font-bold text-white mb-1">Vocalix</h1>
              <p className="text-gray-400 text-sm">Secure Communications</p>
            </div>
          </motion.div>
          
          <motion.p
            variants={itemVariants}
            className="text-gray-300 text-lg leading-relaxed max-w-md"
          >
            Professional end-to-end encrypted audio communication platform with advanced security protocols.
          </motion.p>
        </div>

        <motion.div
          variants={itemVariants}
          className="flex items-center text-gray-500 text-sm"
        >
          <div className="w-2 h-2 bg-green-400 rounded-full mr-2"></div>
          <span>Ready to connect</span>
        </motion.div>
      </motion.div>

      {/* Right Panel - Actions */}
      <motion.div
        initial={{ x: 50, opacity: 0 }}
        animate={{ x: 0, opacity: 1 }}
        transition={{ duration: 0.6, ease: "easeOut", delay: 0.1 }}
        className="w-3/5 flex flex-col justify-center pr-16 pl-8"
      >
        <motion.div
          variants={containerVariants}
          initial="hidden"
          animate="visible"
          className="space-y-6"
        >
          {/* Server Option */}
          <motion.div variants={itemVariants}>
            <Link to="/server">
              <motion.div
                whileHover={{ scale: 1.02, x: 5 }}
                whileTap={{ scale: 0.98 }}
                className="group bg-gray-800/50 border border-gray-700/50 rounded-2xl p-6 cursor-pointer transition-all duration-300 hover:bg-gray-800/70 hover:border-purple-500/30"
              >
                <div className="flex items-center">
                  <div className="w-14 h-14 bg-gradient-to-br from-purple-500 to-purple-600 rounded-xl flex items-center justify-center mr-6 group-hover:scale-110 transition-transform duration-300">
                    <Server className="w-7 h-7 text-white" />
                  </div>
                  <div className="flex-1">
                    <h3 className="text-xl font-semibold text-white mb-1">Host Server</h3>
                    <p className="text-gray-400 text-sm">Start a secure server and accept client connections</p>
                  </div>
                  <div className="text-purple-400 opacity-0 group-hover:opacity-100 transition-opacity">
                    <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                    </svg>
                  </div>
                </div>
              </motion.div>
            </Link>
          </motion.div>

          {/* Client Option */}
          <motion.div variants={itemVariants}>
            <Link to="/client">
              <motion.div
                whileHover={{ scale: 1.02, x: 5 }}
                whileTap={{ scale: 0.98 }}
                className="group bg-gray-800/50 border border-gray-700/50 rounded-2xl p-6 cursor-pointer transition-all duration-300 hover:bg-gray-800/70 hover:border-cyan-500/30"
              >
                <div className="flex items-center">
                  <div className="w-14 h-14 bg-gradient-to-br from-cyan-400 to-cyan-500 rounded-xl flex items-center justify-center mr-6 group-hover:scale-110 transition-transform duration-300">
                    <Monitor className="w-7 h-7 text-white" />
                  </div>
                  <div className="flex-1">
                    <h3 className="text-xl font-semibold text-white mb-1">Join as Client</h3>
                    <p className="text-gray-400 text-sm">Connect to an existing server for secure communication</p>
                  </div>
                  <div className="text-cyan-400 opacity-0 group-hover:opacity-100 transition-opacity">
                    <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                    </svg>
                  </div>
                </div>
              </motion.div>
            </Link>
          </motion.div>

          {/* Settings Option */}
          <motion.div variants={itemVariants}>
            <Link to="/settings">
              <motion.div
                whileHover={{ scale: 1.02, x: 5 }}
                whileTap={{ scale: 0.98 }}
                className="group bg-gray-800/30 border border-gray-700/30 rounded-2xl p-4 cursor-pointer transition-all duration-300 hover:bg-gray-800/50 hover:border-gray-600/50"
              >
                <div className="flex items-center">
                  <div className="w-10 h-10 bg-gray-700 rounded-lg flex items-center justify-center mr-4 group-hover:bg-gray-600 transition-colors">
                    <Settings className="w-5 h-5 text-gray-300" />
                  </div>
                  <div className="flex-1">
                    <h3 className="text-base font-medium text-white">Settings</h3>
                    <p className="text-gray-500 text-xs">Configure audio and security preferences</p>
                  </div>
                  <div className="text-gray-500 opacity-0 group-hover:opacity-100 transition-opacity">
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                    </svg>
                  </div>
                </div>
              </motion.div>
            </Link>
          </motion.div>
        </motion.div>

        {/* Footer Info */}
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ delay: 0.8 }}
          className="mt-12 pt-6 border-t border-gray-800"
        >
          <p className="text-gray-600 text-xs">
            Built with Tauri • React • Rust • End-to-End Encrypted
          </p>
        </motion.div>
      </motion.div>
    </div>
  );
};

export default HomePage;
