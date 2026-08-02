import React from 'react';
import { router } from 'expo-router';
import { PaywallView } from '../src/components/paywall/PaywallView';

export default function Paywall() {
  return <PaywallView onClose={() => router.back()} />;
}
