import React, { useState } from 'react';
import { View, Text, Pressable, StyleSheet, Switch, Alert, Linking } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { router } from 'expo-router';
import { useReminderStore } from '../src/store/useReminderStore';
import { ensureReminderPermission } from '../src/lib/notifications';
import { ReminderTimeChips } from '../src/components/onboarding/ReminderTimeChips';
import { BigButton } from '../src/components/ui/BigButton';
import { haptic } from '../src/lib/haptics';
import { colors, spacing } from '../src/constants/theme';

export default function RemindersModal() {
  const { enabled, hour, minute, enable, disable } = useReminderStore();
  const [draftEnabled, setDraftEnabled] = useState(enabled);
  const [draftHour, setDraftHour] = useState(hour);
  const [draftMinute, setDraftMinute] = useState(minute);
  const [saving, setSaving] = useState(false);

  const save = async () => {
    haptic.light();
    setSaving(true);
    try {
      if (draftEnabled) {
        const granted = await ensureReminderPermission();
        if (!granted) {
          Alert.alert(
            'Notifications disabled',
            'Enable notifications for StringAI in system settings to get practice reminders.',
            [
              { text: 'Cancel', style: 'cancel' },
              { text: 'Open Settings', onPress: () => Linking.openSettings() },
            ],
          );
          return;
        }
        await enable(draftHour, draftMinute);
      } else {
        await disable();
      }
      router.back();
    } finally {
      setSaving(false);
    }
  };

  return (
    <LinearGradient
      colors={[colors.brand[900], colors.brand[700], colors.brand[500]]}
      style={styles.container}
    >
      <Pressable onPress={() => router.back()} style={styles.closeBtn}>
        <Text style={styles.closeText}>✕</Text>
      </Pressable>

      <View style={styles.content}>
        <Text style={styles.title}>Practice Reminders</Text>
        <Text style={styles.subtitle}>One gentle daily nudge at a time you choose.</Text>

        <View style={styles.toggleRow}>
          <Text style={styles.toggleLabel}>Daily reminder</Text>
          <Switch
            value={draftEnabled}
            onValueChange={(v) => { haptic.light(); setDraftEnabled(v); }}
            trackColor={{ false: 'rgba(255,255,255,0.2)', true: colors.brand[400] }}
            thumbColor="#fff"
          />
        </View>

        {draftEnabled && (
          <ReminderTimeChips
            hour={draftHour}
            minute={draftMinute}
            onSelect={(h, m) => { setDraftHour(h); setDraftMinute(m); }}
          />
        )}
      </View>

      <View style={styles.footer}>
        <BigButton label="Save" onPress={save} disabled={saving} />
      </View>
    </LinearGradient>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  closeBtn: { position: 'absolute', top: 24, right: 20, zIndex: 10, padding: 8 },
  closeText: { color: 'rgba(255,255,255,0.65)', fontSize: 18 },
  content: {
    flex: 1,
    paddingHorizontal: spacing.xl,
    paddingTop: 72,
    gap: spacing.md,
  },
  title: {
    fontSize: 28,
    fontWeight: '700',
    color: '#fff',
    textAlign: 'center',
    marginBottom: 4,
  },
  subtitle: {
    fontSize: 14,
    color: 'rgba(255,255,255,0.7)',
    textAlign: 'center',
    lineHeight: 20,
    marginBottom: spacing.sm,
  },
  toggleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: spacing.sm,
  },
  toggleLabel: { fontSize: 16, fontWeight: '600', color: '#fff' },
  footer: {
    paddingHorizontal: spacing.xl,
    paddingBottom: 48,
    paddingTop: spacing.md,
  },
});
