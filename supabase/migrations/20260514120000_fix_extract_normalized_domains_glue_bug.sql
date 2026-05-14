-- ============================================================
-- Migration: Fix extract_normalized_domains() glue bug
--
-- Bug
-- ---
-- When a Monday updates body lists several domains concatenated
-- without spaces (a PBN-format dump like
-- "highland-cattle.atcasinomithandyrechnung.atbeste-legale-casinos.at"),
-- the old extractor's regex greedily captured the entire chain as
-- one "domain". `registered_domain()` then derived a garbage eTLD+1
-- ("atbeste-legale-casinos.at") and stored that in body_domains.
-- Subsequent searches for the real domain (beste-legale-casinos.at)
-- missed because the array contained the glued-prefix junk instead.
--
-- This produced confirmed false negatives that QA flagged — e.g.
-- casinomithandyrechnung.at, beste-legale-casinos.at,
-- seriosecasinos.at, osterreich-casino-spieler.com.
--
-- Fix (additive)
-- --------------
-- For each greedy regex match, run a second pass that splits the
-- captured string at `.<tld>` boundaries when the TLD is followed by
-- a letter (the glue indicator). Emit BOTH the original greedy match
-- and each split segment as candidates.
--
-- Additive design — no regression risk:
--   * Plain domains (no glue) emit exactly what the old function did.
--   * Glue chains additionally emit the split parts so they're
--     discoverable.
--   * "X.atomicboost.com" (real label happens to contain `.com`)
--     still emits "atomicboost.com" correctly via pass 1; pass 2
--     adds junk like "X.at" and "omicboost.com" which is harmless
--     unless a real lead has those exact domains (very rare).
--
-- TLD list is intentionally narrow (.at, .ch, .de, .eu, .com, .net,
-- .org, .info, .biz) — the TLDs most likely to appear glued in this
-- project's PBN data. Broader lists risk junk for marginal gain.
--
-- Generated columns (body_domains) re-evaluate when their source
-- column is updated, so the trailing UPDATE statements force a
-- regeneration across all four updates tables. The GIN indexes
-- update automatically as part of the row update.
-- ============================================================

create or replace function public.extract_normalized_domains(p_text text)
returns text[]
language plpgsql
immutable
parallel safe
as $$
declare
  v_result  text[] := '{}'::text[];
  v_match   text;
  v_norm    text;
  v_reg     text;
  v_clean   text;
  v_segment text;
begin
  if p_text is null or p_text = '' then return '{}'::text[]; end if;

  for v_match in
    select (regexp_matches(
      p_text,
      '((?:https?://)?(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,})',
      'gi'
    ))[1]
  loop
    -- Pass 1: original greedy match (backwards-compatible behavior).
    v_norm := public.normalize_domain(v_match);
    if v_norm is not null and v_norm <> '' then
      v_result := array_append(v_result, v_norm);
      v_reg := public.registered_domain(v_norm);
      if v_reg is not null and v_reg <> '' and v_reg <> v_norm then
        v_result := array_append(v_result, v_reg);
      end if;
    end if;

    -- Pass 2: split glued chains. Insert a `|` marker after every
    -- `.<tld>` that is immediately followed by a letter, then split
    -- on `|` and re-normalize each segment. If no markers were
    -- inserted the segment loop is a no-op.
    v_clean := regexp_replace(
      v_match,
      '\.(at|ch|de|eu|com|net|org|info|biz)([a-z])',
      '.\1|\2',
      'gi'
    );
    if v_clean <> v_match then
      foreach v_segment in array string_to_array(v_clean, '|')
      loop
        v_norm := public.normalize_domain(v_segment);
        if v_norm is null or v_norm = '' then continue; end if;
        v_result := array_append(v_result, v_norm);
        v_reg := public.registered_domain(v_norm);
        if v_reg is not null and v_reg <> '' and v_reg <> v_norm then
          v_result := array_append(v_result, v_reg);
        end if;
      end loop;
    end if;
  end loop;

  select array_agg(distinct d order by d) into v_result from unnest(v_result) d;
  return coalesce(v_result, '{}'::text[]);
end;
$$;

grant execute on function public.extract_normalized_domains(text)
  to service_role, anon, authenticated;

-- Regenerate body_domains across all 4 updates tables. Postgres
-- re-evaluates `stored` generated columns when the source column
-- is written, even when the value is unchanged.
update public.leads_updates_table set body_text = body_text;
update public.affiliates_updates_table set body_text = body_text;
update public.not_relevant_leads_updates_table set body_text = body_text;
update public.email_undelivered_leads_updates_table set body_text = body_text;
