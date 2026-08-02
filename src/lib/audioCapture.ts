import { Audio } from 'expo-av';
import { forceSpeakerOutput } from '../services/micPitch';

export type Recording = Audio.Recording;

/**
 * Shared recording config for short mic takes (tuner loop, exercise runner).
 * iOS records LINEARPCM WAV so the on-device DSP (dsp.ts/audioEngine.ts) can
 * parse it directly; Android falls back to AAC/M4A, which the WAV parser
 * rejects — callers must handle a null/failed decode on Android.
 */
export const WAV_OPTIONS: Audio.RecordingOptions = {
  isMeteringEnabled: true,
  android: {
    extension: '.m4a',
    outputFormat: Audio.AndroidOutputFormat.MPEG_4,
    audioEncoder: Audio.AndroidAudioEncoder.AAC,
    sampleRate: 44100,
    numberOfChannels: 1,
    bitRate: 128000,
  },
  ios: {
    extension: '.wav',
    outputFormat: Audio.IOSOutputFormat.LINEARPCM,
    audioQuality: Audio.IOSAudioQuality.MEDIUM,
    sampleRate: 44100,
    numberOfChannels: 1,
    bitRate: 128000,
    linearPCMBitDepth: 16,
    linearPCMIsBigEndian: false,
    linearPCMIsFloat: false,
  },
  web: {},
};

export async function requestMicPermission(): Promise<boolean> {
  const { granted } = await Audio.requestPermissionsAsync();
  return granted;
}

/**
 * Starts a single mic recording for a take. Caller stops it with `stopTakeRecording`.
 *
 * `onLevel` receives the input level in dBFS (roughly -160 = silence, 0 = peak)
 * a few times a second, so a caller can end the take when the player stops
 * playing instead of making them wait out a fixed timer.
 */
export async function startTakeRecording(onLevel?: (dbfs: number) => void): Promise<Audio.Recording> {
  await Audio.setAudioModeAsync({ allowsRecordingIOS: true, playsInSilentModeIOS: true });
  const recording = new Audio.Recording();
  await recording.prepareToRecordAsync(WAV_OPTIONS);
  if (onLevel) {
    recording.setProgressUpdateInterval(LEVEL_INTERVAL_MS);
    recording.setOnRecordingStatusUpdate((status) => {
      if (status.isRecording && status.metering != null) onLevel(status.metering);
    });
  }
  await recording.startAsync();
  // `allowsRecordingIOS` above puts the session in playAndRecord, which
  // defaults output to the quiet earpiece — force it back to the speaker so
  // any concurrent playback (the metronome click during a scale/rhythm take)
  // stays audible.
  await forceSpeakerOutput();
  return recording;
}

/** How often metering updates arrive while a take is recording. */
export const LEVEL_INTERVAL_MS = 100;

/** Stops the recording and returns the local file URI, or null if none was produced. */
export async function stopTakeRecording(recording: Audio.Recording): Promise<string | null> {
  await recording.stopAndUnloadAsync();
  return recording.getURI();
}
