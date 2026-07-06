import { InstrumentId } from './instrument';
import { PlayerCategory } from './analysis';

export type SkillLevel = 'beginner' | 'intermediate' | 'advanced';
export type SubscriptionTier = 'free' | 'monthly' | 'annual';

export interface UserProfile {
  id: string;
  email: string;
  displayName?: string;
  instrument: InstrumentId;
  skillLevel: SkillLevel;
  playerCategory?: PlayerCategory;
  weeklyGoalMinutes?: number;
  freeAnalysesUsed: number;
  subscriptionTier: SubscriptionTier;
  createdAt: string;
}
