import React, { useEffect, useState } from 'react';
import {
  View, Text, Modal, Pressable, StyleSheet, TextInput, Image,
  TouchableWithoutFeedback, KeyboardAvoidingView, Platform,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import * as StoreReview from 'expo-store-review';
import { Linking } from 'react-native';
import { MaestroAvatar } from '../ui/MaestroAvatar';
import { BigButton } from '../ui/BigButton';
import { submitFeedback } from '../../services/feedback';
import { useReviewStore } from '../../store/useReviewStore';
import { haptic } from '../../lib/haptics';
import { colors, spacing, radius } from '../../constants/theme';
import { REVIEW_COPY } from '../../constants/activationContent';
import type { ReviewTrigger } from '../../lib/reviewPrompt';
import { SUPPORT_URL } from '../../constants/links';
import { track } from '../../services/analytics';
import { AnalyticsEvent } from '../../constants/analyticsEvents';

export interface ReviewPromptModalProps {
  visible: boolean;
  /** Where this fired from — recorded with any feedback the user leaves. */
  trigger: ReviewTrigger;
  onClose: () => void;
}

type Pane = 'ask' | 'feedback' | 'thanks';

/**
 * The gated review prompt: our own question first, the native App Store dialog
 * only on a positive answer.
 *
 * iOS allows three `SKStoreReviewController` prompts per user per year and
 * silently ignores the rest, so the one thing this must never do is spend one on
 * someone who is about to write a one-star review. An unhappy answer gets a
 * feedback box instead — which is both kinder and more useful than a rating.
 *
 * Uses the centred fade-popup pattern from app/(tabs)/home.tsx.
 */
export function ReviewPromptModal({ visible, trigger, onClose }: ReviewPromptModalProps) {
  const [pane, setPane] = useState<Pane>('ask');
  const [text, setText] = useState('');
  const setOutcome = useReviewStore((s) => s.setOutcome);

  useEffect(() => {
    if (!visible) return;
    const { promptCount } = useReviewStore.getState();
    track(AnalyticsEvent.REVIEW_PROMPT_SHOWN, { trigger, prompt_count: promptCount });
  }, [visible, trigger]);

  const close = () => {
    onClose();
    // Reset after the dismissal animation so the panes don't visibly snap back.
    setTimeout(() => { setPane('ask'); setText(''); }, 300);
  };

  const onPositive = async () => {
    haptic.success();
    setOutcome('rated');
    track(AnalyticsEvent.REVIEW_PROMPT_RESULT, { trigger, outcome: 'rated' });
    try {
      if (await StoreReview.isAvailableAsync()) {
        await StoreReview.requestReview();
      } else {
        // No in-app dialog available (older OS, or a build the store doesn't
        // know about). Send them somewhere they can still say something.
        Linking.openURL(SUPPORT_URL).catch(() => {});
      }
    } catch {
      // requestReview is best-effort by design — the OS may decline silently.
    }
    close();
  };

  const onNegative = () => {
    haptic.light();
    setPane('feedback');
  };

  const onSend = () => {
    haptic.light();
    setOutcome('feedback');
    track(AnalyticsEvent.REVIEW_PROMPT_RESULT, { trigger, outcome: 'feedback' });
    // Fire-and-forget: someone telling us the app let them down shouldn't then
    // be shown a spinner or an error about it.
    submitFeedback(text, trigger);
    setPane('thanks');
    setTimeout(close, 1400);
  };

  const onDeclineFeedback = () => {
    setOutcome('declined');
    track(AnalyticsEvent.REVIEW_PROMPT_RESULT, { trigger, outcome: 'declined' });
    close();
  };

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={close}>
      <TouchableWithoutFeedback onPress={pane === 'ask' ? close : undefined}>
        <View style={s.backdrop}>
          <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
            <TouchableWithoutFeedback onPress={() => {}}>
              <View style={s.card}>
                {pane === 'ask' && (
                  <>
                    <View style={s.stars} accessibilityRole="image" accessibilityLabel="Five stars">
                      {[0, 1, 2, 3, 4].map((i) => (
                        <Ionicons key={i} name="star" size={26} color="#f5b301" />
                      ))}
                    </View>
                    <Image
                      source={require('../../../assets/review-cat.png')}
                      style={s.cat}
                      resizeMode="contain"
                      accessible={false}
                    />
                    <Text style={s.title}>{REVIEW_COPY.title}</Text>
                    <Text style={s.body}>{REVIEW_COPY.body}</Text>
                    <View style={s.actions}>
                      <BigButton label={REVIEW_COPY.positive} onPress={onPositive} />
                      <BigButton label={REVIEW_COPY.negative} variant="secondary" onPress={onNegative} />
                    </View>
                  </>
                )}

                {pane === 'feedback' && (
                  <>
                    <Text style={s.title}>{REVIEW_COPY.feedbackTitle}</Text>
                    <Text style={s.body}>{REVIEW_COPY.feedbackBody}</Text>
                    <TextInput
                      style={s.input}
                      value={text}
                      onChangeText={setText}
                      placeholder={REVIEW_COPY.feedbackPlaceholder}
                      placeholderTextColor={colors.text.muted}
                      multiline
                      autoFocus
                      maxLength={4000}
                      textAlignVertical="top"
                    />
                    <View style={s.actions}>
                      <BigButton
                        label={REVIEW_COPY.feedbackSend}
                        onPress={onSend}
                        disabled={text.trim().length === 0}
                      />
                      <Pressable onPress={onDeclineFeedback} hitSlop={10} style={s.declineBtn}>
                        <Text style={s.decline}>{REVIEW_COPY.feedbackSkip}</Text>
                      </Pressable>
                    </View>
                  </>
                )}

                {pane === 'thanks' && (
                  <>
                    <MaestroAvatar size="md" />
                    <Text style={s.title}>{REVIEW_COPY.feedbackThanks}</Text>
                  </>
                )}
              </View>
            </TouchableWithoutFeedback>
          </KeyboardAvoidingView>
        </View>
      </TouchableWithoutFeedback>
    </Modal>
  );
}

const s = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.5)',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: spacing.xl,
  },
  card: {
    backgroundColor: '#fff',
    borderRadius: 24,
    padding: spacing.xl,
    alignItems: 'center',
    gap: spacing.sm,
    width: '100%',
    maxWidth: 380,
  },
  stars: { flexDirection: 'row', gap: 4 },
  cat: { width: 132, height: 132, marginTop: spacing.xs },
  title: {
    fontSize: 21,
    fontWeight: '800',
    color: colors.text.primary,
    textAlign: 'center',
    marginTop: spacing.xs,
  },
  body: {
    fontSize: 14,
    lineHeight: 20,
    color: colors.text.secondary,
    textAlign: 'center',
  },
  input: {
    alignSelf: 'stretch',
    minHeight: 96,
    borderWidth: 1.5,
    borderColor: '#e5e7eb',
    borderRadius: radius.lg,
    padding: spacing.md,
    fontSize: 15,
    color: colors.text.primary,
    marginTop: spacing.xs,
  },
  actions: { alignSelf: 'stretch', gap: spacing.sm, marginTop: spacing.md },
  declineBtn: { alignSelf: 'center', paddingVertical: spacing.xs },
  decline: { fontSize: 14, color: colors.text.muted, fontWeight: '600' },
});
