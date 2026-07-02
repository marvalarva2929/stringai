import React from 'react';
import { View, Text, Pressable, StyleSheet, SafeAreaView } from 'react-native';
import { useLocalSearchParams, router } from 'expo-router';
import { useAnalysisStore } from '../../src/store/useAnalysisStore';
import { useAuthStore } from '../../src/store/useAuthStore';
import { ResultsCarousel } from '../../src/components/analysis/ResultsCarousel';
import { colors, spacing } from '../../src/constants/theme';
import { Button } from '../../src/components/ui/Button';

export default function SessionDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const sessionResultCache = useAnalysisStore((s) => s.sessionResultCache);
  const result = sessionResultCache[id];
  const { isAuthenticated } = useAuthStore();

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
      onDone={() => router.back()}
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
