import { create } from 'zustand';
import { UserProfile } from '../types/user';

interface UserState {
  profile: UserProfile | null;
  setProfile: (profile: UserProfile | null) => void;
  updateProfile: (partial: Partial<UserProfile>) => void;
  incrementFreeAnalyses: () => void;
  canAnalyze: () => boolean;
}

const FREE_ANALYSIS_LIMIT = 2;

export const useUserStore = create<UserState>((set, get) => ({
  profile: null,

  setProfile: (profile) => set({ profile: profile ?? null }),

  updateProfile: (partial) =>
    set((state) => ({
      profile: state.profile ? { ...state.profile, ...partial } : null,
    })),

  incrementFreeAnalyses: () =>
    set((state) => ({
      profile: state.profile
        ? { ...state.profile, freeAnalysesUsed: state.profile.freeAnalysesUsed + 1 }
        : null,
    })),

  canAnalyze: () => {
    const { profile } = get();
    if (!profile) return false;
    if (profile.subscriptionTier !== 'free') return true;
    return profile.freeAnalysesUsed < FREE_ANALYSIS_LIMIT;
  },
}));
