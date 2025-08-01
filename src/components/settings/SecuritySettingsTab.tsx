import { motion } from 'framer-motion';
import { useSettingsState } from '../../hooks/useSettingsState';

interface SecuritySettingsTabProps {
  settingsState: ReturnType<typeof useSettingsState>;
}

const SecuritySettingsTab = ({ settingsState }: SecuritySettingsTabProps) => {
  const {
    autoAccept,
    setAutoAccept,
    manualConfirm,
    setManualConfirm,
  } = settingsState;

  return (
    <motion.div
      initial={{ x: 20, opacity: 0 }}
      animate={{ x: 0, opacity: 1 }}
      transition={{ duration: 0.3 }}
      className="space-y-6"
    >
      <div>
        <h2 className="text-2xl font-bold text-white mb-2">Security & Privacy</h2>
        <p className="text-gray-400">Manage connection security and privacy settings</p>
      </div>

      <div className="bg-gray-800/50 border border-gray-700/50 rounded-2xl p-6">
        <div className="space-y-6">
          <div className="flex items-center justify-between">
            <div>
              <h3 className="text-lg font-medium text-white">Auto-accept connections</h3>
              <p className="text-gray-400 text-sm">Automatically accept incoming connections without manual approval</p>
            </div>
            <motion.button
              whileTap={{ scale: 0.95 }}
              onClick={() => setAutoAccept(!autoAccept)}
              className={`relative w-12 h-6 rounded-full transition-colors ${
                autoAccept ? 'bg-purple-600' : 'bg-gray-600'
              }`}
            >
              <motion.div
                animate={{ x: autoAccept ? 24 : 0 }}
                transition={{ type: "spring", stiffness: 500, damping: 30 }}
                className="absolute top-0.5 left-0.5 w-5 h-5 bg-white rounded-full"
              />
            </motion.button>
          </div>

          <div className="flex items-center justify-between">
            <div>
              <h3 className="text-lg font-medium text-white">Manual confirmation required</h3>
              <p className="text-gray-400 text-sm">Require manual confirmation for sensitive operations</p>
            </div>
            <motion.button
              whileTap={{ scale: 0.95 }}
              onClick={() => setManualConfirm(!manualConfirm)}
              className={`relative w-12 h-6 rounded-full transition-colors ${
                manualConfirm ? 'bg-purple-600' : 'bg-gray-600'
              }`}
            >
              <motion.div
                animate={{ x: manualConfirm ? 24 : 0 }}
                transition={{ type: "spring", stiffness: 500, damping: 30 }}
                className="absolute top-0.5 left-0.5 w-5 h-5 bg-white rounded-full"
              />
            </motion.button>
          </div>
        </div>
      </div>
    </motion.div>
  );
};

export default SecuritySettingsTab;
