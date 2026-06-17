import React, { useRef, useState, useEffect } from 'react';
import { Modal, View, Text, Pressable, StyleSheet, Dimensions } from 'react-native';
import { Video, ResizeMode, AVPlaybackStatus, Audio } from 'expo-av';
import { colors, spacing, radius } from '../../constants/theme';

export interface VideoReplayModalProps {
  visible: boolean;
  videoUri: string;
  seekToSeconds: number;
  label?: string;
  onClose: () => void;
}

const { height: SCREEN_H } = Dimensions.get('window');
const VIDEO_HEIGHT = SCREEN_H * 0.58;

export function VideoReplayModal({
  visible,
  videoUri,
  seekToSeconds,
  label,
  onClose,
}: VideoReplayModalProps) {
  const videoRef = useRef<Video>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [duration, setDuration] = useState(0);
  const [position, setPosition] = useState(0);
  const seekedRef = useRef(false);

  useEffect(() => {
    seekedRef.current = false;
    if (visible) {
      Audio.setAudioModeAsync({
        allowsRecordingIOS: false,
        playsInSilentModeIOS: true,
        staysActiveInBackground: false,
        shouldDuckAndroid: false,
      }).catch(() => {});
    } else {
      videoRef.current?.pauseAsync().catch(() => {});
      setIsPlaying(false);
      setPosition(0);
      setDuration(0);
    }
  }, [visible, seekToSeconds]);

  const handlePlaybackStatusUpdate = (status: AVPlaybackStatus) => {
    if (!status.isLoaded) return;
    if (!seekedRef.current) {
      seekedRef.current = true;
      videoRef.current?.setPositionAsync(seekToSeconds * 1000).catch(() => {});
    }
    setIsPlaying(status.isPlaying ?? false);
    setPosition(status.positionMillis ?? 0);
    if (status.durationMillis) setDuration(status.durationMillis);
  };

  const togglePlayPause = async () => {
    if (!videoRef.current) return;
    const status = await videoRef.current.getStatusAsync();
    if (!status.isLoaded) return;
    if (status.isPlaying) {
      await videoRef.current.pauseAsync();
    } else {
      await videoRef.current.playAsync();
    }
  };

  const formatTime = (ms: number) => {
    const s = Math.floor(ms / 1000);
    return `${Math.floor(s / 60)}:${(s % 60).toString().padStart(2, '0')}`;
  };

  const progressFraction = duration > 0 ? Math.min(position / duration, 1) : 0;

  return (
    <Modal visible={visible} animationType="slide" transparent statusBarTranslucent>
      <View style={styles.backdrop}>
        <View style={styles.container}>
          <View style={styles.topBar}>
            <Text style={styles.topBarLabel} numberOfLines={2}>{label ?? 'Session Replay'}</Text>
            <Pressable style={styles.closeBtn} onPress={onClose} hitSlop={12}>
              <Text style={styles.closeBtnText}>✕ Close</Text>
            </Pressable>
          </View>

          <Video
            ref={videoRef}
            source={{ uri: videoUri }}
            style={styles.video}
            resizeMode={ResizeMode.CONTAIN}
            onPlaybackStatusUpdate={handlePlaybackStatusUpdate}
            shouldPlay={false}
            useNativeControls={false}
          />

          <View style={styles.controls}>
            <Text style={styles.timeText}>{formatTime(position)}</Text>

            <View style={styles.scrubberTrack}>
              <View style={[styles.scrubberFill, { flex: progressFraction || 0.001 }]} />
              <View style={{ flex: Math.max(1 - progressFraction, 0.001) }} />
            </View>

            <Text style={styles.timeText}>{formatTime(duration)}</Text>
          </View>

          <Pressable style={styles.playPauseBtn} onPress={togglePlayPause}>
            <Text style={styles.playPauseText}>{isPlaying ? '⏸' : '▶'}</Text>
          </Pressable>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.85)',
    justifyContent: 'flex-end',
  },
  container: {
    backgroundColor: '#0d0d0d',
    borderTopLeftRadius: radius.xl,
    borderTopRightRadius: radius.xl,
    paddingBottom: 40,
    overflow: 'hidden',
  },
  topBar: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.lg,
    paddingBottom: spacing.sm,
    gap: spacing.md,
  },
  topBarLabel: {
    flex: 1,
    fontSize: 14,
    fontWeight: '600',
    color: 'rgba(255,255,255,0.8)',
    lineHeight: 20,
  },
  closeBtn: {
    backgroundColor: 'rgba(255,255,255,0.12)',
    borderRadius: radius.full,
    paddingHorizontal: spacing.md,
    paddingVertical: 6,
  },
  closeBtnText: {
    fontSize: 13,
    color: '#fff',
    fontWeight: '600',
  },
  video: {
    width: '100%',
    height: VIDEO_HEIGHT,
    backgroundColor: '#000',
  },
  controls: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingHorizontal: spacing.lg,
    marginTop: spacing.md,
  },
  timeText: {
    fontSize: 12,
    color: 'rgba(255,255,255,0.6)',
    fontVariant: ['tabular-nums'],
    minWidth: 36,
    textAlign: 'center',
  },
  scrubberTrack: {
    flex: 1,
    height: 4,
    borderRadius: 2,
    backgroundColor: 'rgba(255,255,255,0.2)',
    flexDirection: 'row',
    overflow: 'hidden',
  },
  scrubberFill: {
    height: '100%',
    backgroundColor: colors.brand[400],
    borderRadius: 2,
  },
  playPauseBtn: {
    alignSelf: 'center',
    marginTop: spacing.md,
    width: 56,
    height: 56,
    borderRadius: 28,
    backgroundColor: colors.brand[600],
    alignItems: 'center',
    justifyContent: 'center',
  },
  playPauseText: {
    fontSize: 22,
    color: '#fff',
  },
});
