#!/usr/bin/env python3
"""
Patches the auto-generated ExpoModulesProvider.swift to include app-level
Expo modules defined directly in the app target (no import needed — same module).

Usage: python3 patch-expo-modules.py <path-to-ExpoModulesProvider.swift>
"""
import re, sys

path = sys.argv[1]

with open(path) as f:
    src = f.read()

# Remove the pod-based import if it slipped in from autolinking
src = re.sub(r'\nimport VideoAudioExtractor\n', '\n', src)

if 'VideoAudioExtractorModule' in src:
    print('[patch-expo-modules] already contains VideoAudioExtractorModule, skipping')
    with open(path, 'w') as f:
        f.write(src)
    sys.exit(0)

# Add module class into getModuleClasses() return array after the last Expo module
src = re.sub(
    r'(SplashScreenModule\.self)(\s*\])',
    r'\1,\n      VideoAudioExtractorModule.self\2',
    src
)

with open(path, 'w') as f:
    f.write(src)

print('[patch-expo-modules] added VideoAudioExtractorModule to ExpoModulesProvider')
