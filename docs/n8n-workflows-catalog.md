# n8n Workflows Catalog — Legacy Google Lead-Gen Pipeline

> Source: `c:\Users\Chris-Optinet\Google-Lead-Gen\GoogleLeadGen\` (20 exported n8n workflows)
> Purpose: Reference for Epic 7 rebuild in Next.js + Supabase + Python-VM.

---

## 1. Executive summary

The old pipeline was an n8n-orchestrated casino-affiliate lead generator. A UI (`lead-gen-ui-v3.vercel.app`) fired a webhook that ran a GoLogin+Python scraper on a remote VM via SSH, dumped Google SERP results into `google_lead_gen_table` in Supabase, then fanned out through ~8 secondary workflows (one per stage) that enriched each row: rooster-partner check (Serper.dev `site:` search), affiliate classification (Scraping Bee HTML + scoring heuristic), S-tag capture (Scraping Bee → regex → `s-tag-captor.vercel.app`), Monday.com duplicate lookup (Postgres RPCs against a Monday replica), contact extraction (OpenAI GPT-4o web-search + Hunter.io fallback), PPC screenshot (CaptureKit + Google Drive), and finally lead insertion into a Monday.com board via GraphQL. Each workflow reports status back to `/api/webhook/status` on the UI. All stages also have ProxyLite/Enigma country-specific residential proxies available.

The user has already rebuilt the entry webhook and the scrape-insert step in the new Next.js app. **Epic 7 needs to port the middle-stage logic** (affiliate check, rooster-partner check, Monday duplicate check, contact extraction, S-tag capture) into server-side routes or Python-VM scripts, with LLM calls migrated from GPT-4o to Claude.

---

## 2. Per-workflow catalog

### 2.1 Lead Generator | Launch GoLogin (Trigger) — `google-lead-gen`
*(Already ported — summarized for completeness)*
- **Trigger**: POST webhook `/google-lead-gen`. Body: `{ keyword, countryValue, countryText, pages }`.
- **Purpose**: Entry point — SSH into VM, run `gologin_start_profile_api_and_webscrape.py` with params, route on stdout `[RESULT] SUCCESS|FAILED|CAPTCHA`.
- **Key nodes**: Webhook → Tidy data → SSH command (private key cred) → Switch on stdout → No-op / Close GoLogin (`python3 ~/kill_gologin.py`) / error webhooks back to UI.
- **External**: SSH (private key), POST back to `lead-gen-ui-v3.vercel.app/api/webhook/status`.
- **Calls**: Triggers `Lead Generator | Add data to SupaBase (Subflow)` via webhook `b166aa52-b779-407c-896b-8e1434aa2a93` (called from the Python script on the VM, not directly by this flow).

### 2.2 Lead Generator | Add data to SupaBase (Subflow) — webhook `b166aa52-…`
*(Already ported)*
- **Trigger**: POST webhook. Body from Python scraper: `{ params:{keyword,country}, total_results, organic_results, ppc_results, pages_scraped, timestamp, results:[{url,full_url,title,resultType,page,position,overall_position,keyword,country}, …] }`.
- **Purpose**: Flatten scraper results, compute next `batch_id` (SELECT max+1), insert one row per SERP hit into `google_lead_gen_table`.
- **Key nodes**: Webhook → Tidy (`items[0].json.body.results`) → SELECT last `batch_id` from Supabase via REST → Merge → If url exists → Code injects `new_batch_id = batch_id + 1` → Loop → Set fields → Supabase Create Row → 300ms wait.
- **Columns written**: `keyword, country, url, domain, position_on_page, page_number, overall_position, result_type, batch_id, time_stamp`.

### 2.3 Lead Generator | Check Affiliate — webhook `check-affiliate-websites`
- **Trigger**: POST webhook. Body: `[{ id, url, domain, country }, …]`.
- **Purpose**: Pure-JS heuristic classifier — flags each row as `AFFILIATE` or `NOT_AFFILIATE` based on HTML content scraped via Scraping Bee.
- **Key nodes**:
  1. Tidy (adds `domain_for_searching` = stripped domain)
  2. Loop
  3. JS skip list (youtube/twitch/facebook/twitter/instagram/vimeo/youtu.be → set `is_affiliate=false`, skip)
  4. POST to `/webhook/get-html-tags-scrapingBee` (2.13)
  5. **Casino Affiliate Detector Code** (JS) — scores the HTML:
     - +15 if ≥5 outbound casino links (tracking patterns `/track/|/click/|/go/|/visit/|/out/|/redirect/|/creat/|/aff/|/ref/|/link/|/offer/|/bonus/|/promo/`, or `?ref=|?aff=|?campaign=|?source=|?tracking=|?click=` query params, or external domains containing `casino|bet|gaming|slots|poker|blackjack|spin`)
     - +8 affiliate-disclosure phrases ("we may earn", "affiliate commission", "advertising disclosure")
     - +7 review language ("best online casino", "top 10/25/20", "compare casino", "recommended casino")
     - +6 CTA mentions ("visit casino", "play at", "get bonus", "claim bonus")
     - +5 bonus-comparison words, +5 pros/cons, +3 star-rating regex (`\d+(\.\d+)?\s*(\/|out of)\s*\d+|★{2,}`), +4 `<table>`+casino, +5 `rel="nofollow|noopener"`
     - Casino signals (negative for affiliate): +12 login + password field, +10 deposit/withdraw, +8 account/balance, +7 responsible gambling, +6 gaming license — only counted when `externalCasinoCount === 0`
     - Final classification by score-difference cases with confidence LOW/MEDIUM/HIGH/VERY_HIGH
  6. If classification `AFFILIATE` → UPDATE `google_lead_gen_table` `is_affiliate=true`, else `is_affiliate=false`
- **External**: Scraping Bee (via sibling workflow).
- **Supabase**: UPDATE `google_lead_gen_table SET is_affiliate = ? WHERE id = ?`.

### 2.4 Lead Generator | Check If Rooster Partner — webhook `check-if-domains-are-rooster-partners`
- **Trigger**: POST webhook. Body: `[{ id, url, domain, country }, …]`.
- **Purpose**: For each lead, Google-dorks (`site:domain "partnerdomain"`) against a whitelist of rooster-brand domains (stored in n8n global var `$vars.ROOSTER_PARTNER_DOMAINS`, comma-separated). If any partner domain appears on the affiliate site, flag as rooster partner.
- **Key nodes**:
  1. Tidy → Loop
  2. Build Serper.dev queries: `site:${affiliateUrl} "${partnerDomain}"` for each partner (Serper API key literal: `651c304547f848273de8a3874767c2677e8457fa`)
  3. POST `https://google.serper.dev/search` with `q` and `num=5`
  4. Parse organic results, set `isPartner=true` if any org result exists
  5. Filter partners, if ≥1 → UPDATE `google_lead_gen_table is_rooster_partner=true, brand=<csv of partners>` and INSERT into `rooster_partner_url_temp_holder_table (id, url_json)` — `url_json` contains the SERP results for later S-tag extraction; else UPDATE `is_rooster_partner=false`.
