import React, { useEffect, useRef } from 'react';
import { useReviewPrompt } from './useReviewPrompt';
import { ReviewPromptModal } from './ReviewPromptModal';
import { useReviewStore } from '../../store/useReviewStore';

/** Matches the pause used after a completed practice plan. */
const REVIEW_DELAY_MS = 2500;

/**
 * Asks for a review once the user has subscribed.
 *
 * Lives at the root rather than on a screen because there is no single screen
 * to hang it on. Purchasing doesn't navigate anywhere — SubscribeGate is an
 * overlay, so when the entitlement lands the gate simply disappears and the
 * user is left on whatever was underneath (the practice plan, the completion
 * screen, or home, depending on where activation ended). Hosting this at the
 * root means the ask fires wherever they land, and only needs wiring once.
 *
 * The paywall raises a persisted flag instead of asking directly: AccountStep
 * is presented immediately after a purchase, and stacking two modals on the
 * highest-intent moment of the funnel loses both.
 */
export function SubscribedReviewHost({ blocked }: { blocked: boolean }) {
  const review = useReviewPrompt('subscribed');
  const pending = useReviewStore((s) => s.pendingSubscribedReview);
  const askedRef = useRef(false);

  useEffect(() => {
    // Never over another wall. The paywall, because a user who hasn't cleared
    // it hasn't subscribed and a stale flag must not surface on top of it; the
    // account gate, because that is the modal this ask is deliberately queued
    // behind.
    if (blocked || !pending || askedRef.current) return;
    askedRef.current = true;

    // Long enough for the purchase alert to dismiss and the account step to
    // settle, so the ask reads as a separate beat rather than part of checkout.
    const t = setTimeout(() => {
      if (useReviewStore.getState().takeSubscribedReviewFlag()) review.maybeAsk();
    }, REVIEW_DELAY_MS);
    return () => clearTimeout(t);
  }, [blocked, pending, review]);

  return (
    <ReviewPromptModal visible={review.visible} trigger="subscribed" onClose={review.close} />
  );
}
