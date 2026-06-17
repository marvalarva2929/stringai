/**
 * Technique Detection Specification
 *
 * Defines what the analysis engine looks for, why each metric matters,
 * what constitutes a violation, and how to communicate findings.
 *
 * This drives both the detection thresholds and the LLM feedback prompt.
 */

import { MetricKey } from '../types/analysis';

export type TechniqueCategory = 'posture' | 'bow_arm' | 'left_hand' | 'sound';

export interface ViolationSpec {
  id: string;
  label: string;        // Short name: "Wrist collapse"
  description: string;  // What is physically happening
  impact: string;       // What this causes for the player
  threshold: string;    // Precise technical threshold
}

export interface TechniqueSpecEntry {
  metricKey: MetricKey;
  name: string;
  category: TechniqueCategory;
  importance: string;       // Why this metric matters
  whatToLookFor: string[];  // Detection criteria, human-readable
  violations: ViolationSpec[];
  goodDescription: string;  // What correct technique looks like
  summaryGood: () => string;
  summaryWithIssues: (count: number, ratePct: number) => string;
}

export const TECHNIQUE_SPEC: TechniqueSpecEntry[] = [

  // ─── POSTURE ──────────────────────────────────────────────────────────────────

  {
    metricKey: 'posture',
    name: 'Posture',
    category: 'posture',
    importance:
      'A balanced, relaxed posture is the prerequisite for all other technique. ' +
      'Shoulder tension restricts the bow arm. An uncentered head strains the neck and jaw. ' +
      'Postural problems accumulate into repetitive strain injuries over time.',
    whatToLookFor: [
      'Left shoulder elevation relative to right (shoulders should be level)',
      'Head/nose offset from the shoulder midpoint (head should stay centered)',
      'Persistence of issues: a single-frame tilt is different from sustained misalignment',
    ],
    violations: [
      {
        id: 'shoulder_raised',
        label: 'Raised shoulder',
        description: 'Left shoulder is elevated significantly above right shoulder level.',
        impact:
          'Restricts bow arm freedom, blocks natural shoulder rotation, and creates chronic neck tension.',
        threshold: 'Left–right shoulder y-difference > 4% of frame height, sustained.',
      },
      {
        id: 'shoulder_uneven',
        label: 'Uneven shoulders',
        description: 'Shoulders are persistently asymmetric — one higher than the other.',
        impact:
          'Creates unequal muscle load, reduces left-arm reach, can lead to tendinitis.',
        threshold: 'Shoulder y-difference > 0.04 normalized units.',
      },
      {
        id: 'head_tilted',
        label: 'Head tilt',
        description: 'Head is shifted laterally from the centre of the shoulder span.',
        impact:
          'Strains the neck, can compress the jaw on the chin rest at an inefficient angle, ' +
          'reduces peripheral awareness of the bow.',
        threshold: 'Nose x-offset > 15% of shoulder width from shoulder midpoint.',
      },
    ],
    goodDescription:
      'Shoulders sit level and relaxed. Head is centred above the midpoint of the shoulders. ' +
      'No sustained tension visible in the neck or jaw region.',
    summaryGood: () => 'Posture was well-balanced throughout the session.',
    summaryWithIssues: (count, ratePct) =>
      ratePct >= 40
        ? `Posture issues were present ${ratePct}% of the session.`
        : count === 1
        ? 'One posture issue was detected.'
        : `Posture issues were detected ${count} times.`,
  },

  // ─── BOW ARM ──────────────────────────────────────────────────────────────────

  {
    metricKey: 'bowPlacement',
    name: 'Bow Contact Point',
    category: 'bow_arm',
    importance:
      'The contact point between bow hair and string is the primary determinant of tone quality. ' +
      'The ideal zone is midway between the bridge and the end of the fingerboard. ' +
      'Even small deviations — drifting towards the fingerboard (sul tasto) or bridge (sul ponticello) — ' +
      'drastically change the tone character.',
    whatToLookFor: [
      'Right wrist x-position relative to right shoulder, normalised by shoulder width',
      'Bow drifting toward fingerboard (sul tasto zone)',
      'Bow creeping too close to bridge (sul ponticello zone)',
      'Consistency of contact point across bow strokes',
    ],
    violations: [
      {
        id: 'sul_tasto',
        label: 'Bow in sul tasto zone',
        description: 'Right wrist has moved toward the fingerboard, placing bow hair too close to the end of the fingerboard.',
        impact:
          'Produces a thin, hollow, unfocused tone with reduced overtone content. ' +
          'Common when the player is focusing on left-hand accuracy and neglecting bow placement.',
        threshold: 'Normalised wrist offset > 0.25 shoulder-widths toward fingerboard.',
      },
      {
        id: 'sul_ponticello',
        label: 'Bow near bridge',
        description: 'Right wrist has drifted too close to the bridge.',
        impact:
          'Produces a glassy, nasal tone with excessive upper harmonics. ' +
          'Usually indicates the bow arm is insufficiently extended or the player is pressing too hard.',
        threshold: 'Normalised wrist offset < -0.05 shoulder-widths toward bridge.',
      },
    ],
    goodDescription:
      'Bow hair consistently contacts the string in the middle zone — halfway between bridge and fingerboard. ' +
      'Contact point remains stable across bow direction changes and string crossings.',
    summaryGood: () => 'Bow stayed in the correct contact zone throughout.',
    summaryWithIssues: (count, ratePct) =>
      ratePct >= 30
        ? `Bow was out of the optimal contact zone ${ratePct}% of the session.`
        : count === 1
        ? 'Bow drifted from the contact zone once.'
        : `Bow drifted out of position ${count} times.`,
  },

  {
    metricKey: 'bowAngle',
    name: 'Bow Angle',
    category: 'bow_arm',
    importance:
      'The bow should travel perpendicular to the strings throughout each stroke. ' +
      'A diagonal bow reduces the hair-to-string contact area, makes tone inconsistent, ' +
      'and can cause the bow to slide off the string on fast passages.',
    whatToLookFor: [
      'Angle of the wrist-to-elbow line from horizontal (proxy for bow direction)',
      'Consistent perpendicularity at frog, middle, and tip',
      'Whether angle changes during the stroke (it should stay constant)',
    ],
    violations: [
      {
        id: 'bow_tilted',
        label: 'Bow angled',
        description: 'The forearm line deviates significantly from horizontal, indicating a non-perpendicular bow path.',
        impact:
          'Reduces effective hair width on the string. Creates uneven tone between down- and up-bows. ' +
          'In fast passages causes bow to lose contact or skate across strings.',
        threshold: 'Wrist-to-elbow angle > ±20° from horizontal.',
      },
    ],
    goodDescription:
      'Bow travels straight across the strings, remaining visually parallel to the bridge throughout each stroke. ' +
      'The bow makes full flat-hair contact at all parts of the stroke.',
    summaryGood: () => 'Bow angle was consistent and perpendicular throughout.',
    summaryWithIssues: (_count, ratePct) =>
      ratePct >= 50
        ? `Bow was at a significant angle ${ratePct}% of the session.`
        : `Bow angle was off in ${ratePct}% of detected frames.`,
  },

  {
    metricKey: 'bowArmLevel',
    name: 'Bow Arm Height',
    category: 'bow_arm',
    importance:
      'Each string requires a different elbow height to keep the bow flat on the string. ' +
      'G string requires the highest elbow; E string the lowest. ' +
      'Failing to adjust means the bow contacts the string at an angle, ' +
      'producing inconsistent tone and making clean string crossings impossible.',
    whatToLookFor: [
      'Standard deviation of right elbow y-position relative to right shoulder over the session',
      'Whether elbow height correlates with string pitch changes (cross-validate with audio)',
      'Elbow locked in one position regardless of string being played',
    ],
    violations: [
      {
        id: 'arm_not_adjusting',
        label: 'Static bow arm',
        description: 'Elbow height barely changes throughout the session — arm is not pre-setting for different strings.',
        impact:
          'String crossings are noisy and imprecise. The bow tilts differently on each string, ' +
          'producing uneven tone. On G string the bow cannot lie flat without a higher elbow.',
        threshold: 'Standard deviation of elbow relative y < 0.02 over the full session.',
      },
    ],
    goodDescription:
      'Elbow height rises noticeably when playing on G and D strings and lowers for A and E. ' +
      'The adjustment is pre-emptive (elbow sets before bow arrives on string) not reactive.',
    summaryGood: () => 'Bow arm adjusted well for string changes throughout.',
    summaryWithIssues: (_count, ratePct) =>
      ratePct >= 60
        ? 'Bow arm height was mostly static — may not be adjusting between strings.'
        : 'Bow arm height showed limited adjustment for string changes.',
  },

  {
    metricKey: 'bowDistribution',
    name: 'Bow Distribution',
    category: 'bow_arm',
    importance:
      'Full use of the bow is essential for musical expression and tone variety. ' +
      'The frog produces the warmest, heaviest sound; the tip the lightest, most delicate. ' +
      'Players who only use the middle third limit their dynamic range ' +
      'and cannot produce the full spectrum of tone colors.',
    whatToLookFor: [
      'Range of right wrist x-movement across the session',
      'Whether strokes reach the tip (right wrist far right in mirrored image)',
      'Whether strokes reach the frog (right wrist far left in mirrored image)',
      'Distribution across tip, middle, and frog thirds',
    ],
    violations: [
      {
        id: 'bow_middle_only',
        label: 'Middle-bow only',
        description: 'Bow strokes are confined to the middle third of the bow, rarely reaching tip or frog.',
        impact:
          'Severely limits dynamic range. Cannot produce full forte (requires full arm weight at frog) ' +
          'or delicate pianissimo (requires contact at the flexible tip). ' +
          'Phrase shaping becomes mechanical.',
        threshold: 'More than 70% of wrist x-positions are in the middle third of the observed range.',
      },
      {
        id: 'bow_short_strokes',
        label: 'Very short strokes',
        description: 'Total bow range (wrist x excursion) is very limited across the session.',
        impact:
          'Produces restricted, "safe" tone that never risks the full sound. ' +
          'Makes long notes impossible without a bow change.',
        threshold: 'Total wrist x-range < 10% of shoulder width.',
      },
    ],
    goodDescription:
      'Strokes reach all the way to the tip (wrist far right in frame) and to the frog (wrist far left). ' +
      'Long notes use the full bow. Short notes use a specific portion intentionally, not by default.',
    summaryGood: () => 'Good bow distribution — using the full length of the bow.',
    summaryWithIssues: (_count, ratePct) =>
      ratePct >= 70
        ? 'Mostly using the middle of the bow — strokes rarely reach tip or frog.'
        : 'Bow usage was somewhat limited in range.',
  },

  // ─── LEFT HAND ────────────────────────────────────────────────────────────────

  {
    metricKey: 'leftHandWrist',
    name: 'Left Wrist Position',
    category: 'left_hand',
    importance:
      'The left wrist must stay in a neutral, straight position to allow each finger to ' +
      'drop independently from the knuckle. A collapsed wrist forces the fingers to reach from ' +
      'the wrist joint instead, which limits speed, accuracy, and causes chronic tendinitis. ' +
      'This is one of the most common and most harmful beginner habits.',
    whatToLookFor: [
      'Deviation of wrist landmark from the line connecting index and middle MCP joints',
      'Inward wrist collapse (most common — wrist bends toward the player)',
      'Outward over-extension (less common — wrist bent away from scroll)',
      'Whether collapse worsens when reaching for 4th finger',
    ],
    violations: [
      {
        id: 'wrist_collapse',
        label: 'Wrist collapse',
        description: 'Left wrist bends inward, breaking the straight line from forearm through wrist to knuckles.',
        impact:
          'Locks up individual finger independence. Fingers must compensate by gripping from the thumb. ' +
          'Creates hand and forearm tension. Directly causes intonation problems on 3rd and 4th fingers. ' +
          'Long-term: tendinitis, repetitive strain injury.',
        threshold: 'Wrist lateral deviation from knuckle axis > 20°.',
      },
    ],
    goodDescription:
      'The forearm, wrist, and knuckle line form a straight axis. Fingers drop from the knuckle joint. ' +
      'Wrist stays neutral even when stretching to 4th finger.',
    summaryGood: () => 'Left wrist stayed well-aligned throughout.',
    summaryWithIssues: (count, ratePct) =>
      ratePct >= 50
        ? `Left wrist was collapsed ${ratePct}% of the session.`
        : `Left wrist collapsed ${count} ${count === 1 ? 'time' : 'times'}.`,
  },

  // ─── SOUND METRICS ────────────────────────────────────────────────────────────

  {
    metricKey: 'pitchAccuracy',
    name: 'Intonation',
    category: 'sound',
    importance:
      'Pitch accuracy is the most audible measure of violin playing. ' +
      'Notes that are even 15 cents off will clash with accompaniment and sound unmusical. ' +
      'Intonation problems usually trace back to finger placement habits, tension, or inadequate ear training.',
    whatToLookFor: [
      'YIN-detected frequency vs. nearest chromatic note for each 50ms window',
      'Number and duration of passages where pitch deviates > 25 cents',
      'Flat vs. sharp tendencies (systematic error vs. random)',
      'Whether intonation deteriorates in difficult passages',
    ],
    violations: [
      {
        id: 'out_of_tune',
        label: 'Out-of-tune notes',
        description: 'Detected pitch deviates more than 25 cents from the nearest chromatic note.',
        impact:
          'Audibly out of tune to any listener. In ensemble context creates dissonance. ' +
          'Uncorrected, it reinforces wrong finger position muscle memory.',
        threshold: 'Pitch deviation > 25 cents from nearest equal-tempered note.',
      },
      {
        id: 'flat_tendency',
        label: 'Flat tendency',
        description: 'Notes are systematically below target pitch.',
        impact:
          'Indicates fingers are placed too low on the fingerboard. ' +
          'Flat tendencies are common on the 3rd and 4th fingers.',
        threshold: 'Mean cents deviation < -15 cents across the session.',
      },
    ],
    goodDescription:
      'Notes land within ±15 cents of target consistently. ' +
      'Open string sympathetic resonance is audible, confirming accurate intonation.',
    summaryGood: () => 'Intonation was accurate throughout the session.',
    summaryWithIssues: (count, ratePct) =>
      ratePct >= 30
        ? `Intonation was off in ${ratePct}% of detected notes.`
        : `${count} ${count === 1 ? 'passage was' : 'passages were'} noticeably out of tune.`,
  },

  {
    metricKey: 'intonationStability',
    name: 'Pitch Stability',
    category: 'sound',
    importance:
      'Sustained notes must hold their pitch without wavering. ' +
      'Unstable pitch on held notes indicates bow pressure inconsistency, left thumb tension, ' +
      'or bow speed fluctuation. It is distinct from vibrato, which is intentional oscillation.',
    whatToLookFor: [
      'Standard deviation of pitch across sustained note windows',
      'Unintentional pitch drift on held notes (not vibrato)',
      'Whether instability occurs at specific dynamic levels or bow speeds',
    ],
    violations: [
      {
        id: 'pitch_drift',
        label: 'Pitch wavering',
        description: 'Sustained note pitch oscillates unintentionally or drifts from target.',
        impact:
          'Makes long notes sound nervous or unsupported. ' +
          'Often confused with vibrato by the ear but sounds uncontrolled. ' +
          'Common cause: tight left thumb transmitting arm shake into the finger.',
        threshold: 'Pitch standard deviation on sustained notes > 15 cents.',
      },
    ],
    goodDescription:
      'Held notes stay locked to their target pitch. Bow speed is consistent, ' +
      'left thumb is relaxed. Any pitch oscillation is intentional vibrato.',
    summaryGood: () => 'Sustained notes held their pitch steadily.',
    summaryWithIssues: (_count, ratePct) =>
      ratePct >= 40
        ? `Pitch was unstable on held notes — wavering detected ${ratePct}% of the time.`
        : 'Some pitch wavering on held notes.',
  },

  {
    metricKey: 'toneQuality',
    name: 'Tone Quality',
    category: 'sound',
    importance:
      'Tone quality describes the richness and character of the sound. ' +
      'A good violin tone is full of overtones with a clear fundamental. ' +
      'Scratchy tone means insufficient bow speed or excessive pressure. ' +
      'Thin tone means too little bow weight or contact point too close to the fingerboard.',
    whatToLookFor: [
      'FFT fundamental-to-total-power ratio across 100ms windows',
      'Frames with ratio below 0.08 (scratchy: too much noise relative to fundamental)',
      'Frames with ratio near 0 but non-silent (not enough string engagement)',
      'Consistency of tone quality across the session',
    ],
    violations: [
      {
        id: 'scratchy_tone',
        label: 'Scratchy tone',
        description: 'High noise content relative to fundamental — the string is being forced rather than drawn.',
        impact:
          'Unpleasant to listen to. Indicates bow moving too slowly for the weight applied, ' +
          'or contact point too close to the bridge. ' +
          'Signals a mismatch between bow speed, weight, and contact point.',
        threshold: 'FFT fundamental ratio < 0.08 in non-silent frame.',
      },
      {
        id: 'thin_tone',
        label: 'Thin tone',
        description: 'Very low fundamental power — string is not vibrating fully.',
        impact:
          'Produces a whispy, unsupported sound. Often caused by bow not engaging the string ' +
          '(too little weight), or bow contact too close to the fingerboard.',
        threshold: 'FFT fundamental ratio < 0.04 in non-silent frame.',
      },
    ],
    goodDescription:
      'Fundamental pitch is clear and dominant in the spectrum. Overtones are present but balanced. ' +
      'Sound is full and resonant without scratch or surface noise.',
    summaryGood: () => 'Tone was full and resonant throughout.',
    summaryWithIssues: (_count, ratePct) =>
      ratePct >= 40
        ? `Scratchy or thin tone was present in ${ratePct}% of the session.`
        : `Some tone quality issues detected — ${ratePct}% of the session.`,
  },

  {
    metricKey: 'bowSmoothness',
    name: 'Bow Changes',
    category: 'bow_arm',
    importance:
      'A smooth bow direction change is invisible to the listener — the musical line continues unbroken. ' +
      'An abrupt change creates an audible "bump" that interrupts phrasing. ' +
      'Smooth changes require a curved wrist motion (like tracing an oval) rather than a sharp reversal.',
    whatToLookFor: [
      'Sudden amplitude dips or spikes in the RMS envelope',
      'Transitions where amplitude drops then sharply recovers (hallmark of an abrupt stop-and-restart)',
      'Direction-change events occurring outside the natural envelope shape',
    ],
    violations: [
      {
        id: 'abrupt_bow_change',
        label: 'Abrupt bow change',
        description: 'Sharp amplitude discontinuity at a bow direction change, creating an audible bump.',
        impact:
          'Interrupts the musical phrase. Sounds choppy and mechanical. ' +
          'Often caused by stopping the bow at the tip or frog before reversing, ' +
          'or by tension in the bow arm preventing the curved change motion.',
        threshold: 'RMS amplitude change > 0.12 in a single 20ms hop, after a stable period.',
      },
    ],
    goodDescription:
      'Bow direction changes are seamless. The amplitude envelope shows a smooth curved transition ' +
      'with no dips or bumps. The listener cannot detect where down-bow ends and up-bow begins.',
    summaryGood: () => 'Bow changes were smooth throughout.',
    summaryWithIssues: (count, _ratePct) =>
      count === 1
        ? '1 abrupt bow change detected.'
        : `${count} abrupt bow changes detected.`,
  },

  {
    metricKey: 'vibrato',
    name: 'Vibrato',
    category: 'left_hand',
    importance:
      'Vibrato adds warmth, expression, and sustain to the violin tone. ' +
      'An even vibrato at 4–7 Hz signals a relaxed, free left hand. ' +
      'Absent vibrato on long notes makes the sound flat and lifeless. ' +
      'Mechanical or too-fast vibrato (> 8 Hz) indicates left-hand tension.',
    whatToLookFor: [
      'Zero-crossing rate in pitch derivative as a proxy for vibrato frequency',
      'Presence of consistent pitch oscillation on held notes',
      'Rate (Hz) and regularity of oscillation',
      'Whether vibrato is present on long notes vs. short notes',
    ],
    violations: [
      {
        id: 'vibrato_absent',
        label: 'No vibrato',
        description: 'Pitch oscillation is absent or minimal on notes that would benefit from vibrato.',
        impact:
          'Long notes sound static and emotionally flat. ' +
          'At performance level, vibrato is expected on all long notes. ' +
          'Often indicates a tight left thumb or underdeveloped wrist oscillation technique.',
        threshold: 'Vibrato zero-crossing rate < 20% of expected rate for 5 Hz oscillation.',
      },
      {
        id: 'vibrato_inconsistent',
        label: 'Inconsistent vibrato',
        description: 'Vibrato starts, stops, or changes rate mid-note unpredictably.',
        impact:
          'Sounds nervous and uncontrolled. Interrupts the singing quality of the tone.',
        threshold: 'High variability in vibrato rate across the session.',
      },
    ],
    goodDescription:
      'Consistent vibrato at 4–7 Hz on all long notes. ' +
      'Vibrato continues through bow changes without interruption. ' +
      'The left hand oscillation is smooth and even.',
    summaryGood: () => 'Vibrato was present and consistent.',
    summaryWithIssues: (_count, ratePct) =>
      ratePct >= 60
        ? 'Vibrato was mostly absent during the session.'
        : 'Vibrato was limited or inconsistent.',
  },

  {
    metricKey: 'rhythmAccuracy',
    name: 'Rhythm',
    category: 'sound',
    importance:
      'Rhythmic consistency is the foundation of musical communication. ' +
      'Uneven note durations make the pulse unclear and prevent ensemble playing. ' +
      'Common problems: rushing during technically difficult passages, ' +
      'or dragging on long notes.',
    whatToLookFor: [
      'Inter-onset intervals (IOIs) between detected note onsets',
      'Coefficient of variation (CV) of IOIs — high CV means uneven rhythm',
      'Systematic rushing (IOIs shortening over a phrase)',
      'Systematic dragging (IOIs lengthening on held notes)',
    ],
    violations: [
      {
        id: 'rhythm_unsteady',
        label: 'Unsteady rhythm',
        description: 'Note durations are highly variable — the pulse is not consistently maintained.',
        impact:
          'Makes the piece sound unstructured and technically unreliable. ' +
          'Cannot play with accompaniment or ensemble if rhythm is inconsistent.',
        threshold: 'IOI coefficient of variation > 0.3.',
      },
    ],
    goodDescription:
      'Note onsets are evenly spaced with minimal variation. ' +
      'IOI coefficient of variation < 0.15. ' +
      'The pulse feels natural and steady even through difficult passages.',
    summaryGood: () => 'Rhythm was steady throughout the session.',
    summaryWithIssues: (_count, ratePct) =>
      ratePct >= 40
        ? `Rhythm was significantly unsteady — note durations varied by more than expected.`
        : 'Some rhythmic inconsistency detected.',
  },

  {
    metricKey: 'dynamicControl',
    name: 'Dynamics',
    category: 'sound',
    importance:
      'Intentional dynamic variation is what separates musical playing from mere note-playing. ' +
      'All music has phrasing — rises and falls, tension and release. ' +
      'A player who plays everything at the same volume is not yet making music, only pitches.',
    whatToLookFor: [
      'RMS envelope variance: intentional dynamics vs. unintentional fluctuation',
      'Overall dynamic range: difference between quietest and loudest passage',
      'Whether volume changes are gradual (musical) or sudden (unintentional)',
      'Presence of accent patterns appropriate to the musical context',
    ],
    violations: [
      {
        id: 'dynamics_flat',
        label: 'Flat dynamics',
        description: 'Overall volume stays at roughly the same level with very little intentional variation.',
        impact:
          'Music sounds mechanical and unexpressive. ' +
          'Even technically correct notes feel unmusical without dynamic shaping.',
        threshold: 'Slow-fluctuation variance of RMS envelope < threshold indicating insufficient dynamic range.',
      },
    ],
    goodDescription:
      'Clear dynamic contrast between phrases. ' +
      'Crescendos and decrescendos are intentional and well-controlled. ' +
      'Quietest and loudest passages are clearly distinguishable.',
    summaryGood: () => 'Good dynamic variety throughout.',
    summaryWithIssues: (_count, _ratePct) =>
      'Dynamics were relatively flat — limited volume variation.',
  },
];

// Keyed lookup for convenience
export const TECHNIQUE_SPEC_BY_KEY: Partial<Record<MetricKey, TechniqueSpecEntry>> =
  Object.fromEntries(TECHNIQUE_SPEC.map((e) => [e.metricKey, e]));
