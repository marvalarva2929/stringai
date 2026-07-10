import React from 'react';
import Svg, { Circle, Line, Path, Rect } from 'react-native-svg';
import Animated, { useAnimatedStyle, useSharedValue, withSpring } from 'react-native-reanimated';
import type { PracticeBlockType } from '../../lib/practiceBlocks';

/** Animated SVG hero graphic keyed to a block type. Pulses when `pulseKey` changes. */
export function PracticeGraphic({
  type,
  size = 210,
  pulseKey = 0,
}: {
  type: PracticeBlockType;
  size?: number;
  pulseKey?: number;
}) {
  const pulse = useSharedValue(1);
  React.useEffect(() => {
    pulse.value = withSpring(1.08, { damping: 8, stiffness: 120 }, () => {
      pulse.value = withSpring(1, { damping: 12, stiffness: 100 });
    });
  }, [pulseKey]);
  const style = useAnimatedStyle(() => ({ transform: [{ scale: pulse.value }] }));

  return (
    <Animated.View style={[{ width: size, height: size }, style]}>
      <Svg width={size} height={size} viewBox="0 0 210 210">
        <Circle cx={105} cy={105} r={88} fill="rgba(255,255,255,0.12)" />
        <Circle cx={105} cy={105} r={70} fill="rgba(255,255,255,0.16)" />
        {graphicPath(type)}
      </Svg>
    </Animated.View>
  );
}

function graphicPath(type: PracticeBlockType) {
  if (type === 'vibrato') {
    return <Path d="M38 105 C55 58, 78 152, 105 105 S155 58, 172 105" stroke="#fff" strokeWidth={12} fill="none" strokeLinecap="round" />;
  }
  if (type === 'bow_control') {
    return (
      <>
        <Line x1={52} y1={145} x2={158} y2={65} stroke="#fff" strokeWidth={12} strokeLinecap="round" />
        <Line x1={60} y1={66} x2={150} y2={144} stroke="rgba(255,255,255,0.55)" strokeWidth={5} strokeLinecap="round" />
        <Circle cx={105} cy={105} r={12} fill="#fff" />
      </>
    );
  }
  if (type === 'rhythm') {
    return (
      <>
        {[66, 92, 118, 144].map((x, i) => (
          <Rect key={x} x={x - 7} y={62 + (i % 2) * 22} width={14} height={86 - (i % 2) * 22} rx={7} fill="#fff" />
        ))}
      </>
    );
  }
  if (type === 'tone') {
    return (
      <>
        <Circle cx={105} cy={105} r={48} fill="none" stroke="#fff" strokeWidth={10} />
        <Circle cx={105} cy={105} r={22} fill="rgba(255,255,255,0.45)" />
        <Path d="M63 137 C88 154, 122 154, 147 137" stroke="#fff" strokeWidth={7} fill="none" strokeLinecap="round" />
      </>
    );
  }
  return (
    <>
      <Circle cx={105} cy={105} r={48} fill="none" stroke="#fff" strokeWidth={12} />
      <Circle cx={105} cy={105} r={14} fill="#fff" />
      <Line x1={105} y1={31} x2={105} y2={57} stroke="#fff" strokeWidth={8} strokeLinecap="round" />
      <Line x1={105} y1={153} x2={105} y2={179} stroke="#fff" strokeWidth={8} strokeLinecap="round" />
      <Line x1={31} y1={105} x2={57} y2={105} stroke="#fff" strokeWidth={8} strokeLinecap="round" />
      <Line x1={153} y1={105} x2={179} y2={105} stroke="#fff" strokeWidth={8} strokeLinecap="round" />
    </>
  );
}
