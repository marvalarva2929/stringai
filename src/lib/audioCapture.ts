import { Audio } from 'expo-av';
import { configureMeasurementSession, forceSpeakerOutput } from '../services/micPitch';

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
    // MAX, not MEDIUM: this clip is what the evaluators grade, and it should be
    // as close to the signal the streaming tuner reads as expo-av can manage.
    audioQuality: Audio.IOSAudioQuality.MAX,
    // Matches the rate the native pitch engine requests (MicPitchModule
    // setPreferredSampleRate), so the session isn't resampling underneath us.
    sampleRate: 48000,
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
export interface StartedTake {
  recording: Audio.Recording;
  /**
   * Wall-clock ms at the moment capture began — as close to the first recorded
   * sample as JS can observe.
   *
   * Callers that place events inside the file (beat times for a click track)
   * must use this, not a `Date.now()` taken after this function resolves. There
   * is real work after `startAsync` below, so a timestamp taken afterwards sits
   * *later* than sample 0, which pushes every beat earlier in file coordinates
   * and biases every measured note offset toward "late" — the same direction as
   * every other unmeasured delay in the chain.
   */
  startedAtMs: number;
}

export async function startTakeRecording(onLevel?: (dbfs: number) => void): Promise<StartedTake> {
  await Audio.setAudioModeAsync({ allowsRecordingIOS: true, playsInSilentModeIOS: true });
  // Must come *after* setAudioModeAsync, which sets the category itself and would
  // otherwise clobber the measurement mode. This is what keeps iOS AGC and noise
  // suppression off the graded clip, so the evaluators judge the same unprocessed
  // signal the tuner displays.
  await configureMeasurementSession();
  const recording = new Audio.Recording();
  await recording.prepareToRecordAsync(WAV_OPTIONS);
  if (onLevel) {
    recording.setProgressUpdateInterval(LEVEL_INTERVAL_MS);
    recording.setOnRecordingStatusUpdate((status) => {
      if (status.isRecording && status.metering != null) onLevel(status.metering);
    });
  }
  await recording.startAsync();
  const startedAtMs = Date.now();
  // `allowsRecordingIOS` above puts the session in playAndRecord, which
  // defaults output to the quiet earpiece — force it back to the speaker so
  // any concurrent playback (the metronome click during a scale/rhythm take)
  // stays audible. Deliberately after the timestamp above: this is more async
  // work, and anything it costs would otherwise be charged to the player as lateness.
  await forceSpeakerOutput();
  return { recording, startedAtMs };
}

/** How often metering updates arrive while a take is recording. */
export const LEVEL_INTERVAL_MS = 100;

/** Stops the recording and returns the local file URI, or null if none was produced. */
export async function stopTakeRecording(recording: Audio.Recording): Promise<string | null> {
  await recording.stopAndUnloadAsync();
  return recording.getURI();
}