- **External**: Serper.dev (`google.serper.dev/search`).
- **Partner whitelist observed** (from pinData sample queries): `rocketspin.com, rooster.bet, playmojo.com, spinjo.com, lucky7even.com, luckyvibe.com, rollero.com, fortuneplay.com, spinsup.com, novadreams.com, roosterpartner.media, roosterspartners.media, mediaroosters.com, lucky7even.org, lucky7even21.com, roosterbet.live, fortuneplay.co, spinjo.live, spinsup.live, rocketspin.live, playmojo.live, novadreams.live, luckyvibe.live, rollero.live, rooster-partner.com, roosters-partner.com, roosterpartners.media, roosterspartners.com, rooster-partners.com`.

### 2.5 Lead Generator | Get HTML Tags (Scraping Bee) — webhook `get-html-tags-scrapingBee`
- **Trigger**: POST webhook. Body: `{ id, url, country, domain, domain_for_searching, shouldSkip, skipReason }`.
- **Purpose**: Shared utility — fetch full rendered HTML of a URL through proxied Scraping Bee. 3-tier retry: ProxyLite → Enigma → ScrapingBee premium proxy with country code.
- **Key nodes**:
  1. Check Supabase `google_lead_gen_table.html_tags` for an already-cached copy (`select=html_tags&url=eq.<url>&limit=1`)
  2. If cached → return
  3. Otherwise POST to `/webhook/add-proxy-proxyLite` to get country proxy string
  4. Call `ScrapingBee` node with `ownProxy, renderJs=true`
  5. On error → POST to `/webhook/add-proxy-enigma` → second Scraping Bee attempt
  6. On second error → **3rd fallback** direct `https://app.scrapingbee.com/api/v1/` with `premium_proxy=true, country_code=<ISO2>` (API key literal: `28EOCIV4WPSKYXDS8GKC7Q5Y66RCFTDRWDN5PS7F6AUZQAWSHAJPTD9EH881YYFH0S8D1I1TP8523U4S`)
  7. Cache HTML back into `google_lead_gen_table.html_tags` (UPDATE by id)
  8. Respond `{ rendered_html_tags: "<html>…" }`
- **Helper code**: Intl.DisplayNames to map country name → ISO-2 country code.

### 2.6 Add Proxy Module (ProxyLite) — webhook `add-proxy-proxyLite`
- **Trigger**: POST. Body: `{ country, ... }`.
- **Purpose**: Switch on country name, return a country-specific ProxyLite URL.
- **Format**: `http://pl-nskojcm40ezt_area-<ISO2>:Z2OKKfRT3O1uxQbv@gate-us.proxylite.com:9595`
- **Countries**: AT, CA, DE, NZ, NO, AE, SA, QA, BH, KW, OM, AU, IT, DK.

