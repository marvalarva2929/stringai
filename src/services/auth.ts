import * as WebBrowser from 'expo-web-browser';
import * as Linking from 'expo-linking';
import { supabase } from './supabase';
import { UserProfile, SkillLevel } from '../types/user';

// Closes the in-app browser tab once the OAuth redirect fires. No-op on
// native (only matters for the web target), but required by the flow.
WebBrowser.maybeCompleteAuthSession();

export async function signIn(email: string, password: string) {
  const { data, error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) throw error;
  return data;
}

export type OAuthProvider = 'google' | 'apple';

/**
 * Google/Apple sign-in via Supabase's hosted OAuth (PKCE flow): opens the
 * provider's consent page in an ASWebAuthenticationSession, then exchanges
 * the returned authorization code for a session. Requires the provider to be
 * enabled in the Supabase dashboard (Authentication → Providers) — this only
 * drives the client side of that config.
 */
export async function signInWithProvider(provider: OAuthProvider) {
  const redirectTo = Linking.createURL('auth-callback');
  const { data, error } = await supabase.auth.signInWithOAuth({
    provider,
    options: { redirectTo, skipBrowserRedirect: true },
  });
  if (error) throw error;
  if (!data.url) throw new Error('No OAuth URL returned.');

  const result = await WebBrowser.openAuthSessionAsync(data.url, redirectTo);
  if (result.type !== 'success' || !result.url) {
    return null; // user cancelled — not an error
  }

  const { queryParams } = Linking.parse(result.url);
  const code = queryParams?.code;
  if (typeof code !== 'string') throw new Error('No authorization code returned.');

  const { data: sessionData, error: exchangeError } = await supabase.auth.exchangeCodeForSession(code);
  if (exchangeError) throw exchangeError;
  return sessionData;
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

/**
 * Permanently deletes the signed-in user's account and all associated data via
 * the delete-account Edge Function (service role — the anon client cannot delete
 * an auth user). Required by App Store Guideline 5.1.1(v).
 *
 * The caller is responsible for clearing local session/onboarding state and
 * routing to the auth screen afterward. Throws on any backend failure so the UI
 * can surface it instead of silently leaving the account intact.
 */
export async function deleteAccount(): Promise<void> {
  const { error } = await supabase.functions.invoke('delete-account', { body: {} });
  if (error) throw error;
  // Local session is now backed by a deleted user; clear it. Best-effort — the
  // account is already gone server-side regardless of whether this resolves.
  await supabase.auth.signOut().catch(() => {});
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
    weeklyGoalMinutes: data.weekly_goal_minutes ?? undefined,
    createdAt: data.created_at,
  };
}

export async function updateProfileFields(
  userId: string,
  fields: {
    skill_level?: SkillLevel;
    display_name?: string;
    instrument?: string;
    weekly_goal_minutes?: number;
  },
): Promise<void> {
  const { error } = await supabase.from('profiles').update(fields).eq('id', userId);
  if (error) throw error;
}

export async function resetPassword(email: string): Promise<void> {
  const { error } = await supabase.auth.resetPasswordForEmail(email, {
    redirectTo: 'stringai://reset',
  });
  if (error) throw error;
}

// increment_free_analyses was removed in migration 004: it took the user id as
// a parameter under `security definer`, so any authenticated caller could burn
// another user's quota, and it returned void so it could never reject. Analysis
// quota now goes through useEntitlementStore.tryConsumeAnalysis → the
// argument-less consume_analysis RPC, which reads auth.uid() and returns
// whether the analysis is allowed.
