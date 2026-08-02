import React, { useState, useRef } from 'react';
import {
  View,
  Text,
  StyleSheet,
  Pressable,
  ScrollView,
  TextInput,
  KeyboardAvoidingView,
  Platform,
  ActivityIndicator,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';
import { useAnalysisStore } from '../src/store/useAnalysisStore';
import { useEntitlementStore } from '../src/store/useEntitlementStore';
import { canUseLlmCoaching } from '../src/lib/entitlements';
import { fetchChatReply, ChatMessage } from '../src/services/sessionChat';
import { EntitlementRequiredError } from '../src/services/llmFeedback';
import { Button } from '../src/components/ui/Button';
import { colors, spacing, radius } from '../src/constants/theme';

type Bubble = ChatMessage & { id: string; upsell?: boolean };

const UPSELL_MESSAGE =
  'Chat coaching is a Pro feature — upgrade to get tailored feedback from Claude based on your session history.';

function greeting(sessionCount: number): string {
  if (sessionCount === 0) {
    return "Hi! I'm your practice coach. Record a session and I'll be able to talk through your specific trends — for now, ask me anything about violin technique.";
  }
  return `Hi! I can see your last ${Math.min(sessionCount, 20)} session${sessionCount === 1 ? '' : 's'}. Ask me about a trend, a piece, or what to focus on next.`;
}

export default function ChatScreen() {
  const sessionHistory = useAnalysisStore((s) => s.sessionHistory);
  const entitlement = useEntitlementStore((s) => s.entitlement);
  const isPro = canUseLlmCoaching(entitlement);

  const [messages, setMessages] = useState<Bubble[]>(() => [
    { id: 'greeting', role: 'assistant', content: greeting(sessionHistory.length) },
    ...(isPro ? [] : [{ id: 'upsell', role: 'assistant' as const, content: UPSELL_MESSAGE, upsell: true }]),
  ]);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const scrollRef = useRef<ScrollView>(null);

  const send = async () => {
    const text = input.trim();
    if (!text || sending) return;

    const userMsg: Bubble = { id: `u-${Date.now()}`, role: 'user', content: text };
    const nextMessages = [...messages, userMsg];
    setMessages(nextMessages);
    setInput('');
    setSending(true);

    try {
      const reply = await fetchChatReply(
        nextMessages.map(({ role, content }) => ({ role, content })),
        sessionHistory,
      );
      setMessages((prev) => [...prev, { id: `a-${Date.now()}`, role: 'assistant', content: reply }]);
    } catch (err) {
      if (err instanceof EntitlementRequiredError) {
        setMessages((prev) => [
          ...prev,
          { id: `upsell-${Date.now()}`, role: 'assistant', content: UPSELL_MESSAGE, upsell: true },
        ]);
      } else {
        setMessages((prev) => [
          ...prev,
          { id: `err-${Date.now()}`, role: 'assistant', content: "Something went wrong reaching your coach. Give it another try." },
        ]);
      }
    } finally {
      setSending(false);
    }
  };

  return (
    <SafeAreaView style={s.safe} edges={['top', 'bottom']}>
      <View style={s.header}>
        <Pressable onPress={() => router.back()} hitSlop={12} style={s.backBtn}>
          <Ionicons name="chevron-back" size={26} color={colors.text.primary} />
        </Pressable>
        <Text style={s.headerTitle}>Ask Your Coach</Text>
        <View style={s.backBtn} />
      </View>

      <KeyboardAvoidingView
        style={s.flex}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        keyboardVerticalOffset={Platform.OS === 'ios' ? 90 : 0}
      >
        <ScrollView
          ref={scrollRef}
          contentContainerStyle={s.scroll}
          onContentSizeChange={() => scrollRef.current?.scrollToEnd({ animated: true })}
        >
          {messages.map((m) => (
            <View
              key={m.id}
              style={[s.bubbleRow, m.role === 'user' ? s.bubbleRowUser : s.bubbleRowAssistant]}
            >
              <View style={[s.bubble, m.role === 'user' ? s.bubbleUser : s.bubbleAssistant]}>
                <Text style={[s.bubbleText, m.role === 'user' && s.bubbleTextUser]}>{m.content}</Text>
                {m.upsell && (
                  <Button
                    label="Upgrade to Pro"
                    size="sm"
                    onPress={() => router.push('/paywall')}
                    fullWidth
                  />
                )}
              </View>
            </View>
          ))}
          {sending && (
            <View style={[s.bubbleRow, s.bubbleRowAssistant]}>
              <View style={[s.bubble, s.bubbleAssistant]}>
                <ActivityIndicator size="small" color={colors.brand[600]} />
              </View>
            </View>
          )}
        </ScrollView>

        <View style={s.inputRow}>
          {isPro ? (
            <>
              <TextInput
                style={s.input}
                value={input}
                onChangeText={setInput}
                placeholder="Ask about your practice…"
                placeholderTextColor={colors.text.muted}
                multiline
                editable={!sending}
              />
              <Pressable
                style={[s.sendBtn, (!input.trim() || sending) && s.sendBtnDisabled]}
                onPress={send}
                disabled={!input.trim() || sending}
              >
                <Ionicons name="arrow-up" size={20} color="#fff" />
              </Pressable>
            </>
          ) : (
            <Button label="Upgrade to Pro" fullWidth onPress={() => router.push('/paywall')} />
          )}
        </View>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const s = StyleSheet.create({
  safe: { flex: 1, backgroundColor: '#fff' },
  flex: { flex: 1 },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.sm,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#e5e7eb',
  },
  backBtn: { width: 40, height: 40, alignItems: 'center', justifyContent: 'center' },
  headerTitle: { fontSize: 17, fontWeight: '700', color: colors.text.primary },

  scroll: {
    padding: spacing.lg,
    gap: spacing.sm,
  },
  bubbleRow: { flexDirection: 'row' },
  bubbleRowUser: { justifyContent: 'flex-end' },
  bubbleRowAssistant: { justifyContent: 'flex-start' },
  bubble: {
    maxWidth: '82%',
    borderRadius: radius.xl,
    paddingHorizontal: 14,
    paddingVertical: 10,
    gap: spacing.sm,
  },
  bubbleAssistant: {
    backgroundColor: '#f3f4f6',
    borderBottomLeftRadius: 4,
  },
  bubbleUser: {
    backgroundColor: colors.brand[600],
    borderBottomRightRadius: 4,
  },
  bubbleText: { fontSize: 15, lineHeight: 21, color: colors.text.primary },
  bubbleTextUser: { color: '#fff' },

  inputRow: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: spacing.sm,
    padding: spacing.md,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: '#e5e7eb',
  },
  input: {
    flex: 1,
    maxHeight: 110,
    backgroundColor: '#f3f4f6',
    borderRadius: radius.xl,
    paddingHorizontal: 14,
    paddingVertical: 10,
    fontSize: 15,
    color: colors.text.primary,
  },
  sendBtn: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: colors.brand[600],
    alignItems: 'center',
    justifyContent: 'center',
  },
  sendBtnDisabled: { opacity: 0.4 },
});