### 2.7 Add Proxy Module (Enigma) — webhook `add-proxy-enigma`
- **Trigger**: POST. Body: `{ country, ... }`.
- **Purpose**: Same as ProxyLite but with Enigma provider.
- **Format**: `http://0048277fc210:58fc5cbc0ebf_country-<ISO2>@resi.enigmaproxy.net:12321`
- **Countries**: same set as ProxyLite.

### 2.8 Lead Generator | Scrape Affiliate Website For S-Tags — webhook `scrape-site-for-s-tags`
- **Trigger**: POST webhook. Body: `[{ id, url, domain, country, is_rooster_partner }, …]`.
- **Purpose**: Two-path workflow depending on `is_rooster_partner` flag.
  - **Path A (non-partner, direct affiliate site)**: fetch HTML via Scraping Bee → run **Casino Affiliate Link Extractor** JS node (regex-based) → pull all redirecting/tracking affiliate links (3 extraction paths: `<a href>`, any `data-*` attribute on any tag + `onclick` patterns, Next.js `__NEXT_DATA__` JSON walk) → hand off to Extract-S-Tags subworkflow.
  - **Path B (rooster partner)**: look up `rooster_partner_url_temp_holder_table.url_json` (the saved Serper results), loop those reddit/etc URLs, Scraping Bee them, run **Casino Affiliate Link Extractor For Partners** (same as Path A but filters to the `$vars.ROOSTER_PARTNER_DOMAINS` whitelist), accumulate results in `$getWorkflowStaticData('global').affiliateLinksHolder`, then call the Extract-S-Tags subworkflow.
- **Heuristics encoded in the extractor JS** (important — directly encodes affiliate detection):
  - `redirectPaths`: `/go/, /visit/, /out/, /track/, /click/, /redirect/, /aff/, /refer/, /forward/, /creat/, /play/`
  - `trackingParams`: `ref, aff, affid, affiliate, tracker, btag, aid, pid, sid, click_id, clickid, subid, sub1, sub2, subid3, subid4, subid5, token, irclickid, stag, cxd, mid, promo, promocode, referral, referrer, listid, listtype, listlocation, listversion, list_position, ct, ctalocation, operator_item_id, cta_id, seen_item_id, pageview_id, funnel, creative_id, ad_campaign_id`
  - `excludedDomains`: `facebook.com, twitter.com, x.com, instagram.com, linkedin.com, youtube.com, tiktok.com, responsiblegambling.org, connexontario.ca, camh.ca, gpwa.org, mga.org.mt, gdcgroup.com, certify.gpwa.org, agco.ca, kahnawake.com`
  - `ctaKeywords`: `play now, visit casino, visit site, visit now, claim bonus, get bonus, claim offer, play here, join now, register now, get deal, claim free spins, start playing, play for free, get started, collect bonus, grab bonus, try now, play at, play`
  - `ctaClassPatterns` regex: `\b(btn|button|cta|play|visit|claim|join|register|signup|sign-up)\b`
  - Extracts `__NEXT_DATA__` JSON and walks for keys: `claimurl, affiliateurl, offerurl, trackingurl, clickurl, bonusurl, dealurl`.
- **Outputs** (per link): `{ href, anchorText, brand, partnerDomain?, category, cssClasses, source:'html'|'data_attr'|'next_data' }`.
- **Calls**: `Lead Generator | Extract S-Tags` (executeWorkflow).

### 2.9 Lead Generator | Scrape Affiliate Website For S-Tags (In Prep for JavasScript Abstraction)
- Same purpose as 2.8; a WIP fork meant to move the extraction JS into a standalone JS module. Logic equivalent to 2.8 — treat as duplicate.

### 2.10 Lead Generator | Extract S-Tags — subworkflow trigger
- **Trigger**: `executeWorkflowTrigger` (called from 2.8). Input: `{ linksToExtract: JSON stringified [{href,anchorText,brand,category,cssClasses,source}, …], source_id, country }`.
- **Purpose**: For each affiliate link, follow the redirect chain (via external `https://s-tag-captor.vercel.app/trace`) to the final casino URL, then regex out the S-tag from query params.
- **Key nodes**:
  1. Parse input, keep first 10 links max
  2. Loop
  3. POST `/webhook/add-proxy-proxyLite` → GET `https://s-tag-captor.vercel.app/trace?url=<href>&proxy=<proxy>` (5 retries), on error → Enigma proxy → retry
  4. **S-tag parser JS** (load-bearing):
     - Splits `final_url` query string manually
     - Looks at keys `['btag', 'stag', 'cxd', 'mid', 'affid']` in that order
     - Takes the value, splits on `_`, uses the first part as the s_tag
     - `site_name` = first dot-segment of the hostname (e.g. `joinvegasnow.com` → `joinvegasnow`)
  5. Accumulate in `staticData.sTagsHolder`, dedupe by `s_tag`, POST `{ items: [...] }` to `/webhook/add-stags-to-database` (2.11)
  6. DELETE from `rooster_partner_url_temp_holder_table WHERE id = source_id`
  7. If no s_tags → UPDATE `google_lead_gen_table.has_s_tags = false`.
