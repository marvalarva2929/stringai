import React from 'react';
import { PaywallView } from '../paywall/PaywallView';

interface ProStepProps {
  onSkip: () => void;
}

// The Pro upsell inside onboarding — the exact same screen as every other
// subscription prompt in the app (app/paywall.tsx), so it's consistent
// wherever it appears. The close button and the post-purchase "Continue"
// both just advance onboarding instead of navigating back.
export function ProStep({ onSkip }: ProStepProps) {
  return <PaywallView onClose={onSkip} onPurchased={onSkip} />;
}
