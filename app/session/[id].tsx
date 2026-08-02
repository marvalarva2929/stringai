import React, { useEffect, useState } from 'react';
import { View, Text, Pressable, StyleSheet, SafeAreaView, ActivityIndicator } from 'react-native';
import { useLocalSearchParams, router } from 'expo-router';
import { useAnalysisStore } from '../../src/store/useAnalysisStore';
import { useAuthStore } from '../../src/store/useAuthStore';
import { ResultsCarousel } from '../../src/components/analysis/ResultsCarousel';
import { colors, spacing } from '../../src/constants/theme';
import { Button } from '../../src/components/ui/Button';
import { fetchSessionResult } from '../../src/services/analysis';
import { isSupabaseConfigured } from '../../src/services/supabase';

export default function SessionDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const sessionResultCache = useAnalysisStore((s) => s.sessionResultCache);
  const cacheSessionResult = useAnalysisStore((s) => s.cacheSessionResult);
  const result = sessionResultCache[id];
  const { isAuthenticated } = useAuthStore();

  // Cache miss (session from a previous app run) → reconstruct from Supabase.
  // The fetched result is degraded (no video/noteEvents) but scores render.
  const canFetch = !result && isAuthenticated && isSupabaseConfigured;
  const [fetching, setFetching] = useState(canFetch);

  useEffect(() => {
    if (!canFetch) return;
    let cancelled = false;
    fetchSessionResult(id)
      .then((fetched) => {
        if (!cancelled && fetched) cacheSessionResult(fetched);
      })
      .catch(() => {})
      .finally(() => {
        if (!cancelled) setFetching(false);
      });
    return () => { cancelled = true; };
  }, [id, canFetch]);

  if (!result && fetching) {
    return (
      <SafeAreaView style={styles.safe}>
        <View style={styles.emptyState}>
          <ActivityIndicator color={colors.brand[600]} />
        </View>
      </SafeAreaView>
    );
  }

  if (!result) {
    return (
      <SafeAreaView style={styles.safe}>
        <Pressable style={styles.backBtn} onPress={() => router.back()}>
          <Text style={styles.backText}>← Back</Text>
        </Pressable>
        <View style={styles.emptyState}>
          <Text style={styles.emptyTitle}>Session not available</Text>
          <Text style={styles.emptyBody}>
            Session details are stored temporarily while the app is open. Sign in to save and revisit past sessions.
          </Text>
          {!isAuthenticated && (
            <Button
              label="Sign In / Create Account"
              onPress={() => router.push('/(auth)/login')}
              variant="outline"
              size="md"
            />
          )}
        </View>
      </SafeAreaView>
    );
  }

  return (
    <ResultsCarousel
      result={result}
      onDone={() => router.push({ pathname: '/practice/plan', params: { sessionId: result.sessionId } })}
      onHome={() => router.back()}
    />
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.background },
  backBtn: { paddingVertical: 6, paddingHorizontal: spacing.xl },
  backText: { color: colors.brand[600], fontSize: 14, fontWeight: '500' },
  emptyState: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: spacing.xl, gap: spacing.md },
  emptyTitle: { fontSize: 17, fontWeight: '700', color: colors.text.primary },
  emptyBody: { fontSize: 14, color: colors.text.secondary, textAlign: 'center', lineHeight: 21 },
});
