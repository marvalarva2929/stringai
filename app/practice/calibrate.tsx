import React, { useCallback, useEffect, useRef, useState } from 'react';
import { StyleSheet, useWindowDimensions, View } from 'react-native';
import { router } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { TakeCameraCapture, type TakeCameraCaptureResult } from '../../src/components/practice/TakeCameraCapture';
import { BowCalibrationFlow, type CaptureBowClip } from '../../src/components/practice/BowCalibrationFlow';
import { useCalibrationStore } from '../../src/store/useCalibrationStore';
import type { RawBowFrame } from '../../src/types/signals';

export default function CalibrateScreen() {
  const [captureActive, setCaptureActive] = useState(false);
  const pendingCaptureRef = useRef<{
    resolve: (frames: RawBowFrame[]) => void;
  } | null>(null);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const setCalibration = useCalibrationStore((s) => s.setCalibration);
  const { width: screenWidth, height: screenHeight } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const landscapeContainer = {
    position: 'absolute' as const,
    width: screenHeight,
    height: screenWidth,
    top: (screenHeight - screenWidth) / 2,
    left: -(screenHeight - screenWidth) / 2,
    transform: [{ rotate: '-90deg' }],
    paddingRight: insets.bottom,
  };

  const captureBowClip = useCallback<CaptureBowClip>((durationMs) => {
    return new Promise((resolve) => {
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
      pendingCaptureRef.current?.resolve([]);
      pendingCaptureRef.current = { resolve };
      setCaptureActive(true);
      timeoutRef.current = setTimeout(() => setCaptureActive(false), durationMs);
    });
  }, []);

  const onCaptured = (result: TakeCameraCaptureResult) => {
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
    }
    const pending = pendingCaptureRef.current;
    pendingCaptureRef.current = null;
    pending?.resolve(result.bowFrames);
  };

  useEffect(() => {
    return () => {
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
      pendingCaptureRef.current?.resolve([]);
      pendingCaptureRef.current = null;
    };
  }, []);

  return (
    <View style={s.root}>
      <TakeCameraCapture
        active={captureActive}
        mounted
        showGuides
        landscapeGuides
        onCaptured={onCaptured}
      />
      <View style={landscapeContainer}>
        <BowCalibrationFlow
          captureBowClip={captureBowClip}
          onSkip={() => router.back()}
          onComplete={(calibration) => {
            setCalibration(calibration);
            router.back();
          }}
        />
      </View>
    </View>
  );
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#000' },
});
