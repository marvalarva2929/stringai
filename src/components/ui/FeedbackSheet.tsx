import React, { useState } from 'react';
import {
  Modal,
  View,
  Text,
  TextInput,
  Pressable,
  StyleSheet,
  ScrollView,
  KeyboardAvoidingView,
  Platform,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { colors, spacing, radius } from '../../constants/theme';
import { Button } from './Button';
import { submitFeedback } from '../../services/feedback';
import { haptic } from '../../lib/haptics';

/**
 * A direct line to the developer, from Settings.
 *
 * `submitFeedback` already existed but had exactly one entry point: the unhappy
 * branch of the review prompt, which fires at most three times a year and only
 * for users who were asked. Anyone who simply wanted to report something had
 * nowhere to go.
 *
 * This is worth more than its size suggests. At the scale a solo developer
 * launches at, replying personally to every message is achievable, and it is
 * the strongest retention mechanic available — it is also the only channel that
 * catches "the app said my F# was flat and it wasn't", which is the failure
 * mode that quietly costs the most and never appears in analytics.
 */
export function FeedbackSheet({ visible, onClose }: { visible: boolean; onClose: () => void }) {
  const insets = useSafeAreaInsets();
  const [message, setMessage] = useState('');
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);

  const close = () => {
    onClose();
    // Reset after the dismissal animation, so the form doesn't visibly wipe
    // itself on the way out.
    setTimeout(() => { setMessage(''); setSent(false); }, 300);
  };

  const send = async () => {
    if (!message.trim() || sending) return;
    haptic.light();
    setSending(true);
    // submitFeedback is fire-and-forget by design and swallows its own
    // failures — someone telling us the app disappointed them should not then
    // be shown an error dialog about it. It falls back to a mail draft when
    // there's no account to insert against.
    await submitFeedback(message, 'settings');
    setSending(false);
    setSent(true);
  };

  return (
    <Modal visible={visible} animationType="slide" presentationStyle="pageSheet" onRequestClose={close}>
      <KeyboardAvoidingView
        style={styles.flex}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <ScrollView
          style={styles.flex}
          contentContainerStyle={[styles.body, { paddingTop: insets.top + spacing.lg }]}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
        >
          <View style={styles.headerRow}>
            <Text style={styles.title}>{sent ? 'Thank you' : 'Send feedback'}</Text>
            <Pressable onPress={close} hitSlop={12}>
              <Text style={styles.close}>{sent ? 'Done' : 'Cancel'}</Text>
            </Pressable>
          </View>

          {sent ? (
            <Text style={styles.subtitle}>
              This goes straight to me and I read every one. If it needs a reply, I'll get back to
              you.
            </Text>
          ) : (
            <>
              <Text style={styles.subtitle}>
                This goes straight to the developer — not a support queue. Bugs, requests, or a
                measurement that looked wrong: all of it is useful, especially the last one.
              </Text>
              <TextInput
                style={styles.input}
                value={message}
                onChangeText={setMessage}
                multiline
                textAlignVertical="top"
                autoFocus
                placeholder="What's on your mind?"
                placeholderTextColor={colors.text.muted}
                maxLength={4000}
              />
              <Button
                label="Send"
                onPress={send}
                loading={sending}
                disabled={!message.trim()}
                fullWidth
                size="lg"
              />
            </>
          )}
        </ScrollView>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1, backgroundColor: colors.background },
  body: { paddingHorizontal: spacing.xl, paddingBottom: spacing.xxl, gap: spacing.md },
  headerRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  title: { fontSize: 24, fontWeight: '800', color: colors.text.primary },
  close: { fontSize: 15, fontWeight: '700', color: colors.brand[600] },
  subtitle: { fontSize: 14, color: colors.text.secondary, lineHeight: 20 },
  input: {
    backgroundColor: '#fff',
    borderRadius: radius.md,
    padding: spacing.md,
    minHeight: 160,
    color: colors.text.primary,
    fontSize: 15,
    lineHeight: 21,
    borderWidth: 1,
    borderColor: '#e5e7eb',
  },
});
