/**
 * npm creates a symlink for file: dependencies, but expo-modules-autolinking
 * cannot follow symlinks. Replace the symlink with a real directory copy so
 * autolinking can find the local Expo module and register it automatically.
 */
const fs = require('fs');
const path = require('path');

const src = path.resolve(__dirname, '../modules/video-audio-extractor');
const dest = path.resolve(__dirname, '../node_modules/video-audio-extractor');

try {
  const stat = fs.lstatSync(dest);
  if (stat.isSymbolicLink()) {
    fs.rmSync(dest);
    fs.cpSync(src, dest, { recursive: true });
    console.log('[postinstall] Converted video-audio-extractor symlink to real directory');
  }
} catch {
  // dest doesn't exist yet — npm will create it; nothing to do
}
