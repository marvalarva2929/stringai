import React, { useEffect, useRef, useState } from 'react';
import { View, Text, StyleSheet, useWindowDimensions } from 'react-native';
import { getPoseCameraView } from 'pose-camera';
import Svg, { Line, Rect, Text as SvgText } from 'react-native-svg';
import { convertPoseFrame } from '../../services/videoAnalysis';
import { createBowGeometryTracker, type NormBox, type NormPoint } from '../../lib/bowBoxGeometry';
import type { FrameKeypoints } from '../../lib/poseScoring';
import type { RawBowFrame } from '../../types/signals';
import { spacing, radius } from '../../constants/theme';

export interface TakeCameraCaptureResult {
  poseFrames: FrameKeypoints[];
  bowFrames: RawBowFrame[];
}

interface Props {
  /** Mounts the camera and accumulates frames while true; fires onCaptured on the true→false edge. */
  active: boolean;
  onCaptured: (result: TakeCameraCaptureResult) => void;
  /** Keeps the camera preview mounted without accumulating frames. */
  mounted?: boolean;
  /** Draws live bow/string guide lines from the detector boxes. */
  showGuides?: boolean;
  /** Uses the same landscape point mapping as the Analyze recording overlay. */
  landscapeGuides?: boolean;
  /** Instruction or "keep the violin roughly where it was" reminder, shown as a small banner. */
  message?: string;
}

const PoseCameraView = getPoseCameraView();