- **External**: `https://s-tag-captor.vercel.app/trace` (custom Vercel service — user owns this).

### 2.11 Lead Generator | Insert S-Tags To Supabase — webhook `add-stags-to-database`
- **Trigger**: POST webhook. Body: `{ items: [{s_tag, site_name, source_id}, …] }`.
- **Purpose**: Assign new autoinc `s_tag_id` (existing or +1 of max), INSERT rows into `s_tags_table`, UPDATE `google_lead_gen_table.s_tag_id` and `has_s_tags=true`.
- **Key nodes**:
  1. Check `google_lead_gen_table.s_tag_id` for `source_id` — if exists, reuse it; otherwise `SELECT max(s_tag_id) + 1 FROM s_tags_table`
  2. Merge, inject new_s_tag_id
  3. If `s_tag` and `site_name` both exist → UPDATE lead + Loop → INSERT into `s_tags_table (s_tag_id, s_tag, brand=site_name)` + 300ms wait.

### 2.12 Lead Generator | Check Domain Duplicates from Monday.com replica — webhook `check-domain-duplicates-on-monday-replica`
- **Trigger**: POST webhook. Body: `[{ id, url, domain }, …]`.
- **Purpose**: For each new lead, call a Supabase RPC that searches across a replica of Monday.com boards (affiliates, leads, email-undelivered, not-relevant) to detect if the domain already exists.
- **Key nodes**:
  1. Tidy (adds `domain_for_searching`)
  2. Loop
  3. GET `https://ogzxpnwoxakynexyfvad.supabase.co/rest/v1/rpc/search_website_across_all_boards_and_updates?search_url=<domain>` (`executeOnce: true`)
  4. If result.id exists → UPDATE `google_lead_gen_table SET is_on_monday=true, affiliate_name=<result.affiliate_name>`; else `is_on_monday=false`.
- **Supabase RPC invoked**: `search_website_across_all_boards_and_updates(search_url)`.

### 2.13 Lead Generator | Check S-tags from Monday.com replica — webhook `check-s-tags-on-monday-replica`
- **Trigger**: POST webhook. Body: `[{ id, s_tag_autoinc_id, s_tag, … }, …]`.
- **Purpose**: For each captured s_tag, call a Supabase RPC to find where (if anywhere) it lives on Monday.com boards; categorize the match.
- **Key nodes**:
  1. Loop over s_tags
  2. GET `https://ogzxpnwoxakynexyfvad.supabase.co/rest/v1/rpc/search_s_tag_across_all_boards_and_updates?search_keyword=<s_tag>`
  3. Switch on `source_table`:
     - `affiliates` → status `Found on Affiliate board on columns`, source_link `https://roosterpartners-company.monday.com/boards/1237788929/pulses/{item_id}`
     - `affiliates (via updates)` → status `Found on Affiliate board via Updates`, includes `/posts/{update_post_id}`
     - `leads (via updates)` → board `1236073873` (Leads)
     - `email_undelivered_leads (via updates)` → board `1237006289`
     - `not_relevant_leads (via updates)` → board `1237789472`
     - `s_tags_table` → status `Already Added on Monday.com` (Supabase dedupe)
     - fallback → `Not Found on Monday.com`
  4. UPDATE `s_tags_table` with status, source_link, board_id, item_id
  5. Also UPDATE `google_lead_gen_table SET is_on_monday=true, affiliate_name=<...>` when found.
- **Supabase RPC**: `search_s_tag_across_all_boards_and_updates(search_keyword)`.
- **Monday.com board IDs observed**:
  - `1237788929` — Affiliates
  - `1236073873` — Leads
  - `1237006289` — Email Undelivered Leads
  - `1237789472` — Not Relevant Leads

### 2.14 Lead Generator | Extract and Insert Email/Contact Info — webhook `collect-contact-details`
- **Trigger**: POST webhook. Body: `[{ id, url, domain, country, is_rooster_partner }, …]`.
- **Purpose**: Orchestrator for contact extraction — reserve a `contact_id`, then try OpenAI first, fall back to Hunter.io if OpenAI failed.
- **Key nodes**:
  1. Tidy + add `domain_for_searching`
  2. Loop
  3. Check if row already has `contact_id` (SELECT from `google_lead_gen_table`) — if yes reuse, else `SELECT max(contact_id)+1 FROM contact_table`
  4. Inject `new_contact_id`
  5. POST to `/webhook/extract-contact-details-openai` (2.15)
  6. If OpenAI returns `extraction_result: success` → done
  7. Else POST to `/webhook/extract-contact-details-hunterio` (2.16).

