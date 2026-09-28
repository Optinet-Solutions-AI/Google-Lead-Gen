-- Apply the intent behind 3,161 operator overrides that never took effect.
--
-- Placing a lead on a Not-Relevant board means it is not relevant. The Monday
-- sync has always written both facts together — refresh_profiles_from_monday
-- sets is_not_relevant whenever the board is not_relevant_leads — but the
-- MANUAL override wrote only the board. So an operator picking "Not relevant"
-- from the label menu got a row that claimed to sit on Monday's Not-Relevant
-- board while staying visible in /leads and continuing to be enriched.
--
-- Reported by an operator who watched rows he had marked "not relevant" come
-- back reading "On Monday". The badge was telling the truth about what was
-- stored; what was stored did not match what he asked for.
--
-- setMondayLabel now writes both, the same way the sync does. This brings the
-- rows already overridden into line.
--
-- Scope: only rows an operator explicitly overrode onto a not-relevant board
-- and that are not already flagged. Attribution is set to the board rather
-- than to a person, so moving the row to another board lifts the flag again —
-- the action only clears a flag it set itself.

do $$
declare
  v_n integer;
begin
  update public.google_lead_gen_table
  set is_not_relevant       = true,
      not_relevant_marked_at = coalesce(not_relevant_marked_at, monday_overridden_at),
      not_relevant_marked_by = 'monday:not_relevant_leads'
  where monday_overridden_at is not null
    and is_on_monday
    and monday_board like 'not_relevant_leads%'
    and is_not_relevant = false;
  get diagnostics v_n = row_count;
  raise notice 'flagged % leads whose not-relevant override had no effect', v_n;
end $$;
