import { MetricKey, SeverityBand } from '../types/analysis';

interface MetricMeta {
  label: string;
  icon: string;
  tips: Record<SeverityBand, string>;
  drill: string;
}

export const METRIC_META: Record<MetricKey, MetricMeta> = {
  pitchAccuracy: {
    label: 'Intonation',
    icon: '🎵',
    tips: {
      excellent: 'Excellent intonation — your pitch is consistently accurate. Try playing without looking at your fingers to build muscle memory.',
      good: 'Good intonation overall. Focus on 3rd and 4th finger placement on the A string to close the gap.',
      needs_attention: 'Several notes are drifting flat or sharp. Slow down and use a tuner drone to lock in each finger position before increasing tempo.',
      critical: 'Intonation needs significant work. Practice each note individually with a tuner, aiming to land within 10 cents every time.',
    },
    drill: 'Play each note of a one-octave G major scale with a drone tuner sounding the tonic. Pause on every note for 2 full bow strokes until the pitch feels locked, then move on. Repeat the whole scale 3 times before increasing tempo.',
  },
  intonationStability: {
    label: 'Pitch Stability',
    icon: '📏',
    tips: {
      excellent: 'Your sustained notes hold pitch very steadily.',
      good: 'Mostly stable. Notice any pitch drift when your bow speed slows near the tip.',
      needs_attention: 'Pitch wavers on held notes. Keep consistent bow speed and arm weight throughout the full bow.',
      critical: 'Significant pitch instability on held notes. Check left thumb tension — a tight thumb causes pitch to waver.',
    },
    drill: 'Play open A string for 4 full bow strokes, listening for any wobble. Then play first finger B, hold for 4 bows. Focus on keeping the finger pressure even and the bow speed constant. Loose left thumb is the key.',
  },
  toneQuality: {
    label: 'Tone Quality',
    icon: '🎻',
    tips: {
      excellent: 'Rich, resonant tone. The harmonic spectrum shows excellent bow technique.',
      good: 'Generally good tone. A small amount of surface noise is normal — aim for slightly more arm weight.',
      needs_attention: 'Scratchy or thin tone detected. Try slowing your bow speed and adding more arm weight rather than pressing harder.',
      critical: 'Significant bow noise or thinness. Focus on the "highway" — keep your bow parallel to the bridge, between the bridge and fingerboard.',
    },
    drill: 'Open D string, whole bow, mezzo-forte. Use your arm weight (not finger pressure) and a slow, steady bow. Listen for the string to "speak" — a full, round sound. If you hear scratch, reduce speed first, then try a bit more weight. Aim for 10 consecutive clean bows.',
  },
  bowSmoothness: {
    label: 'Bow Changes',
    icon: '↔️',
    tips: {
      excellent: 'Bow changes are seamless. The amplitude envelope shows no audible dips.',
      good: 'Mostly smooth bow changes. A few direction changes have slight hesitation — keep the arm motion continuous.',
      needs_attention: 'Bumpy bow changes are creating audible bumps in the sound. Think of the bow change as a curved motion, not a sudden reversal.',
      critical: 'Bow changes are abrupt and disrupt the musical line. Practice long, slow bow changes focusing only on the moment of direction change.',
    },
    drill: 'Open G string, very slow whole bow (8 counts down, 8 counts up). At each direction change, think "curved" — like your arm is drawing an oval, not hitting a wall. Record yourself and listen for any bump at the reversal. Do 5 minutes daily on this alone.',
  },
  vibrato: {
    label: 'Vibrato',
    icon: '〰️',
    tips: {
      excellent: 'Beautiful vibrato — consistent rate (around 5–6 Hz) and even depth.',
      good: 'Good vibrato on most notes. Let the vibrato continue right through the bow change for a more singing tone.',
      needs_attention: 'Vibrato is inconsistent or stopping mid-note. Practice vibrato in isolation: one note, full bow, continuous vibrato from start to finish.',
      critical: 'Vibrato is absent or very tight. Loosen the left thumb and practice the "wrist wave" motion without the bow first.',
    },
    drill: 'Without the bow, place first finger on A string. Rock the wrist forward and back rhythmically — aim for a smooth, even oscillation. Start slow (2 Hz), build to a natural speed. Add the bow only when the motion feels free. Practice 3rd finger on D string the same way; 3rd finger vibrato is the easiest to develop.',
  },
  rhythmAccuracy: {
    label: 'Rhythm',
    icon: '🥁',
    tips: {
      excellent: 'Excellent rhythmic precision. Your sense of pulse is solid.',
      good: 'Good rhythm overall. Watch dotted rhythms — they tend to get rushed.',
      needs_attention: 'Rhythm is inconsistent. Practice with a metronome at 60% tempo, tapping your foot on beats 1 and 3.',
      critical: 'Rhythm needs significant attention. Break the passage into two-note fragments and count out loud while playing.',
    },
    drill: 'Set a metronome to 60 BPM. Play one measure of your piece, then rest one measure while counting. The rest forces you to feel the pulse internally before playing again. Do this for 5 minutes. When comfortable, play two measures, rest one. Never let the bow move until the beat arrives.',
  },
  dynamicControl: {
    label: 'Dynamics',
    icon: '🔊',
    tips: {
      excellent: 'Excellent dynamic range and control.',
      good: 'Good dynamic shaping. Push slightly further on the forte passages — more bow speed, not more pressure.',
      needs_attention: 'Dynamics are flat. Exaggerate contrasts: really commit to piano (near fingerboard, lighter bow) and forte (faster bow, full weight).',
      critical: 'Little dynamic variation detected. Start by finding two distinct sounds: a whisper and a shout, using bow speed as the main tool.',
    },
    drill: 'Play open A: 4 bows very soft (piano — slow bow near fingerboard, minimal weight), then 4 bows very loud (forte — fast bow, full arm weight, normal contact point). Alternate 5 times. The goal is to hear a clear difference. Record yourself — the two sounds should be obviously distinct on playback.',
  },
  bowPlacement: {
    label: 'Bow Placement',
    icon: '📍',
    tips: {
      excellent: 'Bow is consistently in the optimal contact zone.',
      good: 'Mostly in the right zone. Watch for drifting toward the fingerboard during difficult passages.',
      needs_attention: 'Bow is frequently in the sul tasto zone (too close to fingerboard). This produces a thin, unfocused tone. Aim for midway between bridge and end of fingerboard.',
      critical: 'Bow is consistently too far from the bridge. Place a piece of tape on your violin as a guide marker for the correct contact point.',
    },
    drill: 'Put a small piece of tape on your violin strings halfway between the bridge and the end of the fingerboard. Practice slow whole bows on open strings, keeping the bow hair touching the tape line. Set up your phone to record from the side so you can watch placement drift. 10 minutes of tape-guided practice will reset your muscle memory.',
  },
  bowAngle: {
    label: 'Bow Angle',
    icon: '📐',
    tips: {
      excellent: 'Bow is well-aligned, close to perpendicular with the strings.',
      good: 'Mostly good alignment. A slight diagonal is natural, but aim to keep the bow closer to square.',
      needs_attention: 'Bow is angling significantly. This reduces contact surface and tone quality. Watch yourself in a mirror while practising slow bows.',
      critical: 'Significant bow angle issues. Practice long bows in front of a mirror, keeping the bow visually parallel to the bridge at all times.',
    },
    drill: 'Stand sideways to a mirror. Draw a slow whole bow on open D, watching the mirror. The bow should always look perpendicular to the strings. A common fix: keep the right elbow leading slightly at the frog, and let the wrist guide gently at the tip. Do 10 bows watching the mirror, then 10 with eyes closed trying to feel the correct angle.',
  },
  bowArmLevel: {
    label: 'Bow Arm Height',
    icon: '💪',
    tips: {
      excellent: 'Bow arm level matches the string being played perfectly.',
      good: 'Arm level is generally correct. Minor adjustments needed when moving to G and E strings.',
      needs_attention: 'Arm height not adjusting properly for string crossings. Think "raise the elbow for G string, lower for E string."',
      critical: 'Arm is at roughly the same height regardless of string. This causes string crossings to be noisy. Drill each string in isolation, setting the arm first.',
    },
    drill: 'Practice "arm levels": bow only on G for 4 strokes (elbow up, forearm roughly horizontal), then E for 4 strokes (elbow drops, forearm angled down). No notes — just the arm adjustment between strings. The arm should pre-set before the bow lands. Do G–E–G–E slowly 10 times, stopping at each string to confirm the elbow height before you bow.',
  },
  bowDistribution: {
    label: 'Bow Usage',
    icon: '↕️',
    tips: {
      excellent: 'Great bow distribution — using the full length.',
      good: 'Using most of the bow. Push to the very tip on long notes to avoid running out of bow.',
      needs_attention: 'Only using the middle of the bow. Full bow strokes improve tone and expressiveness — practice reaching all the way to frog and tip.',
      critical: 'Bow is barely moving. Small bow strokes are restricting tone and dynamics. Slow down tempo and focus on long, slow, full bows.',
    },
    drill: 'Open G string, whole bow down in 8 slow counts, whole bow up in 8 slow counts. Make sure you actually reach the tip (bow stick almost vertical, hand at the end of the stick) and the frog (hand touching the winding). Exaggerate it. After 5 minutes of exaggerated full bows, your "normal" bow will naturally use more of the stick.',
  },
  leftHandWrist: {
    label: 'Left Wrist',
    icon: '🤚',
    tips: {
      excellent: 'Left wrist is well-aligned — good setup for clean finger action.',
      good: 'Mostly good wrist position. Check for collapse when reaching 4th finger.',
      needs_attention: 'Wrist is collapsing inward. This locks up finger independence. Keep the wrist straight and slightly outward so fingers fall curved onto the string.',
      critical: 'Wrist collapse is severe. Practice open strings with a correct hand frame before adding fingers. A collapsed wrist causes intonation and tension issues.',
    },
    drill: 'Hold the violin without the bow. Place all four fingers on the D string in first position, curved naturally. Now check: can you see a straight line from your forearm through your wrist to your knuckles? If the wrist is bent inward, move it outward until the knuckles, wrist, and forearm align. Tap each finger up and down 10 times in this position. The goal is to feel the tap come from the knuckle, not a collapsed wrist.',
  },
  posture: {
    label: 'Posture',
    icon: '🧍',
    tips: {
      excellent: 'Excellent posture — balanced, relaxed, and efficient.',
      good: 'Good overall posture. Watch for gradual left shoulder rise during difficult passages.',
      needs_attention: 'Shoulder or head position needs adjustment. Keep both shoulders level and relaxed. The violin should be supported by the chin rest and shoulder rest, not a raised shoulder.',
      critical: 'Significant posture issues detected. Have a teacher or experienced player check your setup before continuing — poor posture causes injuries.',
    },
    drill: 'Stand in front of a mirror. Play a passage you know well while watching your shoulders. The moment you notice the left shoulder creeping up, stop and reset: drop both shoulders, take a breath, start again. Do this 5 times in a row with no shoulder rise before moving on. The habit breaks once you can feel the tension before it happens.',
  },
};
