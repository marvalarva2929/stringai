import React, { useRef, useState, useEffect, useMemo } from 'react';
import { View, Text, Pressable, StyleSheet, Dimensions, PanResponder } from 'react-native';
import { Video, ResizeMode, AVPlaybackStatus, Audio } from 'expo-av';
import { colors, spacing } from '../../constants/theme';
import type { NoteEvent } from '../../lib/noteFusion';

export interface InlineVideoPlayerProps {
  uri: string;
  seekVersion?: number;
  seekSeconds?: number;
  fullScreen?: boolean;
  noteEvents?: NoteEvent[];
  /** Known recording duration in seconds — used as duration fallback so stamps
   *  appear immediately on remount before the Video component reports durationMillis. */
  durationSeconds?: number;
  onMarkerPress?: (seconds: number) => void;
}

const VIDEO_H = Math.round(Dimensions.get('window').height * 0.28);
const CONTROLS_H = 56;

// ── Intonation speedometer ─────────────────────────────────────────────────────
function IntonationGauge({ cents }: { cents: number | null }) {
  const RANGE = 50;
  const clamped = cents === null ? 0 : Math.max(-RANGE, Math.min(RANGE, cents));
  const pct = ((clamped + RANGE) / (RANGE * 2)) * 100;
  const abs = cents === null ? 0 : Math.abs(cents);
  const needleColor =
    cents === null  ? 'rgba(255,255,255,0.25)' :
    abs <= 15       ? '#22c55e' :
    abs <= 30       ? '#fbbf24' :
                      '#ef4444';

  return (
    <View style={gs.wrap}>
      <Text style={gs.edge}>♭</Text>
      <View style={gs.bar}>
        <View style={[gs.zone, { backgroundColor: '#818cf820' }]} />
        <View style={[gs.zone, { backgroundColor: '#22c55e20' }]} />
        <View style={[gs.zone, { backgroundColor: '#f9731620' }]} />
        <View style={gs.centreTick} />
        <View style={[gs.needle, { left: `${pct.toFixed(1)}%` as any, backgroundColor: needleColor }]} />
      </View>
      <Text style={gs.edge}>♯</Text>
    </View>
  );
}

const gs = StyleSheet.create({
  wrap:       { flexDirection: 'row', alignItems: 'center', gap: 4 },
  edge:       { color: 'rgba(255,255,255,0.55)', fontSize: 10, fontWeight: '700', width: 10, textAlign: 'center' },
  bar:        { width: 74, height: 5, borderRadius: 2.5, backgroundColor: 'rgba(255,255,255,0.08)', flexDirection: 'row', overflow: 'hidden', position: 'relative' },
  zone:       { flex: 1, height: '100%' },
  centreTick: { position: 'absolute', left: '50%' as any, top: 0, bottom: 0, width: 1, backgroundColor: 'rgba(255,255,255,0.4)', marginLeft: -0.5 },
  needle:     { position: 'absolute', top: -3, marginLeft: -5, width: 10, height: 11, borderRadius: 5, shadowColor: '#000', shadowOffset: { width: 0, height: 1 }, shadowOpacity: 0.4, shadowRadius: 1 },
});

