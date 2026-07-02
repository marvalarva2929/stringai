import React from 'react';
import Svg, { Circle, Line, G } from 'react-native-svg';

export interface PoseJoint {
  x: number;           // normalized 0-1 (display, left→right)
  y: number;           // normalized 0-1 (display, top→bottom)
  confidence: number;
  wx?: number;         // world x (meters, relative to hand wrist, from MediaPipe)
  wy?: number;
  wz?: number;
}

export interface HandLandmarks {
  wrist?: PoseJoint;
  indexMCP?: PoseJoint;
  middleMCP?: PoseJoint;
  ringMCP?: PoseJoint;
}

export type PoseJoints = Partial<Record<
  'leftShoulder' | 'rightShoulder' | 'leftElbow' | 'rightElbow' |
  'leftWrist' | 'rightWrist' | 'neck' |
  'leftIndexTip' | 'leftPinkyTip',
  PoseJoint
>>;

interface Props {
  joints: PoseJoints;
  leftHand?: HandLandmarks | null;
  rightHand?: HandLandmarks | null;
  width: number;
  height: number;
  flip?: boolean;
}

const px = (j: PoseJoint, w: number, flip: boolean) => (flip ? j.y : (1 - j.y)) * w;
const py = (j: PoseJoint, h: number, flip: boolean) => (flip ? j.x : (1 - j.x)) * h;

const LEFT_COLOR       = '#22c55e';
const RIGHT_COLOR      = '#3b82f6';
const NECK_COLOR       = 'rgba(255,255,255,0.45)';
const LEFT_HAND_COLOR  = '#f59e0b';
const RIGHT_HAND_COLOR = '#a855f7';
const DOT_FILL         = '#fff';
const DOT_R            = 8;
const LINE_W           = 3.5;
const HAND_DOT_R       = 5;
const HAND_LINE_W      = 2;

export function PoseSkeleton({ joints, leftHand, rightHand, width, height, flip = false }: Props) {
  const { leftShoulder, rightShoulder, leftElbow, rightElbow, leftWrist, rightWrist, neck } = joints;

  function line(a: PoseJoint | undefined, b: PoseJoint | undefined, color: string) {
    if (!a || !b) return null;
    return (
      <Line
        x1={px(a, width, flip)} y1={py(a, height, flip)}
        x2={px(b, width, flip)} y2={py(b, height, flip)}
        stroke={color} strokeWidth={LINE_W} strokeLinecap="round" opacity={0.88}
      />
    );
  }

  function dot(j: PoseJoint | undefined, color: string) {
    if (!j) return null;
    return (
      <Circle
        cx={px(j, width, flip)} cy={py(j, height, flip)}
        r={DOT_R} fill={DOT_FILL} fillOpacity={0.92} stroke={color} strokeWidth={2.5}
      />
    );
  }

  function handLine(a: PoseJoint | undefined, b: PoseJoint | undefined, color: string) {
    if (!a || !b) return null;
    return (
      <Line
        x1={px(a, width, flip)} y1={py(a, height, flip)}
        x2={px(b, width, flip)} y2={py(b, height, flip)}
        stroke={color} strokeWidth={HAND_LINE_W} strokeLinecap="round" opacity={0.85}
      />
    );
  }

  function handDot(j: PoseJoint | undefined, color: string) {
    if (!j) return null;
    return (
      <Circle
        cx={px(j, width, flip)} cy={py(j, height, flip)}
        r={HAND_DOT_R} fill={color} fillOpacity={0.9} stroke="#000" strokeWidth={1.5}
      />
    );
  }

  function renderHand(hand: HandLandmarks | null | undefined, color: string) {
    if (!hand) return null;
    const { wrist, indexMCP, middleMCP, ringMCP } = hand;
    return (
      <G>
        {handLine(wrist, indexMCP,  color)}
        {handLine(wrist, middleMCP, color)}
        {handLine(wrist, ringMCP,   color)}
        {handLine(indexMCP,  middleMCP, color)}
        {handLine(middleMCP, ringMCP,   color)}
        {handDot(wrist,     color)}
        {handDot(indexMCP,  color)}
        {handDot(middleMCP, color)}
        {handDot(ringMCP,   color)}
      </G>
    );
  }

  return (
    <Svg
      width={width}
      height={height}
      style={{ position: 'absolute', top: 0, left: 0 }}
      pointerEvents="none"
    >
      <G>
        {line(leftShoulder, rightShoulder, NECK_COLOR)}
        {line(neck, leftShoulder, NECK_COLOR)}
        {line(neck, rightShoulder, NECK_COLOR)}

        {line(leftShoulder, leftElbow, LEFT_COLOR)}
        {line(leftElbow,    leftWrist, LEFT_COLOR)}

        {line(rightShoulder, rightElbow, RIGHT_COLOR)}
        {line(rightElbow,    rightWrist, RIGHT_COLOR)}

        {dot(neck,          NECK_COLOR)}
        {dot(leftShoulder,  LEFT_COLOR)}
        {dot(leftElbow,     LEFT_COLOR)}
        {dot(leftWrist,     LEFT_COLOR)}
        {dot(rightShoulder, RIGHT_COLOR)}
        {dot(rightElbow,    RIGHT_COLOR)}
        {dot(rightWrist,    RIGHT_COLOR)}

        {renderHand(leftHand,  LEFT_HAND_COLOR)}
        {renderHand(rightHand, RIGHT_HAND_COLOR)}
      </G>
    </Svg>
  );
}

export { LEFT_HAND_COLOR, RIGHT_HAND_COLOR };
