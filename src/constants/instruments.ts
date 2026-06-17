import { InstrumentConfig } from '../types/instrument';

export const INSTRUMENTS: Record<string, InstrumentConfig> = {
  violin: {
    id: 'violin',
    displayName: 'Violin',
    pitchRangeLow: 196.0,   // G3
    pitchRangeHigh: 3520.0, // A7
    strings: [
      { name: 'G', openFrequency: 196.0 },
      { name: 'D', openFrequency: 293.66 },
      { name: 'A', openFrequency: 440.0 },
      { name: 'E', openFrequency: 659.25 },
    ],
    bowArmThresholds: {
      elbowHeightLow: -0.05,   // slightly below shoulder for E string
      elbowHeightHigh: 0.15,   // above shoulder for G string
      angleToleranceDeg: 15,
      placementZones: {
        sulTasto: 0.35,
        normal: [0.35, 0.65],
        sulPonticello: 0.65,
      },
    },
    postureThresholds: {
      shoulderLevelDeltaMax: 20,
      headTiltMax: 15,
      violinAngleMin: 0,
      violinAngleMax: 45,
    },
    skillWeights: {
      beginner: {
        pitchAccuracy: 0.35,
        toneQuality: 0.20,
        bowSmoothness: 0.15,
        bowPlacement: 0.15,
        rhythmAccuracy: 0.10,
        posture: 0.05,
        vibrato: 0.00,
      },
      intermediate: {
        pitchAccuracy: 0.25,
        toneQuality: 0.20,
        bowSmoothness: 0.15,
        bowPlacement: 0.15,
        rhythmAccuracy: 0.10,
        posture: 0.05,
        vibrato: 0.10,
      },
      advanced: {
        pitchAccuracy: 0.20,
        toneQuality: 0.20,
        bowSmoothness: 0.10,
        bowPlacement: 0.10,
        rhythmAccuracy: 0.10,
        posture: 0.05,
        vibrato: 0.25,
      },
    },
    available: true,
  },

  viola: {
    id: 'viola',
    displayName: 'Viola',
    pitchRangeLow: 130.81,  // C3
    pitchRangeHigh: 2637.0, // E7
    strings: [
      { name: 'C', openFrequency: 130.81 },
      { name: 'G', openFrequency: 196.0 },
      { name: 'D', openFrequency: 293.66 },
      { name: 'A', openFrequency: 440.0 },
    ],
    bowArmThresholds: {
      elbowHeightLow: 0.0,
      elbowHeightHigh: 0.20,
      angleToleranceDeg: 15,
      placementZones: {
        sulTasto: 0.35,
        normal: [0.35, 0.65],
        sulPonticello: 0.65,
      },
    },
    postureThresholds: {
      shoulderLevelDeltaMax: 20,
      headTiltMax: 15,
      violinAngleMin: 0,
      violinAngleMax: 45,
    },
    skillWeights: {
      beginner: {
        pitchAccuracy: 0.35,
        toneQuality: 0.20,
        bowSmoothness: 0.15,
        bowPlacement: 0.15,
        rhythmAccuracy: 0.10,
        posture: 0.05,
        vibrato: 0.00,
      },
      intermediate: {
        pitchAccuracy: 0.25,
        toneQuality: 0.20,
        bowSmoothness: 0.15,
        bowPlacement: 0.15,
        rhythmAccuracy: 0.10,
        posture: 0.05,
        vibrato: 0.10,
      },
      advanced: {
        pitchAccuracy: 0.20,
        toneQuality: 0.20,
        bowSmoothness: 0.10,
        bowPlacement: 0.10,
        rhythmAccuracy: 0.10,
        posture: 0.05,
        vibrato: 0.25,
      },
    },
    available: false, // coming soon
  },

  cello: {
    id: 'cello',
    displayName: 'Cello',
    pitchRangeLow: 65.41,   // C2
    pitchRangeHigh: 1760.0, // A5
    strings: [
      { name: 'C', openFrequency: 65.41 },
      { name: 'G', openFrequency: 98.0 },
      { name: 'D', openFrequency: 146.83 },
      { name: 'A', openFrequency: 220.0 },
    ],
    bowArmThresholds: {
      // Cello bow arm geometry is horizontal, very different from violin
      elbowHeightLow: -0.20,
      elbowHeightHigh: 0.05,
      angleToleranceDeg: 20,
      placementZones: {
        sulTasto: 0.30,
        normal: [0.30, 0.60],
        sulPonticello: 0.60,
      },
    },
    postureThresholds: {
      // Cello is held between knees — posture rules differ significantly
      shoulderLevelDeltaMax: 25,
      headTiltMax: 20,
      violinAngleMin: 60,   // cello is near vertical
      violinAngleMax: 90,
    },
    skillWeights: {
      beginner: {
        pitchAccuracy: 0.35,
        toneQuality: 0.20,
        bowSmoothness: 0.15,
        bowPlacement: 0.15,
        rhythmAccuracy: 0.10,
        posture: 0.05,
        vibrato: 0.00,
      },
      intermediate: {
        pitchAccuracy: 0.25,
        toneQuality: 0.20,
        bowSmoothness: 0.15,
        bowPlacement: 0.15,
        rhythmAccuracy: 0.10,
        posture: 0.05,
        vibrato: 0.10,
      },
      advanced: {
        pitchAccuracy: 0.20,
        toneQuality: 0.20,
        bowSmoothness: 0.10,
        bowPlacement: 0.10,
        rhythmAccuracy: 0.10,
        posture: 0.05,
        vibrato: 0.25,
      },
    },
    available: false, // coming soon
  },
};
