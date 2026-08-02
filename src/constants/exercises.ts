import type { MetricKey } from '../types/analysis';

export type Difficulty = 'beginner' | 'intermediate' | 'advanced';

export interface Exercise {
  id: string;
  metricKey: MetricKey;
  title: string;
  duration: string;
  difficulty: Difficulty;
  focus: string;
  instructions: string;
}

export const EXERCISES: Exercise[] = [

  // ── Pitch Accuracy ───────────────────────────────────────────────────────────
  {
    id: 'pitch-drone-scale',
    metricKey: 'pitchAccuracy',
    title: 'Drone Tuner Scale',
    duration: '5–10 min',
    difficulty: 'beginner',
    focus: 'Lock each finger to the correct pitch with a sustained reference tone.',
    instructions:
      'Set a tuner app or electronic tuner to drone the tonic (G for G major, etc.). ' +
      'Play each note of a one-octave scale. Pause on every note for two full bow strokes. ' +
      'Only move to the next note when you hear the interval resonate cleanly. ' +
      'Repeat the whole scale 3 times before adding any tempo.',
  },
  {
    id: 'pitch-stop-and-check',
    metricKey: 'pitchAccuracy',
    title: 'Stop-and-Check',
    duration: '5 min',
    difficulty: 'beginner',
    focus: 'Build habit of listening before moving to the next note.',
    instructions:
      'Choose any 4-bar passage. After every note, lift the bow and silently check: ' +
      'is this pitch resonating with the open string above or below? Adjust the finger before placing the bow again. ' +
      'This is slow, deliberate work. Never move to the next note until the current one rings.',
  },
  {
    id: 'pitch-finger-tapes',
    metricKey: 'pitchAccuracy',
    title: 'Tape Marker Targets',
    duration: '10 min',
    difficulty: 'beginner',
    focus: 'Physical reference points for finger placement.',
    instructions:
      'Place a small piece of tape on each string for 1st, 2nd, 3rd, and 4th finger in first position. ' +
      'Play the scale using the tape as landing targets. After two weeks of consistent practice, ' +
      'remove one tape at a time, retaining the muscle memory.',
  },
  {
    id: 'pitch-interval-singing',
    metricKey: 'pitchAccuracy',
    title: 'Sing-then-Play',
    duration: '5 min',
    difficulty: 'intermediate',
    focus: 'Train the ear to lead the finger.',
    instructions:
      'Sing a phrase from your piece out loud (or hum), then play it immediately. ' +
      'Your voice pitch should match what your fingers produce. ' +
      'Where they diverge, your ear has not yet memorized the target. ' +
      'Repeat those specific intervals until singing and playing agree.',
  },

  // ── Intonation Stability ──────────────────────────────────────────────────────
  {
    id: 'stability-open-string-check',
    metricKey: 'intonationStability',
    title: 'Open String Bow Pressure Test',
    duration: '3 min',
    difficulty: 'beginner',
    focus: 'Isolate bow pressure from pitch drift.',
    instructions:
      'Play open A for 4 full bow strokes listening only for consistency — no fingers. ' +
      'If the pitch drifts or wobbles, the issue is bow-arm pressure, not the left hand. ' +
      'Find the bow weight that produces a clear, steady tone, then add the first finger.',
  },
  {
    id: 'stability-long-note-hold',
    metricKey: 'intonationStability',
    title: 'Long Note Hold',
    duration: '5 min',
    difficulty: 'beginner',
    focus: 'Sustain pitch perfectly across the full bow.',
    instructions:
      'Play first finger B on the A string. Hold for 8 full bow counts (4 down, 4 up). ' +
      'Focus: bow speed must be perfectly constant. Any speed change shifts pitch slightly. ' +
      'Use a digital tuner in "strobe" mode to see pitch drift in real time.',
  },
  {
    id: 'stability-thumb-release',
    metricKey: 'intonationStability',
    title: 'Left Thumb Release',
    duration: '5 min',
    difficulty: 'intermediate',
    focus: 'Remove left-hand tension that causes pitch wobble.',
    instructions:
      'Play a slow scale while consciously releasing the left thumb every two notes. ' +
      'The thumb should stay relaxed and gently touching, never gripping. ' +
      'A tight thumb transmits tension to the fingers and makes pitch unstable. ' +
      'If the thumb habit is strong, practice without the thumb touching for one minute.',
  },
  {
    id: 'stability-vibrato-separation',
    metricKey: 'intonationStability',
    title: 'Straight Tone Isolation',
    duration: '5 min',
    difficulty: 'intermediate',
    focus: 'Separate vibrato from pitch instability.',
    instructions:
      'Play a passage completely without vibrato. Listen carefully: any pitch drift is now pure intonation. ' +
      'Mark the notes that wander. Next, add vibrato only on the notes that were in tune. ' +
      'Vibrato should ornament accurate pitch, not mask imprecise fingers.',
  },

  // ── Tone Quality ──────────────────────────────────────────────────────────────
  {
    id: 'tone-contact-point',
    metricKey: 'toneQuality',
    title: 'Contact Point Awareness',
    duration: '5 min',
    difficulty: 'beginner',
    focus: 'Find the resonant zone between bridge and fingerboard.',
    instructions:
      'Play open D string. Slowly slide the bow from fingerboard to bridge over 30 seconds. ' +
      'Notice: near the fingerboard = thin/fuzzy, near the bridge = bright/intense. ' +
      'The sweet spot for most passages is halfway between. Mark this zone mentally.',
  },
  {
    id: 'tone-arm-weight',
    metricKey: 'toneQuality',
    title: 'Arm Weight Drill',
    duration: '5 min',
    difficulty: 'beginner',
    focus: 'Use gravity instead of finger pressure for rich tone.',
    instructions:
      'Open D, whole bow. Let your arm feel heavy — imagine your elbow is a sandbag. ' +
      'Do NOT press harder with the fingers. The weight comes from the shoulder and upper arm. ' +
      'If you hear scratch, slow the bow speed first. A common mistake is using pressure to compensate for speed.',
  },
  {
    id: 'tone-three-speeds',
    metricKey: 'toneQuality',
    title: 'Three-Speed Comparison',
    duration: '5 min',
    difficulty: 'intermediate',
    focus: 'Map bow speed to tone quality across the dynamic range.',
    instructions:
      'Play open G at three speeds: very slow (piano), medium (mezzo-forte), and fast (forte). ' +
      'Each speed should produce a different dynamic but equally good tone — no scratch at any speed. ' +
      'Adjust arm weight up as speed increases. Record yourself: listen for the scratchy threshold.',
  },
  {
    id: 'tone-resonance-test',
    metricKey: 'toneQuality',
    title: 'Sympathetic Resonance Check',
    duration: '3 min',
    difficulty: 'intermediate',
    focus: 'Confirm tone quality through open string ringing.',
    instructions:
      'Play first finger A on the G string (concert A). Release the bow and listen. ' +
      'Does the open A string ring sympathetically? If so, your intonation and tone are clean. ' +
      'Do this test on every note of the scale: D and A strings resonate beautifully when notes ring true.',
  },

  // ── Bow Smoothness ────────────────────────────────────────────────────────────
  {
    id: 'smooth-oval-change',
    metricKey: 'bowSmoothness',
    title: 'Oval Bow Change',
    duration: '5 min',
    difficulty: 'beginner',
    focus: 'Eliminate the bump at direction reversal.',
    instructions:
      'Open G, very slow whole bow (8 counts each direction). ' +
      'At the tip and frog, imagine your bow arm traces an oval rather than a hard corner. ' +
      'The wrist leads slightly at the tip, the elbow at the frog. ' +
      'Record and listen for the bump — it disappears when the motion becomes a smooth arc.',
  },
  {
    id: 'smooth-soft-landing',
    metricKey: 'bowSmoothness',
    title: 'Soft Landing at Frog',
    duration: '5 min',
    difficulty: 'beginner',
    focus: 'Reduce the heavy accent that happens at the frog.',
    instructions:
      'The frog has the most bow weight, so bow changes there often sound bumpy. ' +
      'Practice reaching the frog with a slight reduction in arm weight — "float in" rather than land. ' +
      'Think of the up-bow arriving at the frog like an airplane landing: gradual, not a thud.',
  },
  {
    id: 'smooth-portato',
    metricKey: 'bowSmoothness',
    title: 'Portato Legato Bridge',
    duration: '5 min',
    difficulty: 'intermediate',
    focus: 'Build smooth bow changes through controlled air note.',
    instructions:
      'Play two long notes on the same bow direction with a slight pause between them (portato). ' +
      'The pause teaches you to release weight at the direction change. ' +
      'Gradually shorten the pause until the two notes merge into a seamless legato bow change.',
  },
  {
    id: 'smooth-phrase-legato',
    metricKey: 'bowSmoothness',
    title: 'Sustained Phrase Legato',
    duration: '10 min',
    difficulty: 'advanced',
    focus: 'Carry musical line across multiple bow changes.',
    instructions:
      'Take a singing phrase from your piece and play it at half tempo, slurring everything. ' +
      'The musical phrase should feel like one breath. Add bow changes back in gradually, ' +
      'ensuring each direction change is inaudible. The test: can a listener hear where the bow changed?',
  },

  // ── Vibrato ───────────────────────────────────────────────────────────────────
  {
    id: 'vibrato-wrist-wave',
    metricKey: 'vibrato',
    title: 'Wrist Wave Without Bow',
    duration: '5 min',
    difficulty: 'beginner',
    focus: 'Establish the vibrato motion in isolation.',
    instructions:
      'Without the bow, place 1st finger on A string. Rock the wrist (not the arm) ' +
      'forward and back in a slow, even rhythm (2 Hz). Keep the thumb relaxed. ' +
      'The motion is like gently "tapping" the fingerboard repeatedly from the wrist. ' +
      'Add the bow only when the motion is completely free and automatic.',
  },
  {
    id: 'vibrato-arm-motion',
    metricKey: 'vibrato',
    title: 'Arm Vibrato Foundation',
    duration: '5 min',
    difficulty: 'beginner',
    focus: 'Learn the arm-vibrato alternative or complement.',
    instructions:
      'Place 3rd finger on D string. Flex from the elbow (not the wrist) — the whole forearm ' +
      'moves slightly forward and back. This arm vibrato often feels easier for students with wrist tension. ' +
      'Combine wrist and arm motion for a wider, warmer vibrato.',
  },
  {
    id: 'vibrato-rhythm-grid',
    metricKey: 'vibrato',
    title: 'Rhythmic Vibrato Grid',
    duration: '5 min',
    difficulty: 'intermediate',
    focus: 'Develop evenness and control of vibrato speed.',
    instructions:
      'Set a metronome to 60 BPM. On each beat, do exactly 2 vibrato oscillations. ' +
      'Then do 3, then 4. The key is evenness — each oscillation must be the same width and speed. ' +
      'This builds the motor control to choose and maintain a vibrato rate.',
  },
  {
    id: 'vibrato-through-bow-change',
    metricKey: 'vibrato',
    title: 'Continuous Vibrato Through Change',
    duration: '5 min',
    difficulty: 'advanced',
    focus: 'Keep vibrato flowing across bow direction changes.',
    instructions:
      'Play a long note with vibrato, then change bow direction without interrupting the vibrato oscillation. ' +
      'The most common error: the vibrato stops for a moment at the bow change. ' +
      'Think of the vibrato as a separate, independent motion that runs underneath the bow changes.',
  },

  // ── Rhythm ────────────────────────────────────────────────────────────────────
  {
    id: 'rhythm-fragment',
    metricKey: 'rhythmAccuracy',
    title: 'Two-Note Fragments',
    duration: '5 min',
    difficulty: 'beginner',
    focus: 'Lock the interval between two adjacent notes.',
    instructions:
      'Set metronome to 60 BPM. Play only the first two notes of a phrase, then stop. ' +
      'Were they in time? If yes, add one more note. Build the phrase two notes at a time. ' +
      'Counting out loud is mandatory — the count should never stop, even when you do.',
  },
  {
    id: 'rhythm-rest-reenter',
    metricKey: 'rhythmAccuracy',
    title: 'Rest and Re-enter',
    duration: '5 min',
    difficulty: 'beginner',
    focus: 'Internalize the pulse between phrases.',
    instructions:
      'Play one measure, rest one measure (counting silently), play the next. ' +
      'The rest forces you to hear the metronome inside your head. ' +
      'When you re-enter exactly on the beat, you know the pulse is internalized.',
  },
  {
    id: 'rhythm-subdivide',
    metricKey: 'rhythmAccuracy',
    title: 'Subdivision Counting',
    duration: '5 min',
    difficulty: 'intermediate',
    focus: 'Feel eighth notes inside every quarter note beat.',
    instructions:
      'Set metronome to a comfortable tempo. While playing, count "1-and-2-and-3-and-4-and" out loud. ' +
      'Every "and" is the eighth note subdivision. Long notes should still feel every subdivision. ' +
      'This reveals where the pulse is drifting — usually on long notes and rests.',
  },
  {
    id: 'rhythm-grouping',
    metricKey: 'rhythmAccuracy',
    title: 'Note Grouping Challenge',
    duration: '10 min',
    difficulty: 'advanced',
    focus: 'Feel rhythmic groupings across barlines.',
    instructions:
      'Take a passage and group notes into fours across barlines: 1-2-3-4, 1-2-3-4. ' +
      'This breaks the habit of rushing or slowing at barlines. ' +
      'After 5 minutes, play the same passage with the normal bar grouping — it should feel steadier.',
  },

  // ── Dynamics ──────────────────────────────────────────────────────────────────
  {
    id: 'dynamics-two-sounds',
    metricKey: 'dynamicControl',
    title: 'Two Distinct Sounds',
    duration: '5 min',
    difficulty: 'beginner',
    focus: 'Hear a real difference between piano and forte.',
    instructions:
      'Open A string: 4 bows at whisper-soft (near fingerboard, very slow bow, almost no weight). ' +
      'Then 4 bows at full forte (full arm weight, fast bow, normal contact point). ' +
      'Alternate 5 times. Record yourself: the two sounds should be obviously different on playback.',
  },
  {
    id: 'dynamics-speed-gradient',
    metricKey: 'dynamicControl',
    title: 'Bow Speed Gradient',
    duration: '5 min',
    difficulty: 'beginner',
    focus: 'Use bow speed as the primary dynamic control.',
    instructions:
      'Open G string, 8 counts per bow. Start at a slow bow (piano) and gradually increase speed ' +
      'so that by the 8th count you are at a fast bow (forte). This is a single crescendo in one bow. ' +
      'Do the reverse: fast to slow is a decrescendo. Repeat 5 times each direction.',
  },
  {
    id: 'dynamics-phrase-arc',
    metricKey: 'dynamicControl',
    title: 'Phrase Shape Arc',
    duration: '10 min',
    difficulty: 'intermediate',
    focus: 'Shape a phrase with a natural dynamic rise and fall.',
    instructions:
      'Choose a 4–8 bar phrase. Decide: where is the highest point? Mark it. ' +
      'Now play the phrase so the dynamic grows from the start to that peak, then recedes. ' +
      'The arc should feel inevitable, not mechanical. Try 3 different peak locations and choose the best.',
  },
  {
    id: 'dynamics-inner-voice',
    metricKey: 'dynamicControl',
    title: 'Inner Voice Shading',
    duration: '10 min',
    difficulty: 'advanced',
    focus: 'Add micro-dynamic shaping within a single phrase.',
    instructions:
      'Play a phrase and give a slightly different weight to each note. ' +
      'Even within a phrase marked "mp", some notes should be slightly more present than others. ' +
      'These micro-dynamics are what separate musical playing from technically correct playing.',
  },

  // ── Bow Placement ─────────────────────────────────────────────────────────────
  {
    id: 'placement-tape-drill',
    metricKey: 'bowPlacement',
    title: 'Tape Marker Drill',
    duration: '10 min',
    difficulty: 'beginner',
    focus: 'Create a physical target for the correct contact zone.',
    instructions:
      'Place a small strip of tape across all four strings, halfway between bridge and end of fingerboard. ' +
      'Practice whole bows on each open string, keeping the bow hair touching the tape line. ' +
      'Set up your phone to record from the side so you can observe placement drift.',
  },
  {
    id: 'placement-string-ringing',
    metricKey: 'bowPlacement',
    title: 'String Resonance Test',
    duration: '3 min',
    difficulty: 'beginner',
    focus: 'Hear how contact point affects tone and resonance.',
    instructions:
      'Play open D at three contact points: near fingerboard, middle zone, near bridge. ' +
      'Listen: middle zone produces the clearest resonance. ' +
      'Near the fingerboard gives a hollow sound; near the bridge gives a whistling, glassy tone. ' +
      'Your target is the middle zone for most passages.',
  },
  {
    id: 'placement-zone-shifts',
    metricKey: 'bowPlacement',
    title: 'Intentional Zone Shifts',
    duration: '5 min',
    difficulty: 'intermediate',
    focus: 'Learn to move between zones intentionally for color.',
    instructions:
      'Practice moving from normal zone to sul tasto (near fingerboard) and back on command. ' +
      'Use a 4-bar phrase: bars 1–2 in normal zone, bars 3–4 sul tasto, repeat back to normal. ' +
      'The point is control: you should always know where your bow is, not drift accidentally.',
  },
  {
    id: 'placement-side-camera',
    metricKey: 'bowPlacement',
    title: 'Side-Camera Self-Review',
    duration: '5 min',
    difficulty: 'beginner',
    focus: 'Use video to see bow drift you cannot feel.',
    instructions:
      'Set up your phone on a table at instrument height, recording from directly to your right. ' +
      'Play a passage. Watch the playback: does the bow maintain position or drift toward the fingerboard? ' +
      'Most players cannot feel placement drift until they see it on video. Do this weekly.',
  },

  // ── Bow Angle ─────────────────────────────────────────────────────────────────
  {
    id: 'angle-mirror-check',
    metricKey: 'bowAngle',
    title: 'Mirror Perpendicular Check',
    duration: '5 min',
    difficulty: 'beginner',
    focus: 'See and correct diagonal bow angle in real time.',
    instructions:
      'Stand sideways to a mirror. Draw slow whole bows on open D, watching the reflection. ' +
      'The bow should appear perpendicular to the strings at all times. ' +
      'Correction: right elbow leads slightly at the frog; wrist guides at the tip.',
  },
  {
    id: 'angle-eyes-closed',
    metricKey: 'bowAngle',
    title: 'Eyes-Closed Angle Feel',
    duration: '5 min',
    difficulty: 'beginner',
    focus: 'Internalize the correct angle through proprioception.',
    instructions:
      'After 10 bows in the mirror with correct angle, close your eyes and play 10 more. ' +
      'Open your eyes — did the angle drift? The goal is to feel when the bow is square ' +
      'without needing visual feedback. Alternate eyes-open and eyes-closed until they match.',
  },
  {
    id: 'angle-single-string',
    metricKey: 'bowAngle',
    title: 'Bow Tracking on One String',
    duration: '5 min',
    difficulty: 'intermediate',
    focus: 'Maintain angle through the full bow length.',
    instructions:
      'Play open D, slow whole bow. The bow hair should remain on the same string for the entire stroke. ' +
      'A crooked bow wanders off the string and loses contact quality. ' +
      'Think of the bow as a train on a track — the hair never leaves the rail.',
  },
  {
    id: 'angle-string-crossing',
    metricKey: 'bowAngle',
    title: 'String Crossing Angle Consistency',
    duration: '10 min',
    difficulty: 'advanced',
    focus: 'Keep bow square through string crossings.',
    instructions:
      'Practice alternating D–A string crossings, slow whole bows. ' +
      'Record from the front: the bow should stay perpendicular on both strings, not angle differently on each. ' +
      'The most common error is tilting the bow more on the high strings. Keep the hair flat.',
  },

  // ── Bow Arm Level ─────────────────────────────────────────────────────────────
  {
    id: 'arm-level-preset',
    metricKey: 'bowArmLevel',
    title: 'String Pre-Set Drill',
    duration: '5 min',
    difficulty: 'beginner',
    focus: 'Set elbow height before the bow lands on each string.',
    instructions:
      'Without playing, move the bow arm to each string position. G string: elbow high (forearm roughly level). ' +
      'D: elbow slightly lower. A: lower still. E: elbow lowest. ' +
      'Practice switching arm levels slowly without touching the strings. ' +
      'Only add sound when the pre-set feels natural.',
  },
  {
    id: 'arm-level-awareness',
    metricKey: 'bowArmLevel',
    title: 'Elbow Level Awareness',
    duration: '5 min',
    difficulty: 'beginner',
    focus: 'Feel the difference between string levels.',
    instructions:
      'Place the bow on G, play 4 strokes, then without lifting the bow, cross to E. ' +
      'Notice how the elbow drops. G requires the elbow to be noticeably higher than E. ' +
      'Do this G–E crossing 10 times slowly, exaggerating the elbow height difference.',
  },
  {
    id: 'arm-level-diagonal',
    metricKey: 'bowArmLevel',
    title: 'Diagonal Pattern Drill',
    duration: '10 min',
    difficulty: 'intermediate',
    focus: 'Combine elbow level with string crossings in musical context.',
    instructions:
      'Play the pattern G–D–A–E–A–D–G on open strings, one whole bow each string. ' +
      'The elbow should step down and back up like a staircase. ' +
      'Each step should happen before the bow lands. Focus on preparation, not reaction.',
  },
  {
    id: 'arm-level-two-string',
    metricKey: 'bowArmLevel',
    title: 'Two-String Arpeggio',
    duration: '10 min',
    difficulty: 'intermediate',
    focus: 'Maintain correct level through musical string crossings.',
    instructions:
      'Play a simple two-string arpeggiated pattern (e.g., G–D repeated). ' +
      'After 5 minutes of single notes, add a simple melody in first position. ' +
      'The arm level should automatically track each string change — if you focus on the arm, the music usually takes care of itself.',
  },

  // ── Bow Distribution ─────────────────────────────────────────────────────────
  {
    id: 'dist-full-bow',
    metricKey: 'bowDistribution',
    title: 'Full Bow Whole Notes',
    duration: '5 min',
    difficulty: 'beginner',
    focus: 'Reach both ends of the bow intentionally.',
    instructions:
      'Open G string, 8 counts down-bow, 8 counts up-bow. ' +
      'You must actually reach the tip (stick nearly vertical, hand at tip) and the frog (winding at fingers). ' +
      'Exaggerate the reach. After 5 minutes of this, your "normal" bow will naturally use more stick.',
  },
  {
    id: 'dist-tip-frog-touch',
    metricKey: 'bowDistribution',
    title: 'Tip-and-Frog Awareness',
    duration: '3 min',
    difficulty: 'beginner',
    focus: 'Map your bow — know where tip and frog are without looking.',
    instructions:
      'Play open D, eyes closed. Slowly draw down-bow. Stop exactly at the tip — open your eyes and look. ' +
      'Are you really at the tip? Most students stop 10 cm short. Repeat up-bow and stop at the frog. ' +
      'Do this 5 times until you can feel the exact endpoints.',
  },
  {
    id: 'dist-division-game',
    metricKey: 'bowDistribution',
    title: 'Bow Division Game',
    duration: '5 min',
    difficulty: 'intermediate',
    focus: 'Use specific portions of the bow intentionally.',
    instructions:
      'Divide the bow into 3 zones: frog third, middle third, tip third. ' +
      'Play 4 bows using only the frog third. Then 4 using only the middle. Then tip. ' +
      'Finally, play 4 bows using the whole bow — notice how much richer it sounds. ' +
      'This builds awareness of distribution rather than defaulting to the middle.',
  },
  {
    id: 'dist-sustained-phrase',
    metricKey: 'bowDistribution',
    title: 'Full-Bow Phrase Practice',
    duration: '10 min',
    difficulty: 'intermediate',
    focus: 'Carry full bow distribution into musical context.',
    instructions:
      'Take a phrase from your piece and mark where each bow starts and ends. ' +
      'If a note lasts a whole bar, use the full bow for it. ' +
      'If you run out of bow on short notes, you were not distributing evenly. ' +
      'Adjust: save bow on short notes so long notes can use the full length.',
  },

  // ── Left Hand Wrist ───────────────────────────────────────────────────────────
  {
    id: 'wrist-alignment',
    metricKey: 'leftHandWrist',
    title: 'Knuckle-Wrist-Forearm Alignment',
    duration: '5 min',
    difficulty: 'beginner',
    focus: 'Establish the neutral wrist position with all fingers.',
    instructions:
      'Hold the violin without the bow. Place all four fingers on D string in first position. ' +
      'Check: is there a straight line from your forearm through the wrist to the knuckles? ' +
      'If the wrist bends inward, move it outward until alignment is straight. ' +
      'Hold this position for 60 seconds, then tap each finger up and down 10 times.',
  },
  {
    id: 'wrist-tapping-frame',
    metricKey: 'leftHandWrist',
    title: 'Finger Tapping Frame Check',
    duration: '5 min',
    difficulty: 'beginner',
    focus: 'Move fingers from the knuckle, not a collapsed wrist.',
    instructions:
      'In neutral wrist position, tap each finger individually on the D string 10 times. ' +
      'The tap should feel like it originates from the knuckle joint, not the wrist. ' +
      'If you feel the wrist moving when a finger taps, the wrist is not neutral.',
  },
  {
    id: 'wrist-fourth-finger',
    metricKey: 'leftHandWrist',
    title: '4th Finger Reach Without Collapse',
    duration: '5 min',
    difficulty: 'intermediate',
    focus: 'Avoid wrist collapse when stretching to 4th finger.',
    instructions:
      'The 4th finger stretch is where wrist collapse most commonly occurs. ' +
      'Place 1st finger on D string, then slowly reach 4th finger to its note. ' +
      'Watch: does the wrist collapse inward as 4th reaches? Keep the wrist neutral. ' +
      'If you cannot reach 4th without collapsing, your hand frame needs daily stretching.',
  },
  {
    id: 'wrist-shifting-neutral',
    metricKey: 'leftHandWrist',
    title: 'Shifting with Neutral Wrist',
    duration: '5 min',
    difficulty: 'advanced',
    focus: 'Maintain wrist alignment through position shifts.',
    instructions:
      'Shift from 1st to 3rd position on A string, maintaining a neutral wrist throughout. ' +
      'The wrist should not collapse or bend outward during the shift. ' +
      'Go slow: check the wrist position before and after each shift. Only speed up when it is automatic.',
  },

  // ── Posture ───────────────────────────────────────────────────────────────────
  {
    id: 'posture-mirror-shoulder',
    metricKey: 'posture',
    title: 'Mirror Shoulder Check',
    duration: '5 min',
    difficulty: 'beginner',
    focus: 'Identify and correct left shoulder rise while playing.',
    instructions:
      'Stand in front of a mirror. Play a passage you know well and watch your shoulders. ' +
      'The moment you see the left shoulder creeping up, stop immediately and reset. ' +
      'Drop both shoulders, take a breath, then restart. ' +
      'Do this 5 times in a row with no shoulder rise before moving on.',
  },
  {
    id: 'posture-stop-reset',
    metricKey: 'posture',
    title: 'Stop-and-Reset Protocol',
    duration: '10 min',
    difficulty: 'beginner',
    focus: 'Build the habit of posture checking between phrases.',
    instructions:
      'At the end of every phrase (every 4–8 bars), stop completely. ' +
      'Take one breath, consciously drop your shoulders, and check your head position. ' +
      'Only then continue. This is slow at first but the habit transfers quickly.',
  },
  {
    id: 'posture-breath-release',
    metricKey: 'posture',
    title: 'Breath and Release',
    duration: '5 min',
    difficulty: 'intermediate',
    focus: 'Use breathing to release tension during playing.',
    instructions:
      'Choose a difficult passage that causes tension. Play it, and at every natural breathing point, ' +
      'take an actual physical breath and let your shoulders fall slightly. ' +
      'Tension in posture is often tied to held breath. Play the passage 5 times this way.',
  },
  {
    id: 'posture-chair-awareness',
    metricKey: 'posture',
    title: 'Seated Posture Baseline',
    duration: '5 min',
    difficulty: 'beginner',
    focus: 'Establish a neutral seated posture before adding the instrument.',
    instructions:
      'Sit in a chair without the violin. Feel both sit bones on the seat, feet flat on the floor. ' +
      'Spine tall, shoulders wide and low. Now pick up the violin — does the posture change? ' +
      'It should not. The instrument should adapt to your posture, not the other way around.',
  },
];

export function exercisesForMetric(metricKey: MetricKey): Exercise[] {
  return EXERCISES.filter((e) => e.metricKey === metricKey);
}