/** Minimal camera capture shared by the calibration screen and bow-camera exercise takes. */
export function TakeCameraCapture({ active, onCaptured, mounted = false, showGuides = false, landscapeGuides = false, message }: Props) {
  const poseFramesRef = useRef<FrameKeypoints[]>([]);
  const bowFramesRef = useRef<RawBowFrame[]>([]);
  const startedAtRef = useRef(0);
  const wasActiveRef = useRef(false);
  // Locks the bow/string diagonals for as long as the camera stays mounted, so
  // they can't flip between the preview and the capture that follows it.
  const geometryRef = useRef(createBowGeometryTracker());
  const [guideLines, setGuideLines] = useState<{
    bow: { a: NormPoint; b: NormPoint } | null;
    string: { a: NormPoint; b: NormPoint } | null;
    boxes: { bow: NormBox | null; violin: NormBox | null };
  } | null>(null);
  const { width, height } = useWindowDimensions();

  useEffect(() => {
    if (active) {
      poseFramesRef.current = [];
      bowFramesRef.current = [];
      startedAtRef.current = Date.now();
      wasActiveRef.current = true;
      return;
    }
    if (wasActiveRef.current) {
      wasActiveRef.current = false;
      onCaptured({ poseFrames: poseFramesRef.current, bowFrames: bowFramesRef.current });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);

  if (!PoseCameraView) {
    return (
      <View style={s.wrap}>
        <Text style={s.message}>Camera not available on this device.</Text>
      </View>
    );
  }

  const shouldMountCamera = mounted || active;
  const toScreen = (p: NormPoint) => landscapeGuides
    ? { x: p.y * width, y: p.x * height }
    : { x: p.x * width, y: p.y * height };

  // A box can't be mapped as x/y/w/h — the landscape mapping swaps the axes, so
  // map two opposite corners and rebuild the rect from whichever ends up top-left.
  const toScreenRect = (box: NormBox) => {
    const a = toScreen({ x: box.x1, y: box.y1 });
    const b = toScreen({ x: box.x2, y: box.y2 });
    return {
      x: Math.min(a.x, b.x),
      y: Math.min(a.y, b.y),
      width: Math.abs(b.x - a.x),
      height: Math.abs(b.y - a.y),
    };
  };

  return (
    <View style={s.wrap}>
      {shouldMountCamera && (
        <PoseCameraView
          style={StyleSheet.absoluteFillObject}
          useMpPose={false}
          onPose={(e: any) => {
            const ev = e.nativeEvent ?? e;
            const joints = ev.joints ?? {};

            // One tracker call per frame drives both the overlay and the capture,
            // so what the player is shown is exactly what gets scored.
            const geometry = ev.bowBox
              ? geometryRef.current.push({
                  timestamp: Date.now() / 1000,
                  bowBox: ev.bowBox,
                  bowConfidence: ev.bowConfidence ?? 0,
                  violinBox: ev.violinBox ?? null,
                  rightWrist: joints.rightWrist ?? null,
                  leftWrist: joints.leftWrist ?? null,
                })
              : null;

            if (showGuides && geometry) {
              setGuideLines({ bow: geometry.bow, string: geometry.string, boxes: geometry.boxes });
            }

            if (!active) return;

            const ts = (Date.now() - startedAtRef.current) / 1000;
            poseFramesRef.current.push(convertPoseFrame(joints, ev.leftHand ?? null, ev.rightHand ?? null, ts));
            if (geometry?.bowFrame) {
              bowFramesRef.current.push({ ...geometry.bowFrame, timestamp: ts });
            }
          }}
        />
      )}
      {showGuides && guideLines && (
        <Svg style={StyleSheet.absoluteFillObject} width={width} height={height} pointerEvents="none">
          {/* Detector boxes, drawn under the lines: violin cyan, bow amber —
              same colour convention as the ml tooling. The violin box is the held
              one, so it stays put on frames where the detector misses the violin. */}
          {guideLines.boxes.violin && (() => {
            const r = toScreenRect(guideLines.boxes.violin!);
            return (
              <Rect
                x={r.x} y={r.y} width={r.width} height={r.height}
                fill="rgba(34,211,238,0.10)"
                stroke="#22d3ee"
                strokeWidth={2}
                strokeDasharray="6 4"
                rx={4}
              />
            );
          })()}
          {guideLines.boxes.bow && (() => {
            const r = toScreenRect(guideLines.boxes.bow!);
            return (
              <Rect
                x={r.x} y={r.y} width={r.width} height={r.height}
                fill="rgba(245,158,11,0.08)"
                stroke="#f59e0b"
                strokeWidth={2}
                strokeDasharray="6 4"
                rx={4}
              />
            );
          })()}
          {guideLines.string && (() => {
            const a = toScreen(guideLines.string!.a);
            const b = toScreen(guideLines.string!.b);
            // a = scroll end, b = bridge end (the tracker orients it that way).
            const labelX = Math.max(8, Math.min(width - 72, (a.x + b.x) / 2));
            const labelY = Math.max(24, Math.min(height - 8, (a.y + b.y) / 2 + 18));
            return (
              <>
                <Line x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke="#22d3ee" strokeWidth={6} strokeLinecap="round" />
                <Line x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke="#ecfeff" strokeWidth={2} strokeLinecap="round" />
                <SvgText x={labelX} y={labelY} fill="#a5f3fc" fontSize={14} fontWeight="900">strings</SvgText>
              </>
            );
          })()}
          {guideLines.bow && (() => {
            const a = toScreen(guideLines.bow!.a);
            const b = toScreen(guideLines.bow!.b);
            const labelX = Math.max(8, Math.min(width - 64, (a.x + b.x) / 2));
            const labelY = Math.max(24, Math.min(height - 8, (a.y + b.y) / 2 - 14));
            return (
              <>
                <Line x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke="#f59e0b" strokeWidth={7} strokeLinecap="round" />
                <Line x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke="#fde68a" strokeWidth={3} strokeLinecap="round" />
                <SvgText x={labelX} y={labelY} fill="#fde68a" fontSize={14} fontWeight="900">bow</SvgText>
              </>
            );
          })()}
        </Svg>
      )}
      {message && (
        <View style={s.banner}>
          <Text style={s.bannerText}>{message}</Text>
        </View>
      )}
    </View>
  );
}

const s = StyleSheet.create({
  wrap: { flex: 1, backgroundColor: '#000' },
  message: { color: '#fff', textAlign: 'center', marginTop: spacing.xl },
  banner: {
    position: 'absolute',
    top: spacing.lg,
    left: spacing.lg,
    right: spacing.lg,
    backgroundColor: 'rgba(0,0,0,0.65)',
    borderRadius: radius.md,
    padding: spacing.sm,
  },
  bannerText: { color: '#fff', textAlign: 'center', fontWeight: '700', fontSize: 13 },
});