// ── Main player ────────────────────────────────────────────────────────────────
export function InlineVideoPlayer({
  uri, seekVersion, seekSeconds, fullScreen, noteEvents, durationSeconds, onMarkerPress,
}: InlineVideoPlayerProps) {
  const videoRef  = useRef<Video>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [duration,  setDuration]  = useState(0);
  const [position,  setPosition]  = useState(0);
  // dragMs: set during scrub for instant visual feedback; null = use video position
  const [dragMs, setDragMs] = useState<number | null>(null);
  const [playbackRate, setPlaybackRateState] = useState(1.0);
  const loadedRef       = useRef(false);
  const playbackRateRef = useRef(1.0);
  const appliedSeekVersion = useRef<number | undefined>(undefined);

  // Refs for PanResponder closures — always fresh, no stale captures
  const durationRef     = useRef(0);
  const trackWidthRef   = useRef(0);
  const grantPctRef     = useRef(0);
  const seekThrottleRef = useRef(0);

  const handleSetRate = (rate: number) => {
    playbackRateRef.current = rate;
    setPlaybackRateState(rate);
    if (loadedRef.current) {
      videoRef.current?.setRateAsync(rate, true).catch(() => {});
    }
  };

  useEffect(() => { durationRef.current = duration; }, [duration]);

  // Priority: real video duration > known recording duration > noteEvents estimate.
  // This keeps stamps visible immediately on mount/remount before the Video component
  // has had a chance to report durationMillis (e.g. after tab switches or app resume).
  const effectiveDuration = useMemo(() => {
    if (duration > 0) return duration;
    if (durationSeconds && durationSeconds > 0) return durationSeconds * 1000;
    if (!noteEvents?.length) return 0;
    return Math.max(...noteEvents.map(n => n.endSeconds)) * 1000 * 1.05;
  }, [duration, durationSeconds, noteEvents]);

  // The position we actually display (drag overrides video position for smooth scrubbing)
  const displayMs = dragMs !== null ? dragMs : position;

  // Note playing at the display position — updates during drag too.
  // Iterate all events and keep the LAST match instead of the first: consecutive notes
  // share a boundary (A.endSeconds === B.startSeconds after onset backshift), so both
  // satisfy the range check at that instant — the later-starting one is correct.
  const currentNote: NoteEvent | null = useMemo(() => {
    if (!noteEvents?.length) return null;
    const secs = displayMs / 1000;
    let found: NoteEvent | null = null;
    for (const n of noteEvents) {
      if (secs >= n.startSeconds && secs <= n.endSeconds + 0.08) found = n;
    }
    return found;
  }, [noteEvents, displayMs]);

  // Audio session: switch to playback mode so video audio works after recording
  useEffect(() => {
    Audio.setAudioModeAsync({
      allowsRecordingIOS: false,
      playsInSilentModeIOS: true,
      staysActiveInBackground: false,
      shouldDuckAndroid: false,
    }).catch(() => {});
  }, []);

  // External seek (coaching card timestamp chips)
  useEffect(() => {
    if (seekVersion === undefined || seekVersion === appliedSeekVersion.current) return;
    appliedSeekVersion.current = seekVersion;
    if (loadedRef.current) {
      videoRef.current?.setPositionAsync((seekSeconds ?? 0) * 1000, { toleranceMillisBefore: 0, toleranceMillisAfter: 0 }).catch(() => {});
    }
  }, [seekVersion, seekSeconds]);

  const handleStatus = (status: AVPlaybackStatus) => {
    if (!status.isLoaded) return;
    if (!loadedRef.current) {
      loadedRef.current = true;
      videoRef.current?.setRateAsync(playbackRateRef.current, true).catch(() => {});
      if (seekVersion !== undefined && seekVersion !== appliedSeekVersion.current) {
        appliedSeekVersion.current = seekVersion;
        videoRef.current?.setPositionAsync((seekSeconds ?? 0) * 1000, { toleranceMillisBefore: 0, toleranceMillisAfter: 0 }).catch(() => {});
      }
    }
    setIsPlaying(status.isPlaying ?? false);
    setPosition(status.positionMillis ?? 0);
    if (status.durationMillis) setDuration(status.durationMillis);
  };

  const togglePlay = async () => {
    const st = await videoRef.current?.getStatusAsync();
    if (!st?.isLoaded) return;
    st.isPlaying ? videoRef.current?.pauseAsync() : videoRef.current?.playAsync();
  };

  const fmtMs = (ms: number) => {
    const s = Math.floor(ms / 1000);
    return `${Math.floor(s / 60)}:${(s % 60).toString().padStart(2, '0')}`;
  };

  const SPEED_OPTIONS = [0.25, 0.5, 1.0] as const;
  const speedLabel = (r: number) => r === 1 ? '1×' : r === 0.5 ? '½×' : '¼×';

  // Horizontal scrub — PanResponder on the track container.
  // onStart: () => true captures all touches so tapping anywhere on the track seeks.
  // dragMs updates every event for smooth visual motion; expo-av seeks are throttled.
  const horizontalPanResponder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder:  () => true,
      onPanResponderGrant: (e) => {
        const pct = Math.max(0, Math.min(1, e.nativeEvent.locationX / Math.max(1, trackWidthRef.current)));
        grantPctRef.current = pct;
        const ms = pct * durationRef.current;
        setDragMs(ms);
        videoRef.current?.setPositionAsync(ms).catch(() => {});
      },
      onPanResponderMove: (_, gs) => {
        const pct = Math.max(0, Math.min(1, grantPctRef.current + gs.dx / Math.max(1, trackWidthRef.current)));
        const ms = pct * durationRef.current;
        setDragMs(ms);  // always — gives smooth visual
        const now = Date.now();
        if (now - seekThrottleRef.current >= 50) {
          seekThrottleRef.current = now;
          videoRef.current?.setPositionAsync(ms).catch(() => {});
        }
      },
      onPanResponderRelease:   () => setDragMs(null),
      onPanResponderTerminate: () => setDragMs(null),
    })
  ).current;

  const displayProgress = effectiveDuration > 0 ? Math.min(displayMs / effectiveDuration, 1) : 0;

  // ── Non-fullscreen: compact horizontal player ─────────────────────────────
  if (!fullScreen) {
    return (
      <View style={styles.container}>
        <Video
          ref={videoRef}
          source={{ uri }}
          style={styles.video}
          resizeMode={ResizeMode.CONTAIN}
          onPlaybackStatusUpdate={handleStatus}
          shouldPlay={false}
          useNativeControls={false}
        />
        <View style={styles.controls}>
          <Pressable style={styles.playBtn} onPress={togglePlay}>
            <Text style={styles.playBtnText}>{isPlaying ? '⏸' : '▶'}</Text>
          </Pressable>
          <Text style={styles.timeText}>{fmtMs(displayMs)}</Text>
          <View
            style={styles.trackContainer}
            onLayout={(e) => { trackWidthRef.current = e.nativeEvent.layout.width; }}
            {...horizontalPanResponder.panHandlers}
          >
            <View style={styles.track}>
              <View style={[styles.fill, { flex: displayProgress || 0.001 }]} />
              <View style={{ flex: Math.max(1 - displayProgress, 0.001) }} />
            </View>
            {effectiveDuration > 0 && noteEvents?.map((ev, i) => {
              const p = Math.min(100, Math.max(0, (ev.startSeconds * 1000 / effectiveDuration) * 100));
              return (
                <View
                  key={i}
                  style={[styles.markerTick, { left: `${p.toFixed(2)}%` as any }]}
                />
              );
            })}
          </View>
          <Text style={styles.timeText}>{fmtMs(duration || effectiveDuration)}</Text>
          <View style={styles.speedButtons}>
            {SPEED_OPTIONS.map(r => (
              <Pressable
                key={r}
                style={[styles.speedBtn, playbackRate === r && styles.speedBtnActive]}
                onPress={() => handleSetRate(r)}
              >
                <Text style={[styles.speedBtnText, playbackRate === r && styles.speedBtnTextActive]}>
                  {speedLabel(r)}
                </Text>
              </Pressable>
            ))}
          </View>
        </View>
      </View>
    );
  }

  // ── Fullscreen: horizontal track at bottom + live note overlay ────────────
  const noteColor =
    !currentNote                               ? 'rgba(255,255,255,0.45)' :
    currentNote.inTune                         ? '#22c55e' :
    Math.abs(currentNote.centsDeviation) <= 35 ? '#fbbf24' :
                                                 '#ef4444';

  return (
    <View style={styles.containerFull}>
      <Video
        ref={videoRef}
        source={{ uri }}
        style={StyleSheet.absoluteFillObject}
        resizeMode={ResizeMode.CONTAIN}
        onPlaybackStatusUpdate={handleStatus}
        shouldPlay={false}
        useNativeControls={false}
      />

      {/* ── Note + speedometer — top right overlay ── */}
      <View style={styles.noteOverlay} pointerEvents="none">
        <Text style={[styles.noteOverlayName, { color: noteColor }]}>
          {currentNote?.noteName ?? '—'}
        </Text>
        <Text style={styles.noteOverlayCents}>
          {currentNote
            ? `${currentNote.centsDeviation >= 0 ? '+' : ''}${Math.round(currentNote.centsDeviation)}¢`
            : ' '}
        </Text>
        <IntonationGauge cents={currentNote?.centsDeviation ?? null} />
      </View>

      {/* ── Bottom controls: play/pause + draggable track + time ── */}
      <View style={styles.controlsOverlay}>
        <Pressable style={styles.playBtn} onPress={togglePlay}>
          <Text style={styles.playBtnText}>{isPlaying ? '⏸' : '▶'}</Text>
        </Pressable>
        <Text style={styles.timeText}>{fmtMs(displayMs)}</Text>
        {/* Track — PanResponder handles both tap-to-seek and drag-to-scrub */}
        <View
          style={styles.trackContainer}
          onLayout={(e) => { trackWidthRef.current = e.nativeEvent.layout.width; }}
          {...horizontalPanResponder.panHandlers}
        >
          <View style={styles.track}>
            <View style={[styles.fill, { flex: displayProgress || 0.001 }]} />
            <View style={{ flex: Math.max(1 - displayProgress, 0.001) }} />
          </View>
          {/* Note tick marks — show as soon as noteEvents available, no duration wait */}
          {effectiveDuration > 0 && noteEvents?.map((ev, i) => {
            const p = Math.min(100, (ev.startSeconds * 1000 / effectiveDuration) * 100);
            const isActive = ev === currentNote;
            return (
              <View
                key={i}
                style={[
                  styles.markerTick,
                  { left: `${p.toFixed(2)}%` as any },
                  isActive && styles.markerTickActive,
                ]}
              />
            );
          })}
        </View>
        <Text style={styles.timeText}>{fmtMs(duration || effectiveDuration)}</Text>
        <View style={styles.speedButtons}>
          {SPEED_OPTIONS.map(r => (
            <Pressable
              key={r}
              style={[styles.speedBtn, playbackRate === r && styles.speedBtnActive]}
              onPress={() => handleSetRate(r)}
            >
              <Text style={[styles.speedBtnText, playbackRate === r && styles.speedBtnTextActive]}>
                {speedLabel(r)}
              </Text>
            </Pressable>
          ))}
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  // ── Non-fullscreen ────────────────────────────────────────────────────────
  container: { backgroundColor: '#000' },
  video:     { width: '100%', height: VIDEO_H, backgroundColor: '#000' },
  controls: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing.md,
    paddingVertical: 10,
    backgroundColor: '#111',
    gap: spacing.sm,
  },

  // ── Shared: track + markers ───────────────────────────────────────────────
  trackContainer: {
    flex: 1,
    height: 24,
    justifyContent: 'center',
    position: 'relative',
  },
  track: {
    height: 3,
    borderRadius: 1.5,
    backgroundColor: 'rgba(255,255,255,0.2)',
    flexDirection: 'row',
    overflow: 'hidden',
  },
  fill: { height: '100%', backgroundColor: colors.brand[400] },
  // Tick marks — absolute within trackContainer, vertically centred on the bar
  markerTick: {
    position: 'absolute',
    top: '50%',
    marginTop: -5,
    marginLeft: -1,
    width: 2,
    height: 10,
    borderRadius: 1,
    backgroundColor: '#fbbf24',
    opacity: 0.85,
  },
  // Currently-playing tick is white and slightly taller
  markerTickActive: {
    height: 13,
    marginTop: -6.5,
    backgroundColor: '#fff',
    opacity: 1,
    width: 2.5,
    marginLeft: -1.25,
  },

  // ── Fullscreen ────────────────────────────────────────────────────────────
  containerFull: { flex: 1, backgroundColor: '#000' },

  // Note + intonation card — top right
  noteOverlay: {
    position: 'absolute',
    top: 10,
    right: 10,
    backgroundColor: 'rgba(0,0,0,0.70)',
    borderRadius: 10,
    paddingHorizontal: 10,
    paddingVertical: 8,
    alignItems: 'center',
    gap: 2,
    minWidth: 88,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.08)',
  },
  noteOverlayName: {
    fontSize: 24,
    fontWeight: '800',
    letterSpacing: 0.5,
  },
  noteOverlayCents: {
    fontSize: 11,
    color: 'rgba(255,255,255,0.55)',
    fontWeight: '600',
    minHeight: 14,
  },

  // Bottom controls bar
  controlsOverlay: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    height: CONTROLS_H,
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing.md,
    backgroundColor: 'rgba(0,0,0,0.65)',
    gap: spacing.sm,
  },

  // Shared
  playBtn: {
    width: 30,
    height: 30,
    borderRadius: 15,
    backgroundColor: colors.brand[600],
    alignItems: 'center',
    justifyContent: 'center',
  },
  playBtnText: { color: '#fff', fontSize: 13 },
  timeText: {
    fontSize: 11,
    color: '#aaa',
    minWidth: 36,
    textAlign: 'center',
    fontVariant: ['tabular-nums'] as any,
  },

  // Speed selector
  speedButtons: { flexDirection: 'row', gap: 3 },
  speedBtn: {
    paddingHorizontal: 6,
    paddingVertical: 3,
    borderRadius: 4,
    backgroundColor: 'rgba(255,255,255,0.10)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.12)',
  },
  speedBtnActive: {
    backgroundColor: colors.brand[600],
    borderColor: colors.brand[500],
  },
  speedBtnText: { color: 'rgba(255,255,255,0.5)', fontSize: 10, fontWeight: '700' as const },
  speedBtnTextActive: { color: '#fff' },
});