### 2.15 Lead Generator | Extract and Insert Email/Contact Info - OpenAI — webhook `extract-contact-details-openai`
- **Trigger**: POST webhook, `responseMode: responseNode`.
- **Purpose**: Use GPT-4o with built-in web search to find email addresses and contact page URL for a given domain.
- **Key nodes**:
  1. `@n8n/n8n-nodes-langchain.openAi` with `modelId: gpt-4o`, `builtInTools.webSearch.searchContextSize: high`
  2. Parse JSON out of the markdown code fence (`/```json\s*([\s\S]*?)\s*```/`)
  3. If `contactUsURL` non-empty → INSERT `contact_table (contact_id, contact_detail, contact_type='Website', source='OpenAI')`
  4. For each email → INSERT `contact_table (contact_id, contact_detail, contact_type='Email', source='OpenAI')`
  5. UPDATE `google_lead_gen_table SET contact_id=?, has_contact_details=true WHERE id=source_id`
  6. Respond with `extraction_result: success|failed`.
- **OpenAI prompt** (verbatim — see §4 "LLM prompts").

### 2.16 Lead Generator | Extract and Insert Email/Contact Info - Hunter.io — webhook `extract-contact-details-hunterio`
- **Trigger**: POST webhook, `responseMode: responseNode`.
- **Purpose**: Fallback contact enrichment via Hunter.io domain-search.
- **Key nodes**:
  1. n8n `Hunter` node with `domain`, `limit=10`
  2. Parse email/full_name (first+last)/linkedin/twitter/phone_number per returned person
  3. For each contact type, if non-empty → INSERT `contact_table (contact_id, contact_detail, contact_type, source='Hunter.io', full_name)` — `contact_type` ∈ {Email, LinkedIn, Twitter, Phone}
  4. UPDATE `google_lead_gen_table SET contact_id=?, has_contact_details=true WHERE id=source_id AND has_contact_details IS NULL`
  5. If nothing found → UPDATE `has_contact_details=false`
  6. Respond with `extraction_result: success|failed`.

### 2.17 Lead Generator | PPC Take Screenshot Workflow — webhook `process-ppc`
- **Trigger**: POST webhook. Body: `{ id, url, domain, result_type, country, is_rooster_partner }`.
- **Purpose**: For PPC results, take a full-page screenshot via CaptureKit (proxied), upload to a specific Google Drive folder, save the content+view links to Supabase.
- **Key nodes**:
  1. Search Drive for existing `FileID_<id>` → delete old copy
  2. Set Proxy (ProxyLite) → `GET https://api.capturekit.dev/v1/capture?url=<url>&format=png&full_page=true&proxy=<proxy>` with httpHeaderAuth (5 retries)
  3. On error → Enigma proxy → retry
  4. Upload response as `FileID_<id>` to folder `1x1Zt1J_wyy5rhZanxLS1KN9rZpQyrGG7` ("Google Lead Gen - PPC Screenshots") on MAIN Google Drive
  5. UPDATE `google_lead_gen_table SET screenshot_content_link=<webContentLink>, screenshot_view_link=<webViewLink> WHERE id=source_id`.

### 2.18 Lead Generator | Add Lead on Monday.com — webhook `add-lead-on-monday`
- **Trigger**: POST webhook. Body: `{ id, batch_id, keyword, country, url, domain, result_type, is_rooster_partner, affiliate_name, screenshot_content_link, s_tags:[{s_tag,brand,…}], contact:[{contact_detail,…}] }`.
- **Purpose**: Final step — push a fully-enriched lead into Monday.com's Leads board `1236073873` via GraphQL, attach the screenshot, append S-tags as a comment/update.
- **Key nodes**:
  1. Clean domain (strip `https?://(www\.)?`, trailing `/`)
  2. Country name → ISO2 code
  3. If `result_type = PPC` → `source = "PPC"` else `source = "SEO"`
  4. Sanitize all string fields (remove quotes/newlines/backslashes)
  5. GraphQL `create_item(board_id: 1236073873, item_name: <cleaned_domain>, column_values: {...})` — columns:
     - `text86` = affiliate_name
     - `text54` = keyword
     - `status.label` = "New Lead"
     - `email.email` + `email.text` = contact_detail
     - `status_12.label` = traffic_size (always null)
     - `status_1.label` = source (PPC/SEO)
     - `text0` = country_code
     - `date.date` = today (yyyy-MM-dd)
     - `text1` = url
     - `project_owner.personsAndTeams` = `[{id: 46169036, kind: person}]`
  6. If `screenshot_content_link` non-empty → fetch image from GDrive as binary → GraphQL `add_file_to_column(item_id, column_id:"files", file: $file)` via multipart
  7. JS builds a multi-line string of `${brand} ${s_tag}\n…` → GraphQL `create_update(item_id, body)` to post S-tags as an item update.
- **External**: Monday.com GraphQL (`https://api.monday.com/v2`), Google Drive.

### 2.19 Lead Generator | Add Updates for S-Tag on Monday.com — webhook `add-updates-for-stag`
- **Trigger**: POST webhook. Body: `{ s_tag_autoinc_id, s_tag_id, s_tag, brand, domain, board_id, item_id }`.
- **Purpose**: When an s_tag matches an existing Monday.com item, append a text update (`<domain> <brand> <s_tag>`) to that item and mark the s_tag row as "Update Added on Monday.com".
- **Key nodes**:
  1. Clean domain
  2. GraphQL `create_update(item_id: <item_id>, body: "<domain> <brand> <s_tag>")`
  3. UPDATE `s_tags_table SET status='Update Added on Monday.com', source_link='N/A' WHERE s_tag_autoinc_id=?`.

