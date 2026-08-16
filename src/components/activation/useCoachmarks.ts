import { useCallback, useEffect, useRef, useState } from 'react';
import { useActivationStore } from '../../store/useActivationStore';
import { AnalyticsEvent } from '../../constants/analyticsEvents';
import { track } from '../../services/analytics';
import type { SpotlightStep } from '../../constants/activationScript';

/**
 * Which script is running, taken from the shared prefix of its target ids
 * (`home.plan` → `home`). Derived rather than passed so no call site has to
 * repeat a name that is already in the script.
 */
const scriptName = (steps: SpotlightStep[]): string =>
  steps[0]?.targetId.split('.')[0] ?? 'unknown';

/**
 * Drives one run of coachmarks on a screen.
 *
 * Skipping ends activation but deliberately does NOT navigate — throwing
 * someone out of their own results screen because they dismissed a tooltip
 * would be worse than the tooltip was.
 */
export function useCoachmarks(
  steps: SpotlightStep[],
  active: boolean,
  onFinish: () => void,
) {
  const [index, setIndex] = useState(0);
  // Mirrors `index` so advancing can read it synchronously. The finish callback
  // must NOT live inside a setState updater — React is free to run those twice,
  // and these callbacks navigate, load the demo and record a review prompt.
  const indexRef = useRef(0);
  // onFinish is usually an inline arrow at the call site; hold it in a ref so
  // advancing doesn't depend on the caller memoizing it.
  const finishRef = useRef(onFinish);
  finishRef.current = onFinish;
  const finishedRef = useRef(false);

  // Restart from the top whenever a run begins, so re-entering a screen mid-flow
  // doesn't resume at a step whose target is gone.
  useEffect(() => {
    if (!active) return;
    indexRef.current = 0;
    finishedRef.current = false;
    setIndex(0);
  }, [active]);

  const next = useCallback(() => {
    if (indexRef.current + 1 >= steps.length) {
      // A double tap on the last step's button would otherwise finish twice.
      if (finishedRef.current) return;
      finishedRef.current = true;
      finishRef.current();
      return;
    }
    indexRef.current += 1;
    setIndex(indexRef.current);
  }, [steps.length]);

  const skip = useCallback(() => {
    track(AnalyticsEvent.COACHMARK_SKIP, {
      script: scriptName(steps),
      step_id: steps[indexRef.current]?.id,
      index: indexRef.current,
    });
    useActivationStore.getState().dismiss();
  }, [steps]);

  const activeIndex = active ? index : -1;

  // Per-coachmark impressions. Together with coachmark_skip these localise a
  // drop-off to the exact tooltip, which the step-level funnel cannot do.
  useEffect(() => {
    if (activeIndex < 0) return;
    const step = steps[activeIndex];
    if (!step) return;
    track(AnalyticsEvent.COACHMARK_VIEW, {
      script: scriptName(steps),
      step_id: step.id,
      index: activeIndex,
    });
  }, [activeIndex, steps]);

  return {
    index: activeIndex,
    /** The step currently on screen, so a host can react to it (e.g. scroll to its page). */
    step: activeIndex >= 0 ? steps[activeIndex] : null,
    next,
    skip,
  };
}
