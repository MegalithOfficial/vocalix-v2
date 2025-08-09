import { motion } from 'framer-motion';
import { useState, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { Wifi, CheckCircle, AlertCircle, Loader2, ArrowLeft, Twitch } from 'lucide-react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { logger } from '../utils/logger';

const ConnectingEventSub = () => {
  const navigate = useNavigate();
  const [currentStep, setCurrentStep] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [userInfo, setUserInfo] = useState<any>(null);

  const steps = [
    { id: 'connecting', label: 'Connecting to Twitch EventSub', icon: Wifi },
    { id: 'subscribing', label: 'Setting up event subscriptions', icon: Twitch },
    { id: 'ready', label: 'Ready to receive redemptions', icon: CheckCircle }
  ];

  const listenersRef = useRef<Array<Promise<() => void>>>([]);
  const abortingRef = useRef(false);

  useEffect(() => {
    let mounted = true;
    let unlistenStatus: Promise<() => void> | undefined;
    let unlistenError: Promise<() => void> | undefined;
    let unlistenEventSubConnected: Promise<() => void> | undefined;

    const handleError = async (errorMessage: string) => {
      console.error('EventSub error occurred, disconnecting...', errorMessage);
      logger.error('ConnectingEventSub', `Error occurred: ${errorMessage}, initiating disconnect...`);
      
      if (mounted) {
        setError(errorMessage);
      }

      try {
        await invoke('twitch_stop_event_listener');
        logger.info('ConnectingEventSub', 'EventSub listener stopped due to error');
        console.log('EventSub disconnected successfully after error');
      } catch (stopError) {
        console.error('Failed to stop EventSub listener:', stopError);
        logger.error('ConnectingEventSub', `Failed to stop EventSub listener: ${stopError}`);
      }

      try {
        if (unlistenStatus) unlistenStatus.then(f => f());
        if (unlistenError) unlistenError.then(f => f());
        if (unlistenEventSubConnected) unlistenEventSubConnected.then(f => f());
        logger.info('ConnectingEventSub', 'All event listeners cleaned up');
      } catch (cleanupError) {
        console.error('Failed to cleanup listeners:', cleanupError);
        logger.error('ConnectingEventSub', `Failed to cleanup listeners: ${cleanupError}`);
      }
    };

    const initializeEventSub = async () => {
      try {
        const user = await invoke('twitch_get_user_info');
        if (!mounted) return;
        setUserInfo(user);

        setCurrentStep(0);
        if (!mounted) return;

        await invoke('twitch_start_event_listener');
        if (!mounted) return;
        
        setCurrentStep(1);
        if (!mounted) return;
        
      } catch (error) {
        console.error('EventSub initialization failed:', error);
        await handleError(error as string);
      }
    };

    unlistenStatus = listen('STATUS_UPDATE', (event) => {
      logger.info('ConnectingEventSub', `Status update: ${event.payload}`);
      const payload = event.payload as string;
      
      if (abortingRef.current) return; // ignore after abort

      if (payload.includes('Connection state changed: Connected') || 
          payload.includes('WebSocket session established') ||
          payload.includes('EventSub connected') || 
          payload.includes('Subscriptions created')) {
        setCurrentStep(2); 
        setTimeout(() => {
          if (mounted) {
            navigate('/server');
          }
        }, 1500); 
      } else if (payload.includes('Connection state changed: Connecting')) {
        setCurrentStep(1); 
      }
    });

    unlistenError = listen('ERROR', async (event) => {
      const errorMessage = event.payload as string;
      console.log('ERROR event received:', errorMessage);
      logger.error('ConnectingEventSub', `ERROR event received: ${errorMessage}`);
      if (abortingRef.current) return;
      await handleError(errorMessage);
    });

    unlistenEventSubConnected = listen('EVENTSUB_CONNECTED', () => {
      logger.info('ConnectingEventSub', 'EventSub connection established');
      if (abortingRef.current) return;
      if (mounted) {
        setCurrentStep(2);
        setTimeout(() => {
          if (mounted) {
            navigate('/server');
          }
        }, 1500);
      }
    });

  initializeEventSub();

  // Track listeners for manual early cleanup
  listenersRef.current = [unlistenStatus, unlistenError, unlistenEventSubConnected].filter(Boolean) as Promise<() => void>[];

    return () => {
      mounted = false;
      listenersRef.current.forEach(p => p.then(f => f()).catch(() => {}));
      listenersRef.current = [];
    };
  }, [navigate]);

  const cleanupListenersEarly = () => {
    listenersRef.current.forEach(p => p.then(f => f()).catch(() => {}));
    listenersRef.current = [];
  };

  const handleGoBack = async () => {
    if (abortingRef.current) return; // prevent double
    abortingRef.current = true;
    setError(null);
    logger.info('ConnectingEventSub', 'User requested cancel/back; aborting EventSub setup');
    cleanupListenersEarly();
    try {
      await invoke('twitch_stop_event_listener');
      logger.info('ConnectingEventSub', 'EventSub listener stopped on user cancel');
    } catch (error) {
      console.error('Failed to stop event listener:', error);
      logger.error('ConnectingEventSub', `Failed stopping listener on cancel: ${error}`);
    }
    navigate('/');
  };

  const handleRetry = async () => {
    setError(null);
    setCurrentStep(0);
    try {
      await invoke('twitch_stop_event_listener');
    } catch (error) {
      console.error('Failed to stop event listener:', error);
    }
    window.location.reload();
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-gray-900 via-black to-gray-900 flex items-center justify-center p-8">
      <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        className="max-w-md w-full"
      >
        {/* Header */}
        <div className="text-center mb-8">
          <motion.div
            initial={{ scale: 0.8, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            transition={{ delay: 0.2 }}
            className="w-20 h-20 bg-gradient-to-br from-purple-500 to-cyan-400 rounded-2xl flex items-center justify-center mx-auto mb-4"
          >
            <Twitch className="w-10 h-10 text-white" />
          </motion.div>
          
          <h1 className="text-2xl font-bold text-white mb-2">Setting Up EventSub</h1>
          
          {userInfo && (
            <p className="text-gray-400 text-sm">
              Connecting as {userInfo.display_name || userInfo.login}
            </p>
          )}
        </div>

        {/* Error State */}
        {error && (
          <motion.div
            initial={{ opacity: 0, scale: 0.9 }}
            animate={{ opacity: 1, scale: 1 }}
            className="bg-red-900/50 border border-red-500/30 rounded-xl p-6 mb-6"
          >
            <div className="flex items-center mb-4">
              <AlertCircle className="w-6 h-6 text-red-400 mr-3" />
              <h3 className="text-lg font-semibold text-red-400">Connection Failed</h3>
            </div>
            <p className="text-red-300 text-sm mb-4">{error}</p>
            <div className="flex space-x-3">
              <button
                onClick={handleRetry}
                className="flex-1 bg-red-600 hover:bg-red-700 text-white px-4 py-2 rounded-lg transition-colors"
              >
                Retry
              </button>
              <button
                onClick={handleGoBack}
                className="flex-1 bg-gray-700 hover:bg-gray-600 text-white px-4 py-2 rounded-lg transition-colors"
              >
                Go Back
              </button>
            </div>
          </motion.div>
        )}

        {/* Progress Steps */}
        {!error && (
          <div className="space-y-4 mb-8">
            {steps.map((step, index) => {
              const isActive = index === currentStep;
              const isCompleted = index < currentStep;
              const StepIcon = step.icon;

              return (
                <motion.div
                  key={step.id}
                  initial={{ opacity: 0, x: -20 }}
                  animate={{ opacity: 1, x: 0 }}
                  transition={{ delay: index * 0.1 }}
                  className={`flex items-center p-4 rounded-xl border transition-all duration-500 ${
                    isActive
                      ? 'bg-purple-900/30 border-purple-500/50 shadow-lg shadow-purple-500/20'
                      : isCompleted
                      ? 'bg-green-900/30 border-green-500/50'
                      : 'bg-gray-800/30 border-gray-700/30'
                  }`}
                >
                  <div className={`w-10 h-10 rounded-lg flex items-center justify-center mr-4 transition-all duration-500 ${
                    isActive
                      ? 'bg-purple-500'
                      : isCompleted
                      ? 'bg-green-500'
                      : 'bg-gray-700'
                  }`}>
                    {isActive ? (
                      <Loader2 className="w-5 h-5 text-white animate-spin" />
                    ) : (
                      <StepIcon className={`w-5 h-5 ${isCompleted ? 'text-white' : 'text-gray-400'}`} />
                    )}
                  </div>
                  
                  <div className="flex-1">
                    <p className={`font-medium transition-colors duration-500 ${
                      isActive || isCompleted ? 'text-white' : 'text-gray-400'
                    }`}>
                      {step.label}
                    </p>
                  </div>

                  {isCompleted && (
                    <motion.div
                      initial={{ scale: 0 }}
                      animate={{ scale: 1 }}
                      className="w-6 h-6 bg-green-500 rounded-full flex items-center justify-center"
                    >
                      <CheckCircle className="w-4 h-4 text-white" />
                    </motion.div>
                  )}
                </motion.div>
              );
            })}
          </div>
        )}

        {/* Back Button */}
        {!error && currentStep < steps.length - 1 && (
          <motion.button
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ delay: 1 }}
            onClick={handleGoBack}
            className="flex items-center justify-center w-full mt-6 text-gray-400 hover:text-white transition-colors"
          >
            <ArrowLeft className="w-4 h-4 mr-2" />
            Cancel and go back
          </motion.button>
        )}
      </motion.div>
    </div>
  );
};

export default ConnectingEventSub;