### 2.20 Lead Generator | Other Actions (Subflow) - OLD Can be deleted.json
- **Deprecated** — an earlier monolithic version that combined affiliate detection, Google Sheets upsert, Hunter.io lookup, and Monday.com upload in one ~423KB workflow. Contains the older "Casino Affiliate Detector" JS (same algorithm as 2.3), an OpenAI "ChatGPT affiliate check" that was superseded, and Google Sheets write (`Lead Gen Test` spreadsheet `1q3brc26tGSBMCTS9fqA3Pkl1vF0v59R5f0Vg0xtiyz8`) before the team moved to Supabase. **Do not port; everything useful is already in the modular workflows above.**

---

## 3. End-to-end pipeline flow

```
[UI → POST /google-lead-gen (2.1)]
    └─ SSH VM: gologin_start_profile_api_and_webscrape.py {kw,country,pages}
           └─ Python script calls back to /webhook/b166aa52-… (2.2)
                 └─ Inserts N rows into google_lead_gen_table (new batch_id)

[UI, per batch, fires these stage webhooks in sequence for the newly-inserted ids:]

  ① /check-affiliate-websites (2.3)
       ├─ skip youtube/social
       ├─ Scraping Bee via (2.5→2.6/2.7)
       ├─ Casino Affiliate Detector scoring
       └─ UPDATE is_affiliate

  ② /check-if-domains-are-rooster-partners (2.4)
       ├─ Serper.dev site: queries against partner domain whitelist
       ├─ UPDATE is_rooster_partner, brand
       └─ if partner → INSERT rooster_partner_url_temp_holder_table(id, url_json)

  ③ /scrape-site-for-s-tags (2.8)
       ├─ Path A (non-partner): Scraping Bee → regex affiliate-link extractor (direct)
       └─ Path B (partner): pull url_json → Scraping Bee reddit/etc pages → partner-whitelist extractor
             └─ executeWorkflow → Extract S-Tags (2.10)
                   ├─ s-tag-captor.vercel.app/trace per link
                   ├─ parse btag/stag/cxd/mid/affid query param
                   └─ POST /add-stags-to-database (2.11)
                         └─ INSERT s_tags_table, UPDATE google_lead_gen_table

  ④ /check-domain-duplicates-on-monday-replica (2.12)
       └─ RPC search_website_across_all_boards_and_updates → UPDATE is_on_monday, affiliate_name

  ⑤ /check-s-tags-on-monday-replica (2.13)
       └─ RPC search_s_tag_across_all_boards_and_updates per s_tag
             └─ UPDATE s_tags_table.status + source_link

  ⑥ /collect-contact-details (2.14)
       ├─ /extract-contact-details-openai (2.15) — GPT-4o + webSearch
       └─ if fail → /extract-contact-details-hunterio (2.16)
             └─ INSERT contact_table rows

  ⑦ /process-ppc (2.17) [only for result_type='PPC']
       ├─ CaptureKit screenshot (proxied)
       └─ upload to Drive, UPDATE screenshot_*_link

  ⑧ /add-lead-on-monday (2.18)
       ├─ GraphQL create_item on board 1236073873
       ├─ multipart add_file_to_column (screenshot)
       └─ create_update with s_tags list

  ⑨ /add-updates-for-stag (2.19) [for each s_tag that matched an existing Monday item]
       └─ GraphQL create_update on matched item
```

Every workflow reports back to `https://lead-gen-ui-v3.vercel.app/api/webhook/status` (or v2 variant) with `{ status: success|error, message, failed_node, timestamp }` so the UI can display live progress.

---

## 4. LLM prompts inventory

### 4.1 OpenAI GPT-4o prompt — contact extraction (workflow 2.15)
Used as `responses.values[0].content`. Built-in web search `searchContextSize: high`.

