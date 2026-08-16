import React from 'react';
import { useLocalSearchParams } from 'expo-router';
import { useUserStore } from '../../src/store/useUserStore';
import { usePracticePlan } from '../../src/hooks/useDailyPracticePlan';
import { scopeFromParams } from '../../src/lib/practicePlan';
import { PracticePlanView } from '../../src/components/practice/PracticePlanView';

/**
 * A scoped practice plan (piece warm-up or post-session curated exercises),
 * reached from the home pinned-piece card and the results screen. Daily lives
 * in the Train tab.
 */
export default function ScopedPlanScreen() {
  const params = useLocalSearchParams<{ sessionId?: string; pieceId?: string }>();
  const scope = scopeFromParams(params);
  const plan = usePracticePlan(scope);
  const currentPiece = useUserStore((st) => st.profile?.currentPiece);

  if (scope.kind === 'session') {
    return (
      <PracticePlanView
        plan={plan}
        scope={scope}
        kicker="Practice session"
        title="Curated exercises"
        coachMessage="Picked from this recording to get better at this piece — clear them, then record again."
      />
    );
  }

  return (
    <PracticePlanView
      plan={plan}
      scope={scope}
      kicker="Piece warm-up"
      coachMessage={`A few exercises from what "${currentPiece?.title ?? 'this piece'}" has needed lately — then play it through.`}
    />
  );
}
