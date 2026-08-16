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
  // Each generated family gets its own mark, drawn as the shape of the motion
  // it trains — a player should recognise the drill from the tile before they
  // read the title.
  if (type === 'arpeggio_cycle') {
    // Stacked chord tones, ascending.
    return (
      <>
        {[150, 125, 100, 75].map((y, i) => (
          <Circle key={y} cx={68 + i * 25} cy={y} r={13} fill="#fff" opacity={1 - i * 0.12} />
        ))}
        <Path d="M68 150 L143 75" stroke="rgba(255,255,255,0.5)" strokeWidth={5} strokeLinecap="round" />
      </>
    );
  }
  if (type === 'crossing_wave') {
    // Two string lines with the bow rocking between them.
    return (
      <>
        <Line x1={40} y1={82} x2={170} y2={82} stroke="rgba(255,255,255,0.5)" strokeWidth={5} strokeLinecap="round" />
        <Line x1={40} y1={128} x2={170} y2={128} stroke="rgba(255,255,255,0.5)" strokeWidth={5} strokeLinecap="round" />
        <Path d="M50 128 Q78 82, 105 128 T160 128" stroke="#fff" strokeWidth={12} fill="none" strokeLinecap="round" />
      </>
    );
  }
  if (type === 'shifting_ladder') {
    // Rungs climbing one string.
    return (
      <>
        <Line x1={105} y1={40} x2={105} y2={170} stroke="rgba(255,255,255,0.45)" strokeWidth={6} strokeLinecap="round" />
        {[150, 118, 86, 58].map((y, i) => (
          <Line key={y} x1={72} y1={y} x2={138} y2={y} stroke="#fff" strokeWidth={i === 3 ? 12 : 8} strokeLinecap="round" />
        ))}
      </>
    );
  }
  if (type === 'finger_pattern') {
    // Four fingers, one lifted.
    return (
      <>
        {[62, 92, 122, 152].map((x, i) => (
          <Rect key={x} x={x - 9} y={i === 2 ? 62 : 82} width={18} height={i === 2 ? 46 : 66} rx={9} fill="#fff" opacity={i === 2 ? 1 : 0.65} />
        ))}
        <Line x1={44} y1={158} x2={166} y2={158} stroke="#fff" strokeWidth={7} strokeLinecap="round" />
      </>
    );
  }
  if (type === 'figure_loop') {
    // A loop returning on itself.
    return (
      <>
        <Path d="M70 128 A42 42 0 1 1 140 128" stroke="#fff" strokeWidth={12} fill="none" strokeLinecap="round" />
        <Path d="M126 118 L142 132 L126 146" stroke="#fff" strokeWidth={10} fill="none" strokeLinecap="round" strokeLinejoin="round" />
      </>
    );
  }
  if (type === 'acceleration') {
    // Bars crowding together under a fixed pulse.
    return (
      <>
        {[52, 78, 100, 118, 132, 143, 152].map((x, i) => (
          <Rect key={x} x={x} y={68} width={8} height={74} rx={4} fill="#fff" opacity={0.55 + i * 0.06} />
        ))}
        <Line x1={44} y1={158} x2={168} y2={158} stroke="rgba(255,255,255,0.6)" strokeWidth={6} strokeLinecap="round" />
      </>
    );
  }
  if (type === 'trill_chain') {
    // Tight, even alternation.
    return (
      <Path
        d="M40 122 L58 88 L76 122 L94 88 L112 122 L130 88 L148 122 L166 88"
        stroke="#fff"
        strokeWidth={11}
        fill="none"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    );
  }
  if (type === 'bow_distribution') {
    // The whole bow, with the target third lit.
    return (
      <>
        <Rect x={38} y={96} width={134} height={18} rx={9} fill="rgba(255,255,255,0.35)" />
        <Rect x={127} y={90} width={45} height={30} rx={15} fill="#fff" />
        <Circle cx={44} cy={105} r={11} fill="rgba(255,255,255,0.7)" />
      </>
    );
  }
  if (type === 'articulation') {
    // Separated strokes with air between them.
    return (
      <>
        {[52, 92, 132].map((x) => (
          <Rect key={x} x={x} y={72} width={26} height={66} rx={13} fill="#fff" />
        ))}
        <Line x1={44} y1={158} x2={168} y2={158} stroke="rgba(255,255,255,0.55)" strokeWidth={6} strokeLinecap="round" />
      </>
    );
  }
  if (type === 'etude_fragment') {
    // A written line on a stave.
    return (
      <>
        {[76, 94, 112, 130].map((y) => (
          <Line key={y} x1={38} y1={y} x2={172} y2={y} stroke="rgba(255,255,255,0.4)" strokeWidth={4} strokeLinecap="round" />
        ))}
        <Path d="M48 128 Q80 68, 108 104 T166 82" stroke="#fff" strokeWidth={11} fill="none" strokeLinecap="round" />
      </>
    );
  }
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
