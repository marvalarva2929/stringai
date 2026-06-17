export type InstrumentId = 'violin' | 'viola' | 'cello';

export interface StringConfig {
  name: string;
  openFrequency: number; // Hz
}

export interface BowArmThresholds {
  elbowHeightLow: number;   // relative to shoulder, for lowest string
  elbowHeightHigh: number;  // relative to shoulder, for highest string
  angleToleranceDeg: number;
  placementZones: {
    sulTasto: number;       // wrist x ratio where sul tasto begins
    normal: [number, number];
    sulPonticello: number;  // wrist x ratio where sul ponticello begins
  };
}

export interface PostureThresholds {
  shoulderLevelDeltaMax: number; // px difference allowed
  headTiltMax: number;           // degrees
  violinAngleMin: number;
  violinAngleMax: number;
}

export interface SkillWeights {
  pitchAccuracy: number;
  toneQuality: number;
  bowSmoothness: number;
  bowPlacement: number;
  rhythmAccuracy: number;
  posture: number;
  vibrato: number;
}

export interface InstrumentConfig {
  id: InstrumentId;
  displayName: string;
  pitchRangeLow: number;  // Hz (lowest open string)
  pitchRangeHigh: number; // Hz (highest playable note)
  strings: StringConfig[];
  bowArmThresholds: BowArmThresholds;
  postureThresholds: PostureThresholds;
  skillWeights: {
    beginner: SkillWeights;
    intermediate: SkillWeights;
    advanced: SkillWeights;
  };
  available: boolean;
}
