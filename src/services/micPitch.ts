import { Platform } from 'react-native';
import { requireNativeModule, type EventSubscription } from 'expo-modules-core';

/** One reading from the native YIN detector. Arrives ~47x/sec while the mic tap is running. */
export interface PitchReading {
  /** Fundamental in Hz. 0 when `voiced` is false. */
  hz: number;
  /** YIN aperiodicity confidence, 0–1. Low means the detector isn't sure. */
  clarity: number;
  /** Window RMS, 0–1. */
  rms: number;
  /** False for silence or an unconfident reading — show "listening", not a stale note. */
  voiced: boolean;
}

interface MicPitchNativeModule {
  start: () => Promise<void>;
  stop: () => Promise<void>;
  forceSpeaker: () => Promise<void>;
  addListener: (event: 'onPitch', listener: (e: PitchReading) => void) => EventSubscription;
}

let _module: MicPitchNativeModule | null | undefined;

function getModule(): MicPitchNativeModule | null {
  if (_module !== undefined) return _module;
  try {
    _module = requireNativeModule<MicPitchNativeModule>('MicPitch');
  } catch {
    _module = null;
  }
  return _module;
}

/**
 * True when the streaming tuner is usable. False on Android and in Expo Go, where
 * callers must fall back to the record-a-clip path.
 */
export function isMicPitchAvailable(): boolean {
  return Platform.OS === 'ios' && getModule() !== null;
}

/** Starts the mic tap. Caller must have already obtained mic permission. */
export async function startMicPitch(): Promise<void> {
  const mod = getModule();
  if (!mod) throw new Error('MIC_PITCH_UNAVAILABLE');
  await mod.start();
}

export async function stopMicPitch(): Promise<void> {
  const mod = getModule();
  if (!mod) return;
  try {
    await mod.stop();
  } catch {
    // Stopping an already-stopped engine is not an error worth surfacing.
  }
}

/** Subscribe to readings. Returns null if the native module isn't present. */
export function addPitchListener(cb: (reading: PitchReading) => void): EventSubscription | null {
  const mod = getModule();
  if (!mod) return null;
  return mod.addListener('onPitch', cb);
}

/**
 * Routes audio output to the loud speaker instead of the quiet earpiece. iOS
 * defaults a `playAndRecord` session (recording while also playing back —
 * e.g. the metronome click during a take) to the earpiece unless overridden,
 * and expo-av exposes no JS option for that. No-op off iOS / in Expo Go.
 */
export async function forceSpeakerOutput(): Promise<void> {
  const mod = getModule();
  if (!mod) return;
  try {
    await mod.forceSpeaker();
  } catch {
    // Best-effort — a quiet click beats a failed take.
  }
}
