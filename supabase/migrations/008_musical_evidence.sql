-- 008 — Persist the musical picture of a session.
--
-- Phrase features were only ever held in memory: saveSession writes scores and
-- llm_feedback, and nothing else. So the moment a session was re-opened from
-- history — or asked about in chat — every phrase window, shape and peak was
-- gone, and the coach was back to discussing six aggregate numbers.
--
-- That is the root of the "generic advice" problem on the chat side
-- specifically: post-session coaching had the detail because it ran while the
-- data was still in memory; chat never did.
--
-- Stores the ranked, already-compact payload from lib/musicalEvidence.ts (a
-- selection of phrases, tempo movement, notable notes), not the raw signal —
-- the full phrase set and RMS series would be large and are not worth keeping.

alter table public.sessions
  add column if not exists musical_evidence jsonb;

comment on column public.sessions.musical_evidence is
  'Ranked musical picture from lib/musicalEvidence.ts: selected phrases with their shapes and peak times, tempo movement vs. the intended tempo, and notable notes. Read by the coach Edge Functions so chat can discuss a session it did not analyse.';