```
You are a web research specialist tasked with finding contact information for a given website.

TASK: Search the website at the provided URL to find all email addresses and the contact page URL.

INSTRUCTIONS:
1. Use web search to visit and explore the provided domain
2. Look for email addresses in common locations:
   - Contact page
   - Footer section
   - About page
   - Header/navigation
   - mailto: links
   - Plain text email patterns
3. Identify the PRIMARY contact page URL by checking:
   - Navigation menu links (header/footer)
   - Links with exact text: "Contact", "Contact Us", "Get in Touch", "Reach Us"
   - URL paths containing: /contact-us/, /contact/, /get-in-touch/, /reach-us/
   - PRIORITY ORDER: Prefer /contact-us/ over /contact/ if both exist
4. Extract ALL unique email addresses found

CRITICAL RULES FOR contactUsURL:
- Return the FULL, ABSOLUTE URL (including https://)
- Only return URLs that actually exist on the website
- If multiple contact pages exist, prioritize in this order:
  1. /contact-us/
  2. /contact/
  3. /get-in-touch/
  4. Other contact-related pages
- If NO contact page can be found, return an empty string ""

VALIDATION RULES:
- Only include valid email format (username@domain.extension)
- NEVER invent, guess, or hallucinate email addresses
- Only return emails you directly observed in your search results
- If you are not certain an email exists on this website, do NOT include it

BEFORE RETURNING OUTPUT, VERIFY:
- Did you directly observe each email address in your search results? If no, remove it
- Is the contactUsURL a real page you found on the website? If not, return ""

OUTPUT FORMAT: Return ONLY valid JSON, no additional text or explanation.
Required JSON structure:
[
  {
    "emailAddresses": [
      { "value": "email1@domain.com" },
      { "value": "email2@domain.com" }
    ],
    "contactUsURL": "https://example.com/contact-us"
  }
]

EDGE CASES:
- If no emails are found after searching: you MUST return an empty array []. Do NOT substitute guessed or placeholder emails.
- If no contact page is found: return "" for contactUsURL
- Always return the JSON array structure

EXAMPLES:
Emails and contact page found:
[{"emailAddresses": [{"value": "info@example.com"}], "contactUsURL": "https://example.com/contact-us"}]

Emails found but no contact page:
[{"emailAddresses": [{"value": "info@example.com"}], "contactUsURL": ""}]

Nothing found:
[{"emailAddresses": [], "contactUsURL": ""}]

Website to research: {{ $json.domain }}
```

*(No other LLM prompts exist in the pipeline — affiliate detection and s-tag extraction are pure regex/scoring JS.)*

---

## 5. External APIs used

| API | Workflow(s) | Purpose | Auth shape |
|---|---|---|---|
| **Scraping Bee** (`n8n-nodes-scrapingbee.ScrapingBee` + `app.scrapingbee.com/api/v1/`) | 2.5, 2.8, 2.9 | Rendered HTML fetch with custom proxy or premium_proxy | `ScrapingBeeApi` credential; also hard-coded API key in fallback node |
| **Serper.dev** (`google.serper.dev/search`) | 2.4 | Google `site:` queries for partner domain lookup | `httpMultipleHeadersAuth` → API key `651c304547f848273de8a3874767c2677e8457fa` |
| **OpenAI** (GPT-4o via LangChain node) | 2.15 | Web-search-augmented contact extraction | `openAiApi` credential |
| **Hunter.io** (`n8n-nodes-base.hunter`) | 2.16 | Domain-search → email/LinkedIn/Twitter/phone | `hunterApi` credential |
| **CaptureKit** (`api.capturekit.dev/v1/capture`) | 2.17 | Full-page screenshot with proxy support | `httpHeaderAuth` credential |
| **Monday.com GraphQL** (`api.monday.com/v2`) | 2.18, 2.19 | create_item, add_file_to_column, create_update | `httpMultipleHeadersAuth` |
| **Google Drive** (`googleDriveOAuth2Api`) | 2.17, 2.18 | Upload screenshots, fetch for Monday.com attachment | OAuth — "MAIN credentials" |
| **Google Sheets** (`googleSheets`) | 2.20 deprecated only | Older lead sink (`Lead Gen Test` sheet) | OAuth |
| **ProxyLite** | 2.6 (and downstream consumers) | Country-specific residential HTTP proxies | Inline credentials in URL |
| **Enigma Proxy** (`resi.enigmaproxy.net`) | 2.7 | Secondary residential proxy | Inline credentials in URL |
| **Supabase REST** (`ogzxpnwoxakynexyfvad.supabase.co/rest/v1`) | all workflows | Tables + RPCs | `httpMultipleHeadersAuth` "Supabase Credentials" + `supabaseApi` node credentials |
| **SSH to VM** | 2.1, 2.2 | `python3 ~/gologin_start_profile_api_and_webscrape.py`, `python3 ~/kill_gologin.py` | Private-key credential |
| **s-tag-captor.vercel.app/trace** | 2.10 | Custom Vercel service that follows redirect chain, returns `final_url` | (no auth visible) |
| **Lead Gen UI status webhook** (`lead-gen-ui-v3.vercel.app/api/webhook/status`) | every workflow | Status pings for live progress UI | none |

---

## 6. Supabase schema inferred

### 6.1 `google_lead_gen_table` (core)
Inferred columns (all observed as read/written):
- `id` (PK, autoinc)
- `keyword` (text)
- `country` (text)
- `url` (text)
- `domain` (text — full base URL, e.g. `https://foo.com`)
- `position_on_page` (int)
- `page_number` (int)
- `overall_position` (int)
- `result_type` (text — `"Organic"` or `"PPC"`)
- `batch_id` (int)
- `time_stamp` (timestamptz)
- `is_affiliate` (bool)
- `is_rooster_partner` (bool)
- `brand` (text — csv of partner domains that matched)
- `is_on_monday` (bool)
- `affiliate_name` (text)
- `html_tags` (text — cached Scraping Bee HTML)
- `has_s_tags` (bool)
- `s_tag_id` (int — FK into s_tags_table)
- `has_contact_details` (bool)
- `contact_id` (int — FK into contact_table)
- `screenshot_content_link` (text — Drive direct link)
- `screenshot_view_link` (text — Drive view link)

