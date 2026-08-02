import React from 'react';
import { useDailyPracticePlan } from '../../src/hooks/useDailyPracticePlan';
import { PracticePlanView } from '../../src/components/practice/PracticePlanView';

export default function TrainScreen() {
  const plan = useDailyPracticePlan();
  const isColdStart = plan.sourceSessionIds.length === 0;
  return (
    <PracticePlanView
      plan={plan}
      scope={{ kind: 'daily' }}
      kicker="Daily Warm-Up"
      coachMessage={
        isColdStart
          ? "Record a session and I'll tailor this warm-up to your playing."
          : 'Built from your recent sessions — I grade every take.'
      }
    />
  );
}
