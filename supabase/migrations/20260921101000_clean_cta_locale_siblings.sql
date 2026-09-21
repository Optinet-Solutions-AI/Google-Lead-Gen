-- Migration: a site's own locale siblings are not CTA links.
--
-- casinoble.ro counted casinoble.bg / .cz / .ee among its "CTA links" — those
-- are the language switcher, not outbound brand links. Compare the name part
-- of each host (no subdomain, no TLD) and drop matches. Anything a human has
-- already walked for an S-tag is left alone.

with labelled as (
  select
    l.id,
    split_part(regexp_replace(l.resolved_host, '^www\.', ''), '.', 1) as dest_label,
    split_part(regexp_replace(p.normalized_domain, '^www\.', ''), '.', 1) as self_label
  from public.website_cta_links l
  join public.website_profiles p on p.id = l.profile_id
  where l.stag_checked_at is null
    and l.resolved_host is not null
)
delete from public.website_cta_links
where id in (select id from labelled where dest_label = self_label and dest_label <> '');

update public.website_profiles p
set ai_cta_count = coalesce(c.n, 0)
from (
  select p2.id, count(l.id) as n
  from public.website_profiles p2
  left join public.website_cta_links l on l.profile_id = p2.id
  where p2.ai_crawl_at is not null
  group by p2.id
) c
where p.id = c.id and p.ai_cta_count is distinct from coalesce(c.n, 0);

update public.website_profiles
set manual_stag_status = null
where manual_stag_status = 'pending' and coalesce(ai_cta_count, 0) = 0;
