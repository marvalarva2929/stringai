import { useCallback, useState } from 'react';
import { useReviewStore } from '../../store/useReviewStore';
import { useAnalysisStore } from '../../store/useAnalysisStore';
import { shouldPromptForReview, type ReviewTrigger } from '../../lib/reviewPrompt';

/**
 * The reusable half of the review pipeline: decide whether to ask, and hold the
 * modal's visibility.
 *
 * Deliberately not activation-specific. Activation is only the *first* moment
 * worth asking at — a cleared practice plan or a streak milestone are the same
 * shape of moment, and they should all go through the same rules in
 * src/lib/reviewPrompt.ts rather than each screen inventing its own.
 *
 *   const review = useReviewPrompt('practice_complete');
 *   useEffect(() => { review.maybeAsk(); }, []);
 *   <ReviewPromptModal visible={review.visible} trigger={...} onClose={review.close} />
 */
export function useReviewPrompt(trigger: ReviewTrigger) {
  const [visible, setVisible] = useState(false);
  const markPrompted = useReviewStore((s) => s.markPrompted);
  const sessionCount = useAnalysisStore((s) => s.sessionHistory.length);

  /** Asks if the rules allow it. Returns whether the prompt was shown. */
  const maybeAsk = useCallback((): boolean => {
    const { promptCount, lastPromptedAt, outcome } = useReviewStore.getState();
    const allowed = shouldPromptForReview(
      { promptCount, lastPromptedAt, outcome },
      { sessionCount, trigger },
    );
    if (!allowed) return false;
    markPrompted();
    setVisible(true);
    return true;
  }, [markPrompted, sessionCount, trigger]);

  const close = useCallback(() => setVisible(false), []);

  return { visible, maybeAsk, close };
}
