import { supabase } from './supabase';
import { UserProfile, SkillLevel } from '../types/user';

export async function signIn(email: string, password: string) {
  const { data, error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) throw error;
  return data;
}

// Profile row is created automatically by the on_auth_user_created trigger.
// skill_level is updated separately after signup if a session is available.
export async function signUp(email: string, password: string) {
  const { data, error } = await supabase.auth.signUp({ email, password });
  if (error) throw error;
  return data;
}

export async function signOut() {
  const { error } = await supabase.auth.signOut();
  if (error) throw error;
}

export async function fetchProfile(userId: string): Promise<UserProfile> {
  const { data, error } = await supabase
    .from('profiles')
    .select('*')
    .eq('id', userId)
    .single();

  if (error) throw error;

  return {
    id: data.id,
    email: data.email,
    displayName: data.display_name,
    instrument: data.instrument,
    skillLevel: data.skill_level,
    freeAnalysesUsed: data.free_analyses_used,
    subscriptionTier: data.subscription_tier,
    createdAt: data.created_at,
  };
}

export async function updateProfileFields(
  userId: string,
  fields: { skill_level?: SkillLevel; display_name?: string; instrument?: string },
): Promise<void> {
  const { error } = await supabase.from('profiles').update(fields).eq('id', userId);
  if (error) throw error;
}

export async function incrementFreeAnalysesInDb(userId: string): Promise<void> {
  const { error } = await supabase.rpc('increment_free_analyses', { p_user_id: userId });
  if (error) throw error;
}
