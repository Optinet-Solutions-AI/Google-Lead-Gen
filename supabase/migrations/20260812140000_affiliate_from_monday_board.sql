-- ============================================================
-- A lead on Monday's Affiliates board IS an affiliate.
--
-- Operators kept reporting leads that show "NOT an affiliate" even though
-- the lead is already on their Monday Affiliates board (or matched a known
-- partner s-tag). Root cause: `is_on_monday` / `monday_board` get set by the
-- Monday match RPCs (scrape-time + nightly rematch), but `is_affiliate` was
-- only coupled to that fact inside the *manual* affiliate-detection stage
-- (runAffiliateDetection). Any lead matched to Monday AFTER its scrape — e.g.
-- via the nightly rematch or Monday inheritance — never had that stage
-- re-run, so it stayed is_affiliate = null despite sitting on the Affiliates
-- board. Measured: ~35 such leads.
--
-- Fix, two parts:
--   1. A BEFORE-trigger that keeps the two in sync automatically: whenever a
--      row is matched to the 'affiliates' board (or a 's_tag_partner' match),
--      mark it is_affiliate = true with affiliate_source = 'monday' — UNLESS
--      an operator has manually overridden the affiliate flag. Fires from any
--      write path (scrape match, rematch, inheritance), so it can't drift again.
--   2. A one-time backfill for the rows that already drifted.
--
-- Mirrors the existing rule in app/(dashboard)/scrape/actions.ts
-- (runAffiliateDetection: monday_board === 'affiliates' -> is_affiliate=true,
-- confidence 'MONDAY_AFFILIATE_BOARD'); this just makes it automatic + global.
-- ============================================================

create or replace function public.sync_affiliate_from_monday_board()
returns trigger
language plpgsql
as $$
begin
  -- The WHEN clause on the trigger already guarantees we only get here for
  -- affiliates-board / s_tag_partner rows that aren't operator-overridden and
  -- aren't already flagged. Just stamp the affiliate verdict.
  new.is_affiliate := true;
  new.affiliate_source := 'monday';
  new.affiliate_confidence := coalesce(new.affiliate_confidence, 'MONDAY_AFFILIATE_BOARD');
  new.affiliate_checked_at := coalesce(new.affiliate_checked_at, now());
  return new;
end;
$$;

drop trigger if exists trg_affiliate_from_monday on public.google_lead_gen_table;
create trigger trg_affiliate_from_monday
before insert or update on public.google_lead_gen_table
for each row
when (
  (new.monday_board = 'affiliates' or new.monday_match_kind = 's_tag_partner')
  and new.is_affiliate_overridden_at is null
  and coalesce(new.is_affiliate, false) = false
)
execute function public.sync_affiliate_from_monday_board();

-- One-time backfill of the rows that already drifted (the trigger only fires
-- on future writes). Respects operator overrides.
update public.google_lead_gen_table
set is_affiliate = true,
    affiliate_source = 'monday',
    affiliate_confidence = coalesce(affiliate_confidence, 'MONDAY_AFFILIATE_BOARD'),
    affiliate_checked_at = coalesce(affiliate_checked_at, now())
where (monday_board = 'affiliates' or monday_match_kind = 's_tag_partner')
  and is_affiliate_overridden_at is null
  and coalesce(is_affiliate, false) = false;
