import React, { useEffect, useState, useRef } from 'react';
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
import { fetchChatReply, fetchChatHistory, ChatMessage } from '../src/services/sessionChat';
import { useCoachContext } from '../src/hooks/useCoachContext';
import { EntitlementRequiredError } from '../src/services/llmFeedback';
import { track } from '../src/services/analytics';
import { AnalyticsEvent } from '../src/constants/analyticsEvents';
import { errorReason } from '../src/lib/analyticsUserProps';
import { MarkdownText } from '../src/components/ui/MarkdownText';
import { colors, spacing, radius } from '../src/constants/theme';

type Bubble = ChatMessage & { id: string };

// Everyone in the app is a subscriber, so a 402 here means the server has not
// caught up with the client yet — the RevenueCat webhook mirrors onto
// profiles.entitlement asynchronously, and a just-purchased user can beat it.
// Genuine lapses are handled by the subscribe gate, not by this screen.
const ENTITLEMENT_LAG_MESSAGE =
  "Your subscription is still syncing on our end. Give it a moment and try again.";

function greeting(sessionCount: number): string {
  if (sessionCount === 0) {
    return "Hi! I'm your practice coach. Record a session and I'll be able to talk through your specific trends — for now, ask me anything about violin technique.";
  }
  return `Hi! I can see your last ${Math.min(sessionCount, 20)} session${sessionCount === 1 ? '' : 's'}. Ask me about a trend, a piece, or what to focus on next.`;
}

export default function ChatScreen() {
  const sessionHistory = useAnalysisStore((s) => s.sessionHistory);
  const coachContext = useCoachContext();

  const [messages, setMessages] = useState<Bubble[]>(() => [
    { id: 'greeting', role: 'assistant', content: greeting(sessionHistory.length) },
  ]);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const scrollRef = useRef<ScrollView>(null);

  useEffect(() => {
    track(AnalyticsEvent.CHAT_OPENED, { session_count: sessionHistory.length });
  }, []);

  const send = async () => {
    const text = input.trim();
    if (!text || sending) return;

    const userMsg: Bubble = { id: `u-${Date.now()}`, role: 'user', content: text };
    const nextMessages = [...messages, userMsg];
    setMessages(nextMessages);
    setInput('');
    setSending(true);
    track(AnalyticsEvent.CHAT_MESSAGE_SENT, {
      turn_index: nextMessages.filter((m) => m.role === 'user').length,
    });

    try {
      const reply = await fetchChatReply(
        nextMessages.map(({ role, content }) => ({ role, content })),
        coachContext,
      );
      setMessages((prev) => [...prev, { id: `a-${Date.now()}`, role: 'assistant', content: reply }]);
    } catch (err) {
      if (err instanceof EntitlementRequiredError) {
        setMessages((prev) => [
          ...prev,
          { id: `lag-${Date.now()}`, role: 'assistant', content: ENTITLEMENT_LAG_MESSAGE },
        ]);
      } else {
        track(AnalyticsEvent.APP_ERROR, { domain: 'chat', reason: errorReason(err) });
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
                {/* Only the coach writes Markdown; the user's own text is
                    rendered verbatim so typed asterisks stay as typed. */}
                {m.role === 'user' ? (
                  <Text style={[s.bubbleText, s.bubbleTextUser]}>{m.content}</Text>
                ) : (
                  <MarkdownText style={s.bubbleText}>{m.content}</MarkdownText>
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
