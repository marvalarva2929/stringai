import { Platform } from 'react-native';
import { requireNativeModule } from 'expo-modules-core';

let _module: { extractAudio: (uri: string) => Promise<string> } | null = null;

function getModule() {
  if (_module) return _module;
  try {
    _module = requireNativeModule('VideoAudioExtractor');
  } catch {
    _module = null;
  }
  return _module;
}

/**
 * Extract the audio track from a video file as a WAV file.
 * iOS only — uses AVFoundation AVAssetReader via an Expo native module.
 * Returns the local file:// URI of the extracted WAV.
 */
export async function extractAudioFromVideo(videoUri: string): Promise<string> {
  if (Platform.OS !== 'ios') {
    throw new Error('VIDEO_NO_EXTRACTOR');
  }
  const mod = getModule();
  if (!mod) {
    throw new Error('VIDEO_NO_EXTRACTOR');
  }
  return mod.extractAudio(videoUri);
}
