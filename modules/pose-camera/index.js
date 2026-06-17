import { requireNativeModule, requireNativeViewManager } from 'expo-modules-core';
import { Platform } from 'react-native';

let _module = null;
function getModule() {
  if (_module) return _module;
  if (Platform.OS !== 'ios') return null;
  try {
    _module = requireNativeModule('PoseCamera');
  } catch {
    _module = null;
  }
  return _module;
}

export function startRecording() {
  return getModule()?.startRecording() ?? Promise.resolve();
}

export function stopRecording() {
  return getModule()?.stopRecording() ?? Promise.resolve();
}

// Returns an array of pose frame objects (same shape as onPose events, plus a
// "timestamp" field in seconds). Returns [] when the module is unavailable or
// the video cannot be analyzed.
export function analyzeVideo(videoUri) {
  return getModule()?.analyzeVideo(videoUri) ?? Promise.resolve([]);
}

let _NativeView = null;
export function getPoseCameraView() {
  if (_NativeView) return _NativeView;
  if (Platform.OS !== 'ios') return null;
  try {
    _NativeView = requireNativeViewManager('PoseCamera');
  } catch {
    _NativeView = null;
  }
  return _NativeView;
}