### 6.2 `s_tags_table`
- `s_tag_autoinc_id` (PK, autoinc)
- `s_tag_id` (int — groups multiple s_tags that came from the same lead)
- `s_tag` (text)
- `brand` / `site_name` (text)
- `status` (text — e.g. `"Found on Affiliate board on columns"`, `"Not Found on Monday.com"`, `"Update Added on Monday.com"`, `"Already Added on Monday.com"`)
- `source_link` (text — deep link to Monday.com pulse/post, or `"N/A"`)
- `board_id` (text)
- `item_id` (text)

### 6.3 `contact_table`
- `contact_autoinc_id` (PK)
- `contact_id` (int — groups all contacts for one lead)
- `full_name` (text, nullable)
- `contact_detail` (text — the actual email/URL/phone/etc)
- `contact_type` (text — `"Email"`, `"Website"`, `"LinkedIn"`, `"Twitter"`, `"Phone"`)
- `source` (text — `"OpenAI"`, `"Hunter.io"`)
- `is_chosen` (bool — observed in Monday.com push payload)

### 6.4 `rooster_partner_url_temp_holder_table`
- `id` (PK — same as `google_lead_gen_table.id`)
- `url_json` (jsonb — cached Serper.dev `organic` results for re-scraping at S-tag-extraction time)
- Deleted by `Extract S-Tags` (2.10) after processing.

### 6.5 Supabase RPC functions referenced
- `search_website_across_all_boards_and_updates(search_url TEXT)` — returns `{ id, affiliate_name, source_table, item_id, update_post_id? }` if the URL is found in any Monday.com replica table.
- `search_s_tag_across_all_boards_and_updates(search_keyword TEXT)` — same shape, but searching by s_tag value. `source_table` ∈ `{ affiliates, affiliates (via updates), leads (via updates), email_undelivered_leads (via updates), not_relevant_leads (via updates), s_tags_table }`.

These RPCs imply a Monday-replica schema in Supabase: replica tables for each Monday board plus a `*_updates` table (since "via updates" is a distinct source).

---

## 7. Recommendations for Epic 7 rebuild

1. **Port the affiliate-detection heuristic (2.3) as-is into a server-side TypeScript module first, then layer Claude on top as a tie-breaker.** The regex/scoring logic catches the bulk of cases for free; reserve Claude for `LOW`/`MEDIUM` confidence rows where the score difference is small. This keeps cost low and gives us a deterministic baseline to compare Claude's judgment against. Source the exact scoring from the `Casino Affiliate Detector Code` JS in `Lead Generator _ Check Affiliate.json`.

2. **Port the S-tag extractor (workflows 2.8 + 2.10) verbatim to a Python-VM script.** The redirect-chain capture (`s-tag-captor.vercel.app/trace`) and the query-param key list `[btag, stag, cxd, mid, affid]` encode domain knowledge about Rooster Partners' tracking scheme — this is business-critical and must not be re-derived. Keep the partner-domain whitelist as an env variable (matches the old `$vars.ROOSTER_PARTNER_DOMAINS` pattern). The three-path HTML extractor (anchor / data-attr / `__NEXT_DATA__`) also stays.

3. **Replace the GPT-4o contact extractor (2.15) with Claude + web_search tool.** The prompt in §4.1 is well-engineered (strict JSON, anti-hallucination, priority ordering) — lift it nearly verbatim into the Claude call, only swapping the model and output handling. Keep Hunter.io (2.16) as the fallback path for when Claude returns `[]`.

4. **Drop the Monday-replica RPC approach in favour of live Monday.com GraphQL queries.** Duplicate checks (2.12 + 2.13) rely on two Postgres RPCs (`search_website_across_all_boards_and_updates`, `search_s_tag_across_all_boards_and_updates`) that query a replica of Monday boards — that replica needs maintenance. For Epic 7, prefer `items_page_by_column_values` GraphQL directly against Monday.com (rate-limit permitting), or keep a lightweight Next.js API route that caches Monday board snapshots on a cron. The 4 board IDs (`1237788929, 1236073873, 1237006289, 1237789472`) are stable and can be hard-coded.

5. **Drop the ProxyLite/Enigma/CaptureKit/Scraping Bee fallback ladder in favour of a single proxied fetch provider** if the new app is running on the Python VM already (it can host a headless Chromium with a residential proxy once and be done). The old workflow's 3-tier fallback for HTML fetching (2.5) and 2-tier for screenshots (2.17) exists solely because each provider fails intermittently; consolidating onto one robust path simplifies ops, and the VM environment already has GoLogin + proxy infrastructure that can be reused. Retain CaptureKit only if the Python VM can't reliably produce full-page PNGs.
