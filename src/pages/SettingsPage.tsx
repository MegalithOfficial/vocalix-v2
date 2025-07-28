import { motion } from 'framer-motion';
import { useState, useEffect, useRef } from 'react';
import { ArrowLeft, Volume2, Shield, Database, Palette, Play, Pause } from 'lucide-react';
import { Link } from 'react-router-dom';
import '../components/VolumeSlider.css';
import { AudioQuality, getAudioQualitySettings, getAudioSettingsForBackend } from '../utils/audioSettings';
import { TwitchIntegration } from '../components/TwitchIntegration';

const SettingsPage = () => {
   const [audioQuality, setAudioQuality] = useState<AudioQuality>('high');
   const [autoAccept, setAutoAccept] = useState(false);
   const [manualConfirm, setManualConfirm] = useState(true);
   const [theme, setTheme] = useState('dark');
   const [outputDevices, setOutputDevices] = useState<MediaDeviceInfo[]>([]);
   const [selectedOutputDevice, setSelectedOutputDevice] = useState('default');
   const [volume, setVolume] = useState(50);
   const [isTestPlaying, setIsTestPlaying] = useState(false);
   const audioRef = useRef<HTMLAudioElement | null>(null);

   useEffect(() => {
      const loadAudioDevices = async () => {
         try {
            await navigator.mediaDevices.getUserMedia({ audio: true }).then(stream => {
               stream.getTracks().forEach(track => track.stop());
            });

            const devices = await navigator.mediaDevices.enumerateDevices();
            const audioOutputs = devices.filter(device => device.kind === 'audiooutput');
            setOutputDevices(audioOutputs);
         } catch (error) {
            console.error('Error loading audio devices:', error);
            const devices = await navigator.mediaDevices.enumerateDevices();
            const audioOutputs = devices.filter(device => device.kind === 'audiooutput');
            setOutputDevices(audioOutputs);
         }
      };

      loadAudioDevices();
   }, []);

   const handleVolumeChange = (newVolume: number) => {
      setVolume(newVolume);
      if (audioRef.current) {
         audioRef.current.volume = newVolume / 100;
      }

      console.log('Audio Settings:', getAudioSettingsForBackend(audioQuality, newVolume));
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
            console.log('MP3 playback failed, using tone fallback:', error);
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
                  <h1 className="text-xl font-semibold text-white">Settings</h1>
               </div>
            </div>
         </div>

         {/* Main Content */}
         <div className="flex-1 pt-24 pb-8 px-8 overflow-auto">
            <div className="max-w-4xl mx-auto space-y-8">
               {/* Twitch Integration */}
               <motion.div
                  initial={{ y: 20, opacity: 0 }}
                  animate={{ y: 0, opacity: 1 }}
                  transition={{ duration: 0.5, delay: 0.05 }}
                  className="bg-gray-800/50 border border-gray-700/50 rounded-2xl p-8"
               >
                  <TwitchIntegration />
               </motion.div>

               {/* Audio Settings */}
               <motion.div
                  initial={{ y: 20, opacity: 0 }}
                  animate={{ y: 0, opacity: 1 }}
                  transition={{ duration: 0.5 }}
                  className="bg-gray-800/50 border border-gray-700/50 rounded-2xl p-8"
               >
                  <div className="flex items-center mb-6">
                     <div className="w-12 h-12 bg-purple-500/20 rounded-xl flex items-center justify-center mr-4">
                        <Volume2 className="w-6 h-6 text-purple-400" />
                     </div>
                     <div>
                        <h2 className="text-xl font-bold text-white">Audio Settings</h2>
                        <p className="text-gray-400 text-sm">Configure audio quality and devices</p>
                     </div>
                  </div>

                  <div className="grid grid-cols-2 gap-8">
                     <div className="space-y-6">
                        <div>
                           <label className="block text-sm font-medium text-gray-300 mb-2">Audio Quality</label>
                           <select
                              value={audioQuality}
                              onChange={(e) => setAudioQuality(e.target.value as AudioQuality)}
                              className="w-full px-4 py-3 bg-gray-700/50 border border-gray-600 rounded-lg text-white focus:outline-none focus:border-purple-500"
                           >
                              <option value="high">High Quality (48kHz, 320kbps)</option>
                              <option value="medium">Medium Quality (44.1kHz, 192kbps)</option>
                              <option value="low">Low Quality (22kHz, 128kbps)</option>
                           </select>
                           <div className="mt-2 flex items-center">
                              <div className={`w-2 h-2 rounded-full mr-2 ${audioQuality === 'high' ? 'bg-green-400' :
                                    audioQuality === 'medium' ? 'bg-yellow-400' : 'bg-orange-400'
                                 }`}></div>
                              <span className="text-gray-500 text-xs">
                                 {audioQuality === 'high' ? 'Studio Quality' :
                                    audioQuality === 'medium' ? 'CD Quality' : 'Voice Quality'}
                              </span>
                           </div>
                        </div>

                        <div>
                           <label className="block text-sm font-medium text-gray-300 mb-2">
                              Volume: {volume}%
                           </label>
                           <div className="flex items-center space-x-4">
                              <input
                                 type="range"
                                 min="0"
                                 max="100"
                                 value={volume}
                                 onChange={(e) => handleVolumeChange(parseInt(e.target.value))}
                                 className="flex-1 volume-slider"
                                 style={{
                                    background: `linear-gradient(to right, #8b5cf6 0%, #8b5cf6 ${volume}%, #374151 ${volume}%, #374151 100%)`
                                 }}
                              />
                              <motion.button
                                 whileHover={{ scale: 1.05 }}
                                 whileTap={{ scale: 0.95 }}
                                 onClick={testAudio}
                                 disabled={isTestPlaying}
                                 className={`flex items-center justify-center w-10 h-10 rounded-lg transition-colors ${isTestPlaying
                                       ? 'bg-purple-500 text-white'
                                       : 'bg-gray-700 hover:bg-gray-600 text-gray-300'
                                    }`}
                              >
                                 {isTestPlaying ? (
                                    <Pause className="w-5 h-5" />
                                 ) : (
                                    <Play className="w-5 h-5" />
                                 )}
                              </motion.button>
                           </div>
                           <p className="text-gray-500 text-xs mt-2">Test audio output with sample audio</p>
                        </div>
                     </div>

                     <div className="space-y-6">
                        <div>
                           <label className="block text-sm font-medium text-gray-300 mb-2">
                              Output Device ({outputDevices.length} available)
                           </label>
                           <select
                              value={selectedOutputDevice}
                              onChange={(e) => handleOutputDeviceChange(e.target.value)}
                              className="w-full px-4 py-3 bg-gray-700/50 border border-gray-600 rounded-lg text-white focus:outline-none focus:border-purple-500"
                           >
                              <option value="default">Default Audio Output</option>
                              {outputDevices.map((device, index) => (
                                 <option key={device.deviceId || index} value={device.deviceId}>
                                    {device.label || `Audio Device ${index + 1}`}
                                 </option>
                              ))}
                           </select>
                           {outputDevices.length === 0 && (
                              <p className="text-gray-500 text-xs mt-2">No additional devices detected</p>
                           )}
                        </div>

                        <div className="bg-gray-700/30 border border-gray-600/30 rounded-lg p-4">
                           <h4 className="text-sm font-medium text-gray-300 mb-2">Audio Codec</h4>
                           <p className="text-gray-400 text-xs">Using MP3</p>
                           <div className="flex items-center mt-2">
                              <div className="w-2 h-2 bg-green-400 rounded-full mr-2"></div>
                              <span className="text-green-400 text-xs">Ready</span>
                           </div>
                        </div>
                     </div>
                  </div>
               </motion.div>

               {/* Security Settings */}
               <motion.div
                  initial={{ y: 20, opacity: 0 }}
                  animate={{ y: 0, opacity: 1 }}
                  transition={{ duration: 0.5, delay: 0.1 }}
                  className="bg-gray-800/50 border border-gray-700/50 rounded-2xl p-8"
               >
                  <div className="flex items-center mb-6">
                     <div className="w-12 h-12 bg-cyan-500/20 rounded-xl flex items-center justify-center mr-4">
                        <Shield className="w-6 h-6 text-cyan-400" />
                     </div>
                     <div>
                        <h2 className="text-xl font-bold text-white">Security Settings</h2>
                        <p className="text-gray-400 text-sm">Manage encryption and connection preferences</p>
                     </div>
                  </div>

                  <div className="space-y-6">
                     <div className="flex items-center justify-between p-4 bg-gray-700/30 border border-gray-600/30 rounded-lg">
                        <div>
                           <h3 className="font-medium text-white">Auto-accept known peers</h3>
                           <p className="text-gray-400 text-sm">Automatically accept connections from previously paired devices</p>
                        </div>
                        <motion.button
                           whileHover={{ scale: 1.05 }}
                           whileTap={{ scale: 0.95 }}
                           onClick={() => setAutoAccept(!autoAccept)}
                           className={`relative w-12 h-6 rounded-full transition-colors ${autoAccept ? 'bg-purple-500' : 'bg-gray-600'
                              }`}
                        >
                           <div className={`absolute w-5 h-5 bg-white rounded-full top-0.5 transition-transform ${autoAccept ? 'translate-x-6' : 'translate-x-0.5'
                              }`}></div>
                        </motion.button>
                     </div>

                     <div className="flex items-center justify-between p-4 bg-gray-700/30 border border-gray-600/30 rounded-lg">
                        <div>
                           <h3 className="font-medium text-white">Require manual pairing confirmation</h3>
                           <p className="text-gray-400 text-sm">Always require user confirmation for new device pairings</p>
                        </div>
                        <motion.button
                           whileHover={{ scale: 1.05 }}
                           whileTap={{ scale: 0.95 }}
                           onClick={() => setManualConfirm(!manualConfirm)}
                           className={`relative w-12 h-6 rounded-full transition-colors ${manualConfirm ? 'bg-cyan-500' : 'bg-gray-600'
                              }`}
                        >
                           <div className={`absolute w-5 h-5 bg-white rounded-full top-0.5 transition-transform ${manualConfirm ? 'translate-x-6' : 'translate-x-0.5'
                              }`}></div>
                        </motion.button>
                     </div>
                  </div>
               </motion.div>

               {/* Data Management */}
               <motion.div
                  initial={{ y: 20, opacity: 0 }}
                  animate={{ y: 0, opacity: 1 }}
                  transition={{ duration: 0.5, delay: 0.2 }}
                  className="bg-gray-800/50 border border-gray-700/50 rounded-2xl p-8"
               >
                  <div className="flex items-center mb-6">
                     <div className="w-12 h-12 bg-yellow-500/20 rounded-xl flex items-center justify-center mr-4">
                        <Database className="w-6 h-6 text-yellow-400" />
                     </div>
                     <div>
                        <h2 className="text-xl font-bold text-white">Data Management</h2>
                        <p className="text-gray-400 text-sm">Manage stored data and device information</p>
                     </div>
                  </div>

                  <div className="grid grid-cols-2 gap-4">
                     <motion.button
                        whileHover={{ scale: 1.02 }}
                        whileTap={{ scale: 0.98 }}
                        className="flex items-center justify-center px-6 py-3 bg-red-500/20 border border-red-500/30 hover:bg-red-500/30 text-red-300 rounded-lg transition-colors"
                     >
                        Clear All Known Peers
                     </motion.button>
                     <motion.button
                        whileHover={{ scale: 1.02 }}
                        whileTap={{ scale: 0.98 }}
                        className="flex items-center justify-center px-6 py-3 bg-yellow-500/20 border border-yellow-500/30 hover:bg-yellow-500/30 text-yellow-300 rounded-lg transition-colors"
                     >
                        Reset Device Identity
                     </motion.button>
                  </div>
               </motion.div>

               {/* Appearance */}
               <motion.div
                  initial={{ y: 20, opacity: 0 }}
                  animate={{ y: 0, opacity: 1 }}
                  transition={{ duration: 0.5, delay: 0.3 }}
                  className="bg-gray-800/50 border border-gray-700/50 rounded-2xl p-8"
               >
                  <div className="flex items-center mb-6">
                     <div className="w-12 h-12 bg-pink-500/20 rounded-xl flex items-center justify-center mr-4">
                        <Palette className="w-6 h-6 text-pink-400" />
                     </div>
                     <div>
                        <h2 className="text-xl font-bold text-white">Appearance</h2>
                        <p className="text-gray-400 text-sm">Customize the interface theme</p>
                     </div>
                  </div>

                  <div className="max-w-md">
                     <label className="block text-sm font-medium text-gray-300 mb-2">Theme</label>
                     <select
                        value={theme}
                        onChange={(e) => setTheme(e.target.value)}
                        className="w-full px-4 py-3 bg-gray-700/50 border border-gray-600 rounded-lg text-white focus:outline-none focus:border-purple-500"
                     >
                        <option value="dark">Dark (Default)</option>
                        <option value="light">Light</option>
                        <option value="auto">Auto (System)</option>
                     </select>
                  </div>
               </motion.div>
            </div>
         </div>
      </div>
   );
};

export default SettingsPage;
