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
    name: 'subscription',
    renderIcon: (focused) => (
      <Octicons
        name="star-fill"
        size={22}
        color={focused ? colors.brand[600] : colors.muted}
      />
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
}: {
  routeName: string;
  isFocused: boolean;
  onPress: () => void;
}) {
  const scale = useSharedValue(1);
  const animStyle = useAnimatedStyle(() => ({ transform: [{ scale: scale.value }] }));
  const tab = TABS.find((t) => t.name === routeName);

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
        {tab?.renderIcon(isFocused)}
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

  const visibleRoutes = state.routes.filter((r: any) => r.name !== 'analyze');
  const left = visibleRoutes.slice(0, 2);
  const right = visibleRoutes.slice(2);

  return (
    <View style={[s.bar, { paddingBottom: insets.bottom }]}>
      {left.map((route: any) => {
        const isFocused = state.routes[state.index].name === route.name;
        const onPress = () => { if (!isFocused) navigation.navigate(route.name); };
        return <TabButton key={route.key} routeName={route.name} isFocused={isFocused} onPress={onPress} />;
      })}

      <CenterButton />

      {right.map((route: any) => {
        const isFocused = state.routes[state.index].name === route.name;
        const onPress = () => {
          if (route.name === 'subscription') { router.push('/paywall'); return; }
          if (!isFocused) navigation.navigate(route.name);
        };
        return <TabButton key={route.key} routeName={route.name} isFocused={isFocused} onPress={onPress} />;
      })}
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
