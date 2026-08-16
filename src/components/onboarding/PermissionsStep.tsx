import React from 'react';
import { View, Text, Pressable, StyleSheet, Switch } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useCameraPermissions, useMicrophonePermissions } from 'expo-camera';
import { Ionicons } from '@expo/vector-icons';
import { colors, spacing, radius } from '../../constants/theme';
import { haptic } from '../../lib/haptics';
import { STEP_COPY } from '../../constants/onboardingContent';
import { AnalyticsEvent } from '../../constants/analyticsEvents';
import { track } from '../../services/analytics';
import { requestTrackingPermission } from '../../services/trackingPermission';
import { ReminderTimeChips } from './ReminderTimeChips';

interface PermissionsStepProps {
  reminderEnabled: boolean;
  onReminderEnabledChange: (enabled: boolean) => void;
  reminderHour: number;
  reminderMinute: number;
  onReminderTimeChange: (hour: number, minute: number) => void;
}

export function PermissionsStep({
  reminderEnabled,
  onReminderEnabledChange,
  reminderHour,
  reminderMinute,
  onReminderTimeChange,
}: PermissionsStepProps) {
  const insets = useSafeAreaInsets();
  const [cameraPermission, requestCameraPermission] = useCameraPermissions();
  const [micPermission, requestMicPermission] = useMicrophonePermissions();

  const cameraGranted = cameraPermission?.granted ?? false;
  const micGranted = micPermission?.granted ?? false;
  const bothGranted = cameraGranted && micGranted;

  const requestBoth = async () => {
    haptic.light();
    if (!cameraGranted) {
      const res = await requestCameraPermission();
      track(AnalyticsEvent.ONBOARDING_PERMISSION_RESULT, {
        permission: 'camera',
        granted: res.granted,
      });
    }
    if (!micGranted) {
      const res = await requestMicPermission();
      track(AnalyticsEvent.ONBOARDING_PERMISSION_RESULT, {
        permission: 'microphone',
        granted: res.granted,
      });
    }
    // ATT rides on the same tap, after the two permissions the user actually
    // came here for. Prompting cold on first launch is the version people
    // dismiss reflexively, and Apple requires the prompt to appear at all.
    const att = await requestTrackingPermission();
    track(AnalyticsEvent.ONBOARDING_PERMISSION_RESULT, {
      permission: 'att',
      granted: att === 'granted',
      status: att,
    });
  };

  return (
    <View style={[styles.container, { paddingTop: insets.top + spacing.xl }]}>
      <Text style={styles.title}>{STEP_COPY.permissions.title}</Text>
      <Text style={styles.subtitle}>{STEP_COPY.permissions.subtitle}</Text>

      <Pressable
        style={[styles.permCard, bothGranted && styles.permCardGranted]}
        onPress={requestBoth}
        disabled={bothGranted}
      >
        <View style={[styles.permIconWrap, bothGranted && styles.permIconWrapGranted]}>
          <Ionicons
            name={bothGranted ? 'checkmark-circle-outline' : 'videocam-outline'}
            size={26}
            color={bothGranted ? '#fff' : colors.brand[600]}
          />
        </View>
        <View style={styles.permText}>
          <Text style={[styles.permTitle, bothGranted && styles.permTitleGranted]}>
            {bothGranted ? 'Camera & microphone enabled' : 'Allow camera & microphone access'}
          </Text>
          {!bothGranted && (
            <Text style={styles.permSub}>Needed to record and analyze your playing.</Text>
          )}
        </View>
      </Pressable>

      <View style={styles.divider} />

      <Text style={styles.title}>{STEP_COPY.permissions.reminderTitle}</Text>
      <Text style={styles.subtitle}>{STEP_COPY.permissions.reminderSubtitle}</Text>

      <View style={styles.reminderRow}>
        <Text style={styles.reminderLabel}>Daily reminder</Text>
        <Switch
          value={reminderEnabled}
          onValueChange={(v) => { haptic.light(); onReminderEnabledChange(v); }}
          trackColor={{ false: '#e5e7eb', true: colors.brand[400] }}
          thumbColor="#fff"
        />
      </View>

      {reminderEnabled && (
        <ReminderTimeChips light hour={reminderHour} minute={reminderMinute} onSelect={onReminderTimeChange} />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, paddingHorizontal: spacing.xl, gap: spacing.sm },
  title: { fontSize: 20, fontWeight: '700', color: colors.text.primary, marginTop: spacing.md },
  subtitle: { fontSize: 13, color: colors.text.secondary, lineHeight: 18, marginBottom: spacing.sm },
  permCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    backgroundColor: '#fff',
    borderRadius: radius.lg,
    borderWidth: 2,
    borderColor: colors.brand[400],
    padding: spacing.md,
  },
  permCardGranted: {
    backgroundColor: colors.brand[50],
    borderColor: colors.brand[600],
  },
  permIconWrap: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: colors.brand[50],
    alignItems: 'center',
    justifyContent: 'center',
  },
  permIconWrapGranted: { backgroundColor: colors.brand[600] },
  permText: { flex: 1 },
  permTitle: { fontSize: 15, fontWeight: '700', color: colors.text.primary },
  permTitleGranted: { color: colors.brand[700] },
  permSub: { fontSize: 12, color: colors.text.muted, marginTop: 2 },
  divider: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: '#e5e7eb',
    marginVertical: spacing.md,
  },
  reminderRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: spacing.sm,
  },
  reminderLabel: { fontSize: 15, fontWeight: '600', color: colors.text.primary },
});
