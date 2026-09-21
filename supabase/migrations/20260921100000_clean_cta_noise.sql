-- Migration: drop non-CTA links captured by the first extraction pass.
--
-- Building the /affiliates page exposed that "CTA links" was inflated. The
-- original same-host cloak pattern included content words (bonus, offers,
-- play), so ordinary category pages like `/bonuses/free-spins/` counted as
-- outbound brand links, and payment / games-supplier links (Trustly,
-- Pragmatic Play) were never filtered out.
--
-- The code fix narrows the pattern and drops any link whose redirect chain
-- lands back on the site itself. This cleans what the old pass already wrote
-- so the counts on screen are honest, then recomputes ai_cta_count from what
-- survives. Nothing a human has already walked for an S-tag is removed.

-- 1. Internal links: resolved back to the affiliate's own host.
delete from public.website_cta_links l
using public.website_profiles p
where l.profile_id = p.id
  and l.stag_checked_at is null
  and l.resolved_host is not null
  and (
    l.resolved_host = p.normalized_domain
    or l.resolved_host = public.registered_domain(p.normalized_domain)
  );

-- 2. Payment, KYC and games-supplier hosts — trust signals, not brand CTAs.
delete from public.website_cta_links
where stag_checked_at is null
  and resolved_host ~* '(trustly|skrill|neteller|paysafe|paypal|visa\.|mastercard|maestro|revolut|klarna|zimpler|mifinity|jeton|ecopayz|astropay|interac|muchbetter|boku|sofort|giropay|bankid|stripe|adyen|worldpay|nuvei|coinbase|binance|pragmaticplay|playngo|netent|evolution|microgaming|yggdrasil|redtiger|nolimitcity|betsoft|quickspin|playtech|isoftbet|relaxgaming|thunderkick|bigtimegaming|hacksaw)';

-- 3. Regulators, responsible-gambling bodies and social — same reasoning.
delete from public.website_cta_links
where stag_checked_at is null
  and resolved_host ~* '(facebook|instagram|twitter|x\.com|linkedin|youtube|tiktok|pinterest|reddit|t\.me|telegram|trustpilot|wikipedia|gambleaware|gamcare|gamstop|gamblingtherapy|hjelpelinjen|spelpaus|responsiblegambling|gamblingcommission|mga\.org\.mt|curacao-egaming|spelinspektionen|kansspelautoriteit|spillemyndigheden|ecogra|itechlabs|\.gov(\.|$)|europa\.eu|casinomeister|askgamblers)';

-- 4. Brand names that are really sentences lifted from the anchor text.
update public.website_cta_links
set brand_name = null
where brand_name is not null
  and (length(brand_name) > 40 or array_length(regexp_split_to_array(btrim(brand_name), '\s+'), 1) > 4);

-- 5. Recompute the count the UI shows from what actually survived.
update public.website_profiles p
set ai_cta_count = coalesce(c.n, 0)
from (
  select p2.id, count(l.id) as n
  from public.website_profiles p2
  left join public.website_cta_links l on l.profile_id = p2.id
  where p2.ai_crawl_at is not null
  group by p2.id
) c
where p.id = c.id
  and p.ai_cta_count is distinct from coalesce(c.n, 0);

-- 6. A site with no CTA links left has nothing for the browser pass to walk.
update public.website_profiles
set manual_stag_status = null
where manual_stag_status = 'pending'
  and coalesce(ai_cta_count, 0) = 0;
