import React, { useEffect, useState } from 'react';
import { View, Text, Pressable, StyleSheet, Alert } from 'react-native';
import { fetchAppInstanceId, isAnalyticsConfigured } from '../../services/analytics';
import {
  forceTestCrash,
  isCrashReportingConfigured,
  reportError,
} from '../../services/crashReporting';
import { getCachedAttStatus, requestTrackingPermission } from '../../services/trackingPermission';
import { colors, spacing, radius } from '../../constants/theme';

/**
 * Firebase status and test triggers, for app/debug.tsx.
 *
 * "Is Firebase actually on?" is otherwise unanswerable from inside the app —
 * every telemetry call no-ops silently when GoogleService-Info.plist is missing,
 * which is exactly the failure this panel exists to make visible.
 *
 * The app instance id is shown because the RevenueCat → Firebase integration
 * depends on it: if it is blank, RevenueCat's server-side subscription events
 * can never be matched to a GA4 user and churn reporting stays empty.
 */
export function TelemetryDebugPanel() {
  const [instanceId, setInstanceId] = useState<string | null>(null);
  const [att, setAtt] = useState(getCachedAttStatus());

  useEffect(() => {
    fetchAppInstanceId().then(setInstanceId).catch(() => {});
  }, []);

  const testNonFatal = () => {
    reportError(new Error('Debug panel test non-fatal'), 'debug', { source: 'debug_panel' });
    Alert.alert('Sent', 'Non-fatal recorded. Crashlytics batches these — expect it within a few minutes, after the next app launch.');
  };

  const testCrash = () => {
    Alert.alert(
      'Force a crash?',
      'The app will terminate. Note that expo-dev-client intercepts native crashes — this only reaches Crashlytics in a release build.',
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Crash', style: 'destructive', onPress: forceTestCrash },
      ],
    );
  };

  const askAtt = async () => setAtt(await requestTrackingPermission());

  return (
    <View style={s.box}>
      <Text style={s.title}>Firebase Telemetry</Text>

      <Row label="Analytics" value={isAnalyticsConfigured ? 'configured' : 'NOT configured'} bad={!isAnalyticsConfigured} />
      <Row label="Crashlytics" value={isCrashReportingConfigured ? 'configured' : 'NOT configured'} bad={!isCrashReportingConfigured} />
      <Row label="ATT status" value={att} />
      <Row label="App instance id" value={instanceId ?? '—'} bad={!instanceId} />

      {!isAnalyticsConfigured && (
        <Text style={s.hint}>Add GoogleService-Info.plist to the Xcode target — see docs/FIREBASE_SETUP.md</Text>
      )}

      <View style={s.divider} />

      <View style={s.btnRow}>
        <Pressable style={s.btn} onPress={testNonFatal}>
          <Text style={s.btnText}>Test non-fatal</Text>
        </Pressable>
        <Pressable style={s.btn} onPress={askAtt}>
          <Text style={s.btnText}>Ask ATT</Text>
        </Pressable>
        <Pressable style={[s.btn, s.btnDanger]} onPress={testCrash}>
          <Text style={s.btnText}>Force crash</Text>
        </Pressable>
      </View>
    </View>
  );
}

function Row({ label, value, bad }: { label: string; value: string; bad?: boolean }) {
  return (
    <View style={s.row}>
      <Text style={s.rowLabel}>{label}</Text>
      <Text style={[s.rowValue, bad && s.rowValueBad]} numberOfLines={1}>{value}</Text>
    </View>
  );
}

const s = StyleSheet.create({
  box: { backgroundColor: '#1e1b3a', borderRadius: radius.md, padding: spacing.md, gap: 4 },
  title: {
    fontSize: 11,
    fontWeight: '700',
    color: 'rgba(255,255,255,0.4)',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginBottom: 4,
  },
  row: { flexDirection: 'row', justifyContent: 'space-between', gap: spacing.sm },
  rowLabel: { fontSize: 12, color: 'rgba(255,255,255,0.45)', flex: 1 },
  rowValue: {
    fontSize: 12,
    color: 'rgba(255,255,255,0.85)',
    fontVariant: ['tabular-nums'],
    textAlign: 'right',
    flexShrink: 1,
  },
  rowValueBad: { color: '#f87171' },
  hint: { fontSize: 11, color: '#fbbf24', marginTop: 4 },
  divider: { height: StyleSheet.hairlineWidth, backgroundColor: 'rgba(255,255,255,0.08)', marginVertical: spacing.xs },
  btnRow: { flexDirection: 'row', gap: spacing.xs },
  btn: {
    flex: 1,
    backgroundColor: colors.brand[600],
    borderRadius: radius.sm,
    paddingVertical: 8,
    alignItems: 'center',
  },
  btnDanger: { backgroundColor: '#b91c1c' },
  btnText: { color: '#fff', fontWeight: '700', fontSize: 12 },
});
