import { motion } from 'framer-motion';
import { Play, Pause } from 'lucide-react';
import { useRef, useEffect } from 'react';
import { AudioQuality, getAudioQualitySettings, getAudioSettingsForBackend } from '../../utils/audioSettings';
import '../../components/VolumeSlider.css';
import { useSettingsState } from '../../hooks/useSettingsState';
import { logger } from '../../utils/logger';

interface AudioSettingsTabProps {
  settingsState: ReturnType<typeof useSettingsState>;
}

const AudioSettingsTab = ({ settingsState }: AudioSettingsTabProps) => {
  const {
    audioQuality,
    setAudioQuality,
    outputDevices,
    selectedOutputDevice,
    setSelectedOutputDevice,
    volume,
    setVolume,
    isTestPlaying,
    setIsTestPlaying,
    saveAudioSettings,
  } = settingsState;

  const audioRef = useRef<HTMLAudioElement | null>(null);
  const isInitialMount = useRef(true);

  useEffect(() => {
    if (isInitialMount.current) {
      isInitialMount.current = false;
      return;
    }

    const timeoutId = setTimeout(() => {
      console.log('Auto-saving audio settings...');
      saveAudioSettings();
    }, 500); 

    return () => clearTimeout(timeoutId);
  }, [audioQuality, selectedOutputDevice, volume, saveAudioSettings]);

  const handleVolumeChange = (newVolume: number) => {
    setVolume(newVolume);
    if (audioRef.current) {
      audioRef.current.volume = newVolume / 100;
    }

    logger.info('AudioSettings', `Audio Settings: ${JSON.stringify(getAudioSettingsForBackend(audioQuality, newVolume))}`);
  };

  const testAudio = () => {
    if (isTestPlaying) {
      if (audioRef.current) {
        audioRef.current.pause();
        audioRef.current.currentTime = 0;
      }
      setIsTestPlaying(false);
      return;
    }

    const qualitySettings = getAudioQualitySettings(audioQuality);

    const audio = new Audio();
    audioRef.current = audio;

    audio.volume = volume / 100;
    if ('setSinkId' in audio && selectedOutputDevice !== 'default') {
      (audio as any).setSinkId(selectedOutputDevice).catch((error: any) => {
        console.error('Error setting audio output device:', error);
      });
    }

    audio.src = `/test-audio.mp3?quality=${audioQuality}&t=${Date.now()}`;

    const playPromise = audio.play();

    if (playPromise !== undefined) {
      playPromise.then(() => {
        setIsTestPlaying(true);
        audio.onended = () => {
          setIsTestPlaying(false);
        };
      }).catch((error) => {
        logger.warn('AudioSettings', `MP3 playback failed, using tone fallback: ${error}`);
        createTestTone(qualitySettings.frequency, qualitySettings.sampleRate);
      });
    } else {
      createTestTone(qualitySettings.frequency, qualitySettings.sampleRate);
    }
  };

  const createTestTone = (frequency: number = 440, sampleRate: number = 48000) => {
    try {
      const audioContext = new (window.AudioContext || (window as any).webkitAudioContext)({
        sampleRate: sampleRate
      });
      const oscillator = audioContext.createOscillator();
      const gainNode = audioContext.createGain();

      oscillator.connect(gainNode);
      gainNode.connect(audioContext.destination);

      oscillator.frequency.setValueAtTime(frequency, audioContext.currentTime);
      gainNode.gain.setValueAtTime((volume / 100) * 0.3, audioContext.currentTime);

      if (audioQuality === 'high') {
        const harmonic = audioContext.createOscillator();
        const harmonicGain = audioContext.createGain();
        harmonic.connect(harmonicGain);
        harmonicGain.connect(audioContext.destination);
        harmonic.frequency.setValueAtTime(frequency * 2, audioContext.currentTime);
        harmonicGain.gain.setValueAtTime((volume / 100) * 0.1, audioContext.currentTime);
        harmonic.start();
        setTimeout(() => harmonic.stop(), 1000);
      }

      setIsTestPlaying(true);
      oscillator.start();

      setTimeout(() => {
        oscillator.stop();
        setIsTestPlaying(false);
      }, 1000);
    } catch (error) {
      console.error('Error creating test tone:', error);
      setIsTestPlaying(false);
    }
  };

  const handleAudioQualityChange = (quality: AudioQuality) => {
    setAudioQuality(quality);
  };

  const handleOutputDeviceChange = async (deviceId: string) => {
    setSelectedOutputDevice(deviceId);

    if (audioRef.current && 'setSinkId' in audioRef.current) {
      try {
        await (audioRef.current as any).setSinkId(deviceId);
      } catch (error) {
        console.error('Error setting audio output device:', error);
      }
    }
  };

  return (
    <motion.div
      initial={{ x: 20, opacity: 0 }}
      animate={{ x: 0, opacity: 1 }}
      transition={{ duration: 0.3 }}
      className="space-y-6"
    >
      <div>
        <h2 className="text-2xl font-bold text-white mb-2">Audio Settings</h2>
        <p className="text-gray-400">Configure audio quality and output devices</p>
      </div>

      <div className="bg-gray-800/50 border border-gray-700/50 rounded-2xl p-6">
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
          <div className="space-y-6">
            <div>
              <label className="block text-sm font-medium text-gray-300 mb-2">Audio Quality</label>
              <select
                value={audioQuality}
                onChange={(e) => handleAudioQualityChange(e.target.value as AudioQuality)}
                className="w-full px-4 py-3 bg-gray-700/50 border border-gray-600 rounded-lg text-white focus:outline-none focus:border-purple-500"
              >
                <option value="ultra">Ultra (48kHz, 320kbps)</option>
                <option value="high">High (44kHz, 256kbps)</option>
                <option value="medium">Medium (22kHz, 192kbps)</option>
                <option value="low">Low (16kHz, 128kbps)</option>
              </select>
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-300 mb-2">Output Device</label>
                <select
                value={selectedOutputDevice}
                onChange={(e) => handleOutputDeviceChange(e.target.value)}
                className="w-full px-4 py-3 bg-gray-700 border border-gray-600 rounded-lg text-white focus:outline-none focus:border-purple-500"
                style={{ backgroundColor: '#374151' }} 
                >
                <option value="default">Default Output Device</option>
                {outputDevices.map((device) => (
                  <option key={device.deviceId} value={device.deviceId}>
                    {device.label || `Device ${device.deviceId.slice(0, 8)}...`}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div className="space-y-6">
            <div>
              <label className="block text-sm font-medium text-gray-300 mb-2">
                Volume: {volume}%
              </label>
              <div className="volume-slider-container">
                <input
                  type="range"
                  min="0"
                  max="100"
                  value={volume}
                  onChange={(e) => handleVolumeChange(parseInt(e.target.value))}
                  className="volume-slider w-full"
                  style={{
                    background: `linear-gradient(to right, #8b5cf6 0%, #8b5cf6 ${volume}%, #374151 ${volume}%, #374151 100%)`
                  }}
                />
              </div>
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-300 mb-2">Test Audio</label>
              <motion.button
                whileHover={{ scale: 1.02 }}
                whileTap={{ scale: 0.98 }}
                onClick={testAudio}
                className="flex items-center px-4 py-2 bg-purple-600 hover:bg-purple-700 text-white rounded-lg transition-colors"
              >
                {isTestPlaying ? (
                  <>
                    <Pause className="w-4 h-4 mr-2" />
                    Stop Test
                  </>
                ) : (
                  <>
                    <Play className="w-4 h-4 mr-2" />
                    Test Audio
                  </>
                )}
              </motion.button>
            </div>
          </div>
        </div>
      </div>

      {/* Audio element for testing */}
      <audio ref={audioRef} style={{ display: 'none' }} />
    </motion.div>
  );
};

export default AudioSettingsTab;
