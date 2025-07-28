export type AudioQuality = 'high' | 'medium' | 'low';

export interface AudioQualitySettings {
   sampleRate: number;
   bitrate: number;
   frequency: number;
   description: string;
}

export const getAudioQualitySettings = (quality: AudioQuality): AudioQualitySettings => {
   switch (quality) {
      case 'high':
         return {
            sampleRate: 48000,
            bitrate: 320,
            frequency: 880, 
            description: 'Studio Quality'
         };
      case 'medium':
         return {
            sampleRate: 44100,
            bitrate: 192,
            frequency: 660, 
            description: 'CD Quality'
         };
      case 'low':
         return {
            sampleRate: 22050,
            bitrate: 128,
            frequency: 440, 
            description: 'Voice Quality'
         };
      default:
         return {
            sampleRate: 48000,
            bitrate: 320,
            frequency: 880,
            description: 'Studio Quality'
         };
   }
};

export const getAudioSettingsForBackend = (quality: AudioQuality, volume: number) => {
   const settings = getAudioQualitySettings(quality);
   return {
      ...settings,
      volume: volume / 100,
      timestamp: Date.now()
   };
};

export const createAudioContext = (quality: AudioQuality): AudioContext => {
   const settings = getAudioQualitySettings(quality);
   return new (window.AudioContext || (window as any).webkitAudioContext)({
      sampleRate: settings.sampleRate
   });
};
