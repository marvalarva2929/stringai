import { InstrumentId } from './instrument';
import { PlayerCategory } from './analysis';

export type SkillLevel = 'beginner' | 'intermediate' | 'advanced';

/** The piece a student is actively working on. Pinned to the home screen; its
 *  sessions feed a piece-scoped practice plan and a warm-up prompt. */
export interface CurrentPiece {
  pieceId: string;
  title: string;
  composer?: string;
  /** Free-text goal the student stated ("clean run for my teacher in 3 weeks"),
   *  passed to the LLM curator so selection reflects intent, not just the data. */
  goals?: string;
  startedAt: string;
}

export interface UserProfile {
  id: string;
  email: string;
  displayName?: string;
  instrument: InstrumentId;
  skillLevel: SkillLevel;
  playerCategory?: PlayerCategory;
  weeklyGoalMinutes?: number;
  /** The piece pinned as "currently practicing", if any. */
  currentPiece?: CurrentPiece;
  createdAt: string;
}
