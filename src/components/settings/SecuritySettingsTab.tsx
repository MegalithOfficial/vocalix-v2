import { motion } from 'framer-motion';
import { useState, useEffect } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { CheckCircle } from 'lucide-react';
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
    p2pPort,
    setP2pPort,
    onlyClientMode,
    setOnlyClientMode,
    saveSecuritySettings,
    loadSecuritySettings,
  } = settingsState;

  const [showClientModeModal, setShowClientModeModal] = useState(false);
  const [pendingClientModeValue, setPendingClientModeValue] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [lastSaved, setLastSaved] = useState<Date | null>(null);

  useEffect(() => {
    loadSecuritySettings();
  }, [loadSecuritySettings]);

  useEffect(() => {
    const saveCurrentSettings = async () => {
      if (lastSaved === null) {
        setLastSaved(new Date());
        return;
      }

      try {
        setIsSaving(true);
        await saveSecuritySettings();
        setLastSaved(new Date());
        console.log('Security settings auto-saved');
      } catch (error) {
        console.error('Error auto-saving security settings:', error);
      } finally {
        setIsSaving(false);
      }
    };

    const timeoutId = setTimeout(saveCurrentSettings, 1000);
    return () => clearTimeout(timeoutId);
  }, [p2pPort, autoAccept, manualConfirm, saveSecuritySettings]);

  const handlePortChange = async (value: number) => {
    setP2pPort(value);
  };

  const handleResetPort = () => {
    setP2pPort(12345);
  };

  const handleAutoAcceptChange = async (value: boolean) => {
    setAutoAccept(value);
  };

  const handleManualConfirmChange = async (value: boolean) => {
    setManualConfirm(value);
  };

  const handleClientModeToggle = () => {
    const newValue = !onlyClientMode;
    setPendingClientModeValue(newValue);
    setShowClientModeModal(true);
  };

  const confirmClientModeChange = async () => {
    try {
      setOnlyClientMode(pendingClientModeValue);

      await saveSecuritySettings();

      setShowClientModeModal(false);

      setTimeout(async () => {
        await invoke('restart_app');
      }, 3000);
    } catch (error) {
      console.error('Error saving security settings:', error);
      alert('Failed to save settings. Please try again.');
    }
  };


  return (
    <motion.div
      initial={{ x: 20, opacity: 0 }}
      animate={{ x: 0, opacity: 1 }}
      transition={{ duration: 0.3 }}
      className="space-y-6"
    >
      {/* Header */}
      <div>
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-2xl font-bold text-white mb-1">Security & Privacy</h2>
            <p className="text-gray-400">Configure connection security and privacy settings</p>
          </div>
          {/* Save indicator */}
          {isSaving && (
            <div className="flex items-center space-x-2 text-sm">
              <div className="w-2 h-2 bg-blue-400 rounded-full animate-pulse" />
              <span className="text-blue-400">Saving...</span>
            </div>
          )}
          {lastSaved && !isSaving && (
            <div className="flex items-center space-x-2 text-sm">
              <CheckCircle className="w-4 h-4 text-green-400" />
              <span className="text-green-400">Saved</span>
            </div>
          )}
        </div>
      </div>

      <div className="bg-gray-800/50 border border-gray-700/50 rounded-2xl p-6">
        <div className="space-y-6">
          {/* P2P Port Configuration */}
          {!onlyClientMode && (
            <div>
              <label className="block text-sm font-medium text-gray-300 mb-2">P2P Network Port</label>
              <div className="flex items-center gap-3">
                <input
                  type="number"
                  min="1024"
                  max="65535"
                  value={p2pPort}
                  onChange={(e) => handlePortChange(parseInt(e.target.value) || 12345)}
                  className="w-48 h-10 px-4 bg-gray-700/50 border border-gray-600 rounded-lg text-white focus:outline-none focus:border-purple-500"
                  placeholder="12345"
                />
                <button
                  type="button"
                  onClick={handleResetPort}
                  className="text-xs text-gray-400 hover:text-gray-200 underline"
                  aria-label="Reset to default port"
                >
                  Reset
                </button>
                <div className="flex-1">
                  <p className="text-gray-400 text-sm">Valid range: 1024-65535</p>
                </div>
              </div>
            </div>
          )}

          {/* Client-Only Mode */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <div>
                <label className="block text-sm font-medium text-gray-300">Client-Only Mode</label>
                <p className="text-gray-500 text-xs">Only connect as client, never accept incoming connections</p>
              </div>
              <motion.button
                whileTap={{ scale: 0.95 }}
                onClick={handleClientModeToggle}
                className={`relative w-12 h-6 rounded-full transition-colors ${onlyClientMode ? 'bg-purple-600' : 'bg-gray-600'
                  }`}
              >
                <motion.div
                  animate={{ x: onlyClientMode ? 24 : 2 }}
                  transition={{ type: 'spring', stiffness: 500, damping: 30 }}
                  className="absolute top-0.5 w-5 h-5 bg-white rounded-full"
                />
              </motion.button>
            </div>

            {onlyClientMode && (
              <div className="inline-flex items-center px-2 py-1 bg-purple-500/10 border border-purple-500/20 rounded-full">
                <span className="text-purple-300 text-xs">App restart required to apply client-only mode</span>
              </div>
            )}
          </div>

          {/* Divider keeps rhythm even if section below is hidden */}
          <div className="border-t border-gray-700/50" />

          {/* Connection Security (hidden in client-only mode) */}
          {!onlyClientMode && (
            <div>
              <label className="block text-sm font-medium text-gray-300 mb-3">Connection Security</label>
              <div className="space-y-4">
                {/* Auto-accept connections */}
                <div className="flex items-center justify-between">
                  <div>
                    <h4 className="text-sm font-medium text-white">Auto-Accept Connections</h4>
                    <p className="text-gray-500 text-xs">Automatically approve incoming connection requests</p>
                  </div>
                  <motion.button
                    whileTap={{ scale: 0.95 }}
                    onClick={() => handleAutoAcceptChange(!autoAccept)}
                    className={`relative w-12 h-6 rounded-full transition-colors ${autoAccept ? 'bg-green-600' : 'bg-gray-600'
                      }`}
                  >
                    <motion.div
                      animate={{ x: autoAccept ? 24 : 2 }}
                      transition={{ type: 'spring', stiffness: 500, damping: 30 }}
                      className="absolute top-0.5 w-5 h-5 bg-white rounded-full"
                    />
                  </motion.button>
                </div>

                {/* Manual confirmation required */}
                <div className="flex items-center justify-between">
                  <div>
                    <h4 className="text-sm font-medium text-white">Manual Confirmation Required</h4>
                    <p className="text-gray-500 text-xs">Require manual approval for sensitive operations</p>
                  </div>
                  <motion.button
                    whileTap={{ scale: 0.95 }}
                    onClick={() => handleManualConfirmChange(!manualConfirm)}
                    className={`relative w-12 h-6 rounded-full transition-colors ${manualConfirm ? 'bg-orange-600' : 'bg-gray-600'
                      }`}
                  >
                    <motion.div
                      animate={{ x: manualConfirm ? 24 : 2 }}
                      transition={{ type: 'spring', stiffness: 500, damping: 30 }}
                      className="absolute top-0.5 w-5 h-5 bg-white rounded-full"
                    />
                  </motion.button>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Only Client Mode Confirmation Modal */}
      {showClientModeModal && (
        <div
          className="fixed inset-0 z-50"
          role="dialog"
          aria-modal="true"
          aria-labelledby="client-only-title"
          onKeyDown={(e) => {
            if (e.key === 'Escape') setShowClientModeModal(false);
          }}
        >
          {/* Overlay */}
          <div
            className="absolute inset-0 bg-black/70 backdrop-blur-sm"
            onClick={() => setShowClientModeModal(false)}
          />

          {/* Dialog */}
          <div className="absolute inset-0 flex items-center justify-center p-4">
            <motion.div
              initial={{ opacity: 0, y: 16, scale: 0.98 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: -16, scale: 0.98 }}
              transition={{ duration: 0.2, ease: 'easeOut' }}
              className="w-full max-w-lg rounded-2xl border border-gray-700 bg-gradient-to-b from-gray-800 to-gray-900 shadow-2xl"
            >
              {/* Header */}
              <div className="px-6 pt-6 pb-4">
                <div className="flex items-start justify-between">
                  <div>
                    <h3 id="client-only-title" className="text-xl font-semibold text-white">
                      {pendingClientModeValue ? 'Enable' : 'Disable'} Client-Only Mode
                    </h3>
                    <p className="mt-1 text-sm text-gray-400">
                      This changes how your app participates in P2P connections.
                    </p>
                  </div>
                  <button
                    onClick={() => setShowClientModeModal(false)}
                    className="ml-4 rounded-lg p-2 text-gray-400 hover:text-white hover:bg-gray-700/60 transition-colors"
                    aria-label="Close modal"
                  >
                    ✕
                  </button>
                </div>
              </div>

              {/* Body */}
              <div className="px-6 pb-6 space-y-4">
                {/* Summary card */}
                <div className="rounded-xl border border-gray-700 bg-gray-800/60 p-4">
                  <h4 className="text-sm font-medium text-white mb-2">What this will do</h4>
                  <ul className="text-sm text-gray-300 space-y-2 list-disc list-inside">
                    {pendingClientModeValue ? (
                      <>
                        <li>Only initiate outbound connections as a client.</li>
                        <li>Do not listen for or accept incoming connections.</li>
                        <li>Hide server-related features and settings in the UI.</li>
                      </>
                    ) : (
                      <>
                        <li>Allow accepting incoming connections as a server.</li>
                        <li>Show server-related features and connection controls.</li>
                        <li>Maintain current client capabilities.</li>
                      </>
                    )}
                  </ul>
                </div>

                {/* Impact warning */}
                <div className="rounded-xl border border-yellow-600/30 bg-yellow-500/10 p-4">
                  <div className="flex items-start gap-3">
                    <div className="mt-0.5 text-yellow-300">⚠️</div>
                    <div className="text-sm text-yellow-200">
                      <p className="font-medium">Restart required</p>
                      <p className="mt-1">The application will restart to apply this change.</p>
                    </div>
                  </div>
                </div>

                {/* Comparison panel */}
                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                  <div className={`rounded-xl border p-3 ${pendingClientModeValue ? 'border-purple-600/40 bg-purple-600/10' : 'border-gray-700 bg-gray-800/50'}`}>
                    <div className="text-xs font-semibold uppercase tracking-wide text-purple-300">Client-Only</div>
                    <ul className="mt-2 text-xs text-gray-300 space-y-1 list-disc list-inside">
                      <li>Outbound connections only</li>
                      <li>Hidden server UI</li>
                      <li>More private</li>
                    </ul>
                  </div>
                  <div className={`rounded-xl border p-3 ${!pendingClientModeValue ? 'border-green-600/40 bg-green-600/10' : 'border-gray-700 bg-gray-800/50'}`}>
                    <div className="text-xs font-semibold uppercase tracking-wide text-green-300">Client + Server</div>
                    <ul className="mt-2 text-xs text-gray-300 space-y-1 list-disc list-inside">
                      <li>Accept incoming connections</li>
                      <li>Server controls visible</li>
                      <li>More flexible</li>
                    </ul>
                  </div>
                </div>
              </div>

              {/* Footer actions */}
              <div className="px-6 py-4 border-t border-gray-700 bg-gray-900/40 rounded-b-2xl">
                <div className="flex flex-col-reverse sm:flex-row sm:items-center sm:justify-end gap-3">
                  <button
                    onClick={() => setShowClientModeModal(false)}
                    className="px-4 py-2 rounded-lg text-gray-300 hover:text-white border border-gray-700 hover:border-gray-600 bg-gray-800/60 transition-colors"
                  >
                    Cancel
                  </button>
                  <button
                    onClick={confirmClientModeChange}
                    className={`px-4 py-2 rounded-lg text-white transition-colors shadow-lg ${pendingClientModeValue
                        ? 'bg-purple-600 hover:bg-purple-700 shadow-purple-600/25'
                        : 'bg-green-600 hover:bg-green-700 shadow-green-600/25'
                      }`}
                  >
                    {pendingClientModeValue ? 'Enable & Restart' : 'Disable & Restart'}
                  </button>
                </div>
              </div>
            </motion.div>
          </div>
        </div>
      )}
    </motion.div>
  );
};

export default SecuritySettingsTab;
