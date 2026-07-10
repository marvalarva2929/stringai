import React from 'react';
import { useLocalSearchParams } from 'expo-router';
import { useUserStore } from '../../src/store/useUserStore';
import { usePracticePlan } from '../../src/hooks/useDailyPracticePlan';
import { scopeFromParams } from '../../src/lib/practicePlan';
import { PracticePlanView } from '../../src/components/practice/PracticePlanView';

/**
 * A scoped practice plan (piece warm-up or post-session exercises), reached from
 * the home pinned-piece card and the results screen. Daily lives in the Train tab.
 */
export default function ScopedPlanScreen() {
  const params = useLocalSearchParams<{ sessionId?: string; pieceId?: string }>();
  const scope = scopeFromParams(params);
  const plan = usePracticePlan(scope);
  const currentPiece = useUserStore((st) => st.profile?.currentPiece);

  const kicker = scope.kind === 'piece' ? 'Piece warm-up' : 'Session focus';
  const coachMessage = scope.kind === 'piece'
    ? `A few drills from what "${currentPiece?.title ?? 'this piece'}" has needed lately — then play it through.`
    : "Fresh from this recording — clean these up, then record again to see the change.";

  return <PracticePlanView plan={plan} scope={scope} kicker={kicker} coachMessage={coachMessage} />;
}
