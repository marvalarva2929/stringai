-- L10: cache LLM coaching + pattern findings on the session row so re-viewing
-- a session never re-calls the model.
alter table sessions add column if not exists llm_feedback jsonb;
alter table sessions add column if not exists pattern_findings jsonb;
