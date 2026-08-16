import React from 'react';
import { View, Text, StyleSheet, SafeAreaView } from 'react-native';
import { colors, spacing } from '../../constants/theme';
import { reportError } from '../../services/crashReporting';
import { Button } from './Button';

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  content: {
    flex: 1,
    justifyContent: 'center',
    paddingHorizontal: spacing.xl,
    gap: spacing.md,
  },
  title: {
    fontSize: 20,
    fontWeight: '700',
    color: colors.text.primary,
    textAlign: 'center',
  },
  message: {
    fontSize: 15,
    color: colors.text.secondary,
    textAlign: 'center',
    lineHeight: 21,
    marginBottom: spacing.md,
  },
});

interface Props {
  children: React.ReactNode;
}

interface State {
  error: Error | null;
}

export class ErrorBoundary extends React.Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    // A render crash here replaces the whole app with this screen, so it is the
    // most severe non-fatal the app can produce — always reported, unlike the
    // dev-only console log below.
    reportError(error, 'render', {
      component_stack: info.componentStack?.slice(0, 400) ?? undefined,
    });
    if (__DEV__) {
      console.error('Unhandled error caught by ErrorBoundary:', error, info.componentStack);
    }
  }

  reset = () => this.setState({ error: null });

  render() {
    if (this.state.error) {
      return (
        <SafeAreaView style={styles.container}>
          <View style={styles.content}>
            <Text style={styles.title}>Something went wrong</Text>
            <Text style={styles.message}>
              StringAI ran into an unexpected error. Try again, and if it keeps happening,
              restarting the app usually helps.
            </Text>
            <Button label="Try again" onPress={this.reset} fullWidth />
          </View>
        </SafeAreaView>
      );
    }
    return this.props.children;
  }
}
