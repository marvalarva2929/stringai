import { create } from 'zustand';
import { UserProfile, CurrentPiece } from '../types/user';

// Profile state only. Whether a user may run an analysis is decided by
// useEntitlementStore / src/lib/entitlements.ts, and enforced server-side by
// the consume_analysis RPC.
interface UserState {
  profile: UserProfile | null;
  setProfile: (profile: UserProfile | null) => void;
  updateProfile: (partial: Partial<UserProfile>) => void;
  /** Pin a piece as "currently practicing" (home card + piece-scoped plan). */
  pinPiece: (piece: Omit<CurrentPiece, 'startedAt'> & { startedAt?: string }) => void;
  /** Update just the stated goals of the pinned piece. */
  setPieceGoals: (goals: string) => void;
  unpinPiece: () => void;
}

export const useUserStore = create<UserState>((set) => ({
  profile: null,

  setProfile: (profile) => set({ profile: profile ?? null }),

  updateProfile: (partial) =>
    set((state) => ({
      profile: state.profile ? { ...state.profile, ...partial } : null,
    })),

  pinPiece: (piece) =>
    set((state) => (state.profile
      ? { profile: { ...state.profile, currentPiece: { ...piece, startedAt: piece.startedAt ?? new Date().toISOString() } } }
      : {})),

  setPieceGoals: (goals) =>
    set((state) => (state.profile?.currentPiece
      ? { profile: { ...state.profile, currentPiece: { ...state.profile.currentPiece, goals } } }
      : {})),

  unpinPiece: () =>
    set((state) => {
      if (!state.profile) return {};
      const { currentPiece: _drop, ...rest } = state.profile;
      return { profile: rest };
    }),
}));
