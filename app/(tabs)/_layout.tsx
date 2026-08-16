import React from 'react';
import { View, Pressable, StyleSheet } from 'react-native';
import { Tabs, router } from 'expo-router';
import { Ionicons, Octicons, MaterialCommunityIcons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withSequence,
  withTiming,
} from 'react-native-reanimated';
import * as Haptics from 'expo-haptics';
import { colors } from '../../src/constants/theme';
import { useAnalysisStore } from '../../src/store/useAnalysisStore';

type TabDef = {
  name: string;
  renderIcon: (focused: boolean) => React.ReactNode;
};

const TABS: TabDef[] = [
  {
    name: 'home',
    renderIcon: (focused) => (
      <Octicons
        name="home-fill"
        size={24}
        color={focused ? colors.brand[600] : colors.muted}
      />
    ),
  },
  {
    name: 'progress',
    renderIcon: (focused) => (
      <MaterialCommunityIcons
        name="chart-timeline-variant-shimmer"
        size={24}
        color={focused ? colors.brand[600] : colors.muted}
      />
    ),
  },
  {
    // Kept under its original route name so the tab count (and the centred +
    // button's 2/2 split) stays stable. It is the chat entry point now — see
    // renderRoute, which pushes /chat as a modal rather than focusing a tab.
    name: 'subscription',
    renderIcon: () => (
      <Ionicons name="chatbubble-ellipses-outline" size={22} color={colors.muted} />
    ),
  },
  {
    name: 'settings',
    renderIcon: (focused) => (
      <Ionicons
        name={focused ? 'settings' : 'settings-outline'}
        size={24}
        color={focused ? colors.brand[600] : colors.muted}
      />
    ),
  },
];

function TabButton({
  routeName,
  isFocused,
  onPress,
  iconOverride,
}: {
  routeName: string;
  isFocused: boolean;
  onPress: () => void;
  iconOverride?: (focused: boolean) => React.ReactNode;
}) {
  const scale = useSharedValue(1);
  const animStyle = useAnimatedStyle(() => ({ transform: [{ scale: scale.value }] }));
  const tab = TABS.find((t) => t.name === routeName);
  const renderIcon = iconOverride ?? tab?.renderIcon;

  const handlePress = () => {
    scale.value = withSequence(
      withTiming(1.15, { duration: 60 }),
      withTiming(1, { duration: 100 }),
    );
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    onPress();
  };

  return (
    <Pressable onPress={handlePress} style={s.tab}>
      <Animated.View style={[s.iconWrap, isFocused && s.iconWrapActive, animStyle]}>
        {renderIcon?.(isFocused)}
      </Animated.View>
    </Pressable>
  );
}

function CenterButton() {
  const { reset } = useAnalysisStore();
  const scale = useSharedValue(1);
  const animStyle = useAnimatedStyle(() => ({ transform: [{ scale: scale.value }] }));

  const handlePress = () => {
    scale.value = withSequence(
      withTiming(1.15, { duration: 60 }),
      withTiming(1, { duration: 100 }),
    );
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    reset();
    router.push('/(tabs)/analyze');
  };

  return (
    <Pressable onPress={handlePress} style={s.centerTab}>
      <Animated.View style={[s.centerBtn, animStyle]}>
        <Ionicons name="add" size={30} color="#fff" />
      </Animated.View>
    </Pressable>
  );
}

function CustomTabBar({
  state,
  navigation,
  descriptors,
}: {
  state: any;
  navigation: any;
  descriptors: any;
}) {
  const insets = useSafeAreaInsets();

  // Respect tabBarStyle: { display: 'none' } set by individual screens
  const currentRoute = state.routes[state.index];
  const currentOptions = descriptors?.[currentRoute?.key]?.options;
  if (currentOptions?.tabBarStyle?.display === 'none') return null;

  // 'analyze' has its own center + button; 'train' is reached from the home
  // screen's practice-plan card, not a tab button. Both stay registered
  // routes (navigable), just not buttons here. That keeps the visible count
  // fixed at 4, so an even 2/2 split always centers the + button — no spacer
  // hacks needed.
  const visibleRoutes = state.routes.filter(
    (r: any) => r.name !== 'analyze' && r.name !== 'train',
  );
  const half = Math.ceil(visibleRoutes.length / 2);
  const left = visibleRoutes.slice(0, half);
  const right = visibleRoutes.slice(half);

  const renderRoute = (route: any) => {
    const isFocused = state.routes[state.index].name === route.name;

    // Everyone in the app is a subscriber, so this slot — once the subscribe
    // star — is permanently the chat entry point. Chat is a modal, so the tab
    // itself never takes focus.
    if (route.name === 'subscription') {
      return (
        <TabButton
          key={route.key}
          routeName={route.name}
          isFocused={false}
          onPress={() => router.push('/chat')}
        />
      );
    }

    const onPress = () => {
      if (!isFocused) navigation.navigate(route.name);
    };
    return <TabButton key={route.key} routeName={route.name} isFocused={isFocused} onPress={onPress} />;
  };

  return (
    <View style={[s.bar, { paddingBottom: insets.bottom }]}>
      {left.map(renderRoute)}
      <CenterButton />
      {right.map(renderRoute)}
    </View>
  );
}

export default function TabsLayout() {
  return (
    <Tabs
      tabBar={(props) => <CustomTabBar {...props} />}
      screenOptions={{ headerShown: false }}
    >
      <Tabs.Screen name="home" />
      <Tabs.Screen name="train" />
      <Tabs.Screen name="analyze" />
      <Tabs.Screen name="progress" />
      <Tabs.Screen name="subscription" />
      <Tabs.Screen name="settings" />
    </Tabs>
  );
}

const s = StyleSheet.create({
  bar: {
    flexDirection: 'row',
    backgroundColor: '#fff',
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: '#e5e7eb',
    shadowColor: '#000',
    shadowOpacity: 0.07,
    shadowOffset: { width: 0, height: -2 },
    shadowRadius: 8,
    elevation: 8,
    paddingTop: 8,
    alignItems: 'center',
  },
  tab: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 6,
  },
  iconWrap: {
    width: 46,
    height: 40,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 11,
  },
  iconWrapActive: {
    borderWidth: 2,
    borderColor: colors.brand[600],
    backgroundColor: colors.brand[50],
  },
  centerTab: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 6,
  },
  centerBtn: {
    width: 52,
    height: 52,
    borderRadius: 16,
    backgroundColor: colors.brand[600],
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: colors.brand[800],
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 1,
    shadowRadius: 0,
    elevation: 6,
  },
});
