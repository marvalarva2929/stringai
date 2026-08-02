import React, { useCallback } from 'react';
import { View, StyleSheet, type LayoutChangeEvent } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, { useSharedValue, useAnimatedStyle, runOnJS } from 'react-native-reanimated';
import { colors, radius } from '../../constants/theme';

interface Props {
  value: number;
  min: number;
  max: number;
  /** Quantisation of the emitted value. 1 = every integer. */
  step?: number;
  onChange: (value: number) => void;
  /** Fires once when the drag begins and once when it ends — the metronome
   *  preview restarts on release rather than on every intermediate value. */
  onSlidingStart?: () => void;
  onSlidingComplete?: (value: number) => void;
}

const THUMB = 28;
const TRACK_H = 6;

/**
 * A self-contained value slider — no @react-native-community/slider native
 * dependency, just gesture-handler + reanimated, both already in the app.
 *
 * Dragging is continuous but the emitted value is quantised to `step`, and
 * onChange fires only when that quantised value actually changes, so a caller
 * wiring it to a store isn't spammed with identical updates mid-drag.
 */
export function Slider({ value, min, max, step = 1, onChange, onSlidingStart, onSlidingComplete }: Props) {
  const width = useSharedValue(0);
  // The value being dragged, so the thumb tracks the finger even before the
  // parent's state round-trips back through the `value` prop.
  const dragValue = useSharedValue(value);
  const dragging = useSharedValue(false);

  const clampQuantise = (v: number): number => {
    'worklet';
    const stepped = Math.round(v / step) * step;
    return Math.max(min, Math.min(max, stepped));
  };

  const onLayout = useCallback((e: LayoutChangeEvent) => {
    width.value = e.nativeEvent.layout.width;
  }, [width]);

  const valueFromX = (x: number): number => {
    'worklet';
    const usable = Math.max(1, width.value - THUMB);
    const pct = Math.max(0, Math.min(1, (x - THUMB / 2) / usable));
    return clampQuantise(min + pct * (max - min));
  };

  const emit = useCallback((v: number) => onChange(v), [onChange]);
  const emitComplete = useCallback((v: number) => onSlidingComplete?.(v), [onSlidingComplete]);
  const emitStart = useCallback(() => onSlidingStart?.(), [onSlidingStart]);

  const pan = Gesture.Pan()
    .onBegin((e) => {
      dragging.value = true;
      const v = valueFromX(e.x);
      dragValue.value = v;
      runOnJS(emitStart)();
      runOnJS(emit)(v);
    })
    .onUpdate((e) => {
      const v = valueFromX(e.x);
      if (v !== dragValue.value) {
        dragValue.value = v;
        runOnJS(emit)(v);
      }
    })
    .onFinalize(() => {
      dragging.value = false;
      runOnJS(emitComplete)(dragValue.value);
    });

  // A tap anywhere on the track jumps straight to that value.
  const tap = Gesture.Tap().onEnd((e) => {
    const v = valueFromX(e.x);
    dragValue.value = v;
    runOnJS(emit)(v);
    runOnJS(emitComplete)(v);
  });

  const gesture = Gesture.Race(pan, tap);

  // While dragging, follow the finger; otherwise follow the prop so steppers and
  // external changes move the thumb too.
  const pctFor = (v: number): number => {
    'worklet';
    return max > min ? (v - min) / (max - min) : 0;
  };

  const thumbStyle = useAnimatedStyle(() => {
    const v = dragging.value ? dragValue.value : value;
    const usable = Math.max(0, width.value - THUMB);
    return { transform: [{ translateX: pctFor(v) * usable }] };
  });

  const fillStyle = useAnimatedStyle(() => {
    const v = dragging.value ? dragValue.value : value;
    return { width: `${pctFor(v) * 100}%` };
  });

  return (
    <GestureDetector gesture={gesture}>
      <View style={s.hitArea} onLayout={onLayout}>
        <View style={s.track}>
          <Animated.View style={[s.fill, fillStyle]} />
        </View>
        <Animated.View style={[s.thumb, thumbStyle]} />
      </View>
    </GestureDetector>
  );
}

const s = StyleSheet.create({
  hitArea: {
    height: THUMB + 12,
    justifyContent: 'center',
  },
  track: {
    height: TRACK_H,
    borderRadius: radius.full,
    backgroundColor: '#e5e7eb',
    overflow: 'hidden',
  },
  fill: {
    height: TRACK_H,
    borderRadius: radius.full,
    backgroundColor: colors.brand[500],
  },
  thumb: {
    position: 'absolute',
    left: 0,
    width: THUMB,
    height: THUMB,
    borderRadius: THUMB / 2,
    backgroundColor: '#fff',
    borderWidth: 2,
    borderColor: colors.brand[500],
    shadowColor: '#000',
    shadowOpacity: 0.2,
    shadowRadius: 3,
    shadowOffset: { width: 0, height: 1 },
    elevation: 3,
  },
});
