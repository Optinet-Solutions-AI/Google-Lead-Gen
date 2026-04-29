# Lead Gen — Video Tutorial Script

A single ~15-minute screen-recorded walkthrough that covers everything an
operator needs to use the Rooster Partners Lead Gen dashboard end-to-end.

Total runtime target: **~15 minutes**. Recording in 1080p with the dashboard
sidebar expanded.

Format key:
- **Action** — what to do on screen
- **Narration** — what to say while it's on screen
- **Editor** — instructions for whoever cuts the video (callouts, cuts, B-roll)

---

## 0. Cold open (0:00 – 0:30)

**Action:**
Open the dashboard at `/`. Hover over the workers panel showing live activity.

**Narration:**
> "In the next fifteen minutes I'll walk you through Lead Gen — the dashboard
> we use to scrape Google search results across fifteen countries, enrich each
> result through a six-stage pipeline, and ship the keepers to Monday. By the
> end of this video you'll know how to run a scrape, watch it progress, fix
> anything the automation got wrong, and find your way around every page."

**Editor:**
Title card overlay: **"Lead Gen — full walkthrough"**. Background of the
dashboard with the workers ticking. Subtle zoom-in.

---

## 1. The dashboard (0:30 – 1:30)

**Action:**
Stay on `/`. Scroll slowly past each panel.

**Narration:**
> "This is the home page. At the top, four KPI cards — total leads, plus
> seven-day trends for leads, affiliates, and Rooster matches. Below that,
> Pipeline Health gives you a quick read on whether your scrape and enrichment
> queues are healthy or backed up.
>
> The Workers panel is the live one — it shows what each of the six VM workers
> is currently doing. Three for scraping, three for enrichment. Green spinner
> means busy, gray dot means vacant. Busy cards show the keyword, country, and
> elapsed time so you can see exactly what's running.
>
> Recent Batches and Recent Activity at the bottom give you context — what's
> been queued recently and who did what. The whole page auto-refreshes every
> five seconds while anything is in flight, so just leave it open and watch
> things move."

**Editor:**
Highlight each panel as it's mentioned with a soft outline animation.

---

## 2. Running your first scrape (1:30 – 4:30)

**Action:**
Click **Scrape** in the sidebar. Land on `/scrape`.

**Narration:**
> "Let's run a scrape. The form at the top of the Scrape page is the most-used
> screen in the app, so let's go through it field by field."

### 2a. Keywords (1:45 – 2:00)

**Action:**
Click into the Keywords textarea, paste three example keywords on separate lines:

```
best online casinos 2026
top 10 casino sites
neue online casinos
```

**Narration:**
> "Keywords go in the textarea — one per line. Each line becomes its own
> scrape job, so I can queue three keywords in one shot. The little counter
> on the right tells me I have three queued."

### 2b. Country + language (2:00 – 2:45)

**Action:**
Open the **Country** dropdown. Hover over Oman to show the option. Pick **Oman**.
Then open the **Search language** dropdown to show Arabic + English.
Pick **Arabic**.

**Narration:**
> "Country picks the residential proxy and the GoLogin browser profile. Each
> country has its own pre-configured profile. If a country shows a yellow
> 'needs login' badge — like New Zealand — Google won't reliably show PPC ads
> there until you've signed into a Google account in that profile.
>
> The Search language dropdown is filtered by what we picked. Oman gives us
> Arabic and English. By default everything is English — but for Oman, UAE,
> Saudi, and the like, switching to Arabic dramatically changes what we see.
> Local-language affiliates that don't show up in English become visible.
> Let's pick Arabic."

**Editor:**
Callout overlay: **"Language sets `&hl=` on the Google URL"**.

### 2c. Pages, priority, options (2:45 – 3:45)

**Action:**
Set **Pages** to 2. Set **Priority** to 5. Tick **Run full enrichment after
scrape**. Leave the schedule empty.

**Narration:**
> "Pages — between one and ten. Each page is roughly ten organic results plus
> any PPC ads. Two pages is a reasonable starting point.
>
> Priority — higher numbers get picked up first when workers are idle. Default
> is zero. I'll bump this one to five so it jumps the line.
>
> 'Run full enrichment after scrape' is the magic toggle. With this on, as
> soon as the scrape finishes, the orchestrator automatically fires all six
> enrichment stages — Monday duplicate check, affiliate detection, Rooster
> partner check, contact extraction, s-tag extraction, and s-tag verification.
> No manual clicking needed.
>
> Schedule for — leave blank to run now, or pick a future date and time. We're
> running this immediately, so I'll skip it."

### 2d. Submit + watch (3:45 – 4:30)

**Action:**
Click **Submit**. Watch the row appear in the Recent Jobs table with status
`pending`. Wait for it to flip to `running`. Cut to it being `enriching ·
affiliate`. Cut to `enriching · all stages`. Finally cut to `completed`.

**Narration:**
> "Hit submit. The row shows up immediately — pending. Within five seconds a
> worker claims it and the status flips to running.
>
> Once scraping finishes, the badge becomes 'enrichment queued' for a few
> seconds while the orchestrator picks it up — then 'enriching · affiliate'
> while the affiliate-detection stage runs across all the leads, then
> 'enriching · all stages' as Rooster, contact, and s-tag run in parallel.
> Only when every stage is done does it go green — completed."

**Editor:**
Speed up the dead time between status flips with a 4× clip. Show a small
clock or progress indicator on screen so viewers know time has passed.

---

## 3. Managing jobs — the kebab menu (4:30 – 7:30)

**Action:**
Click the three-dot kebab on the left side of any row. Modal opens.

**Narration:**
> "Every row has a three-dot menu on the left. Clicking it opens a management
> modal. What appears in the modal depends on the job's current state."

### 3a. Pause / Resume (4:45 – 5:15)

**Action:**
Find a `pending` job (or queue a new one). Open the kebab. Click **Pause**.
The status flips to `paused`. Open the kebab again, click **Resume**. Status
flips back to `pending`.

**Narration:**
> "If a job is pending, you can pause it. Workers will skip it until you
> resume — useful if you want to free up a worker for something more urgent,
> or if you queued something by mistake. Resume flips it right back into the
> queue."

### 3b. Pause / Resume / Force-complete enrichment (5:15 – 6:15)

**Action:**
Find a job whose enrichment is in flight. Open kebab. Show the Enrichment
section.

**Narration:**
> "If a job has finished scraping and enrichment is running, the modal also
> gives you Pause Enrichment and Resume Enrichment buttons. Pausing flips
> every pending enrichment row to paused. Rows already running by a worker
> finish naturally — but no new rows get claimed.
>
> The third button — Force complete enrichment — is the escape hatch. If a
> domain permanently fails, the chain can sometimes get stuck waiting on it.
> Force complete cancels any pending rows and marks the whole chain done so
> you can move on. You can always re-enqueue specific failed leads from the
> Leads page if you want to retry them later."

### 3c. Re-run with PPC / Organic filter (6:15 – 7:00)

**Action:**
Find a `completed` job. Open kebab. Show the Re-run section. Click
**Re-run — PPC only**.

**Narration:**
> "Once a job is in a terminal state — completed, failed, captcha, or
> cancelled — you also get re-run buttons. PPC only and Organic only.
>
> Why does this exist? Sometimes the organic results came back fine but the
> PPC capture was empty, or vice versa. Instead of paying for the whole scrape
> again, you queue a fresh job that only keeps one result type. Filtering
> happens at insert time inside the database, so even though the worker
> scrapes everything, only the requested type lands in the table."

### 3d. Cancel + Delete (typed confirmation) (7:00 – 7:30)

**Action:**
Open kebab on any non-running job. Scroll to Danger Zone. Type the keyword
into the confirmation field. Show the buttons enabling. Click **Cancel job**.

**Narration:**
> "At the bottom of the modal — the Danger Zone. Cancel and Delete are both
> here, and they both require typing the exact keyword to confirm. This
> protects against accidental clicks.
>
> Cancel keeps the row for audit but flips it to cancelled and stops any
> pending enrichment. Delete is irreversible — it wipes the queue row, every
> lead, all s-tags, all enrichment data, cached HTML, and screenshots. Use
> Cancel when you want a paper trail; use Delete when you really want it gone."

**Editor:**
Big red overlay text on Delete: **"IRREVERSIBLE"**.

---

## 4. The enrichment pipeline (7:30 – 9:30)

**Action:**
Click on a job's keyword to navigate to `/scrape/[id]`. Scroll to the
Enrichment Pipeline section. Expand it.

**Narration:**
> "Let's talk about what enrichment actually does. Click into a job and scroll
> to the Enrichment Pipeline section. This expands to show all six stages.
>
> One — Monday duplicate check. Pure database query against our Monday mirror.
> Marks each lead with whether it's already on one of your boards.
>
> Two — Affiliate detection. The worker fetches the homepage in a real
> browser, scores it for affiliate signals: outbound tracking links, casino
> keywords, sponsored language. Sets the is-affiliate flag and a confidence
> score.
>
> Three — Rooster partner check. Searches the page content and outgoing links
> for any of your twenty-eight Rooster partner domains.
>
> Four — Contact extraction. Visits the homepage plus contact, about, and
> impressum pages. Runs a cascade: regex first, then GPT-4o with web search,
> then Hunter.io as a fallback. Pulls emails and phone numbers.
>
> Five — S-tag extraction. Only runs on leads flagged as affiliates. Follows
> tracking links, takes a screenshot of each landing page, pulls out the
> tracking parameters — btag, stag, cxd, and so on.
>
> Six — S-tag verification. Cross-references each extracted tag against the
> Monday mirror to flag duplicates.
>
> Each stage has a play button. Hitting it manually re-enqueues that stage
> for every lead in the job. The badges next to each stage show a live count
> of running and pending rows so you don't double-trigger."

**Editor:**
Number-overlay each stage as it's mentioned (1️⃣ … 6️⃣).

---

## 5. Working with leads (9:30 – 12:30)

### 5a. The leads table (9:30 – 10:15)

**Action:**
Click **Leads** in the sidebar. Land on `/leads`.

**Narration:**
> "The Leads page is the one-table view of every scraped lead across every
> job. Sortable headers, filters at the top — country, result type, search.
>
> Notice that PPC results group above Organic by default. Within each group,
> whichever column you click sorts the rows. Makes it easy to spot the paid
> placements first."

### 5b. Lead detail drawer (10:15 – 10:45)

**Action:**
Click on a domain. The drawer slides in from the right. Show the contents:
basic info, screenshot, enrichment data, s-tags.

**Narration:**
> "Click on any domain to open the detail drawer. Everything we've enriched
> for this lead is here — screenshot of the landing page, contacts we found,
> extracted s-tags with their tracking URLs, redirect chains, and the Rooster
> brand it matched if any. You can delete the screenshot from here too."

### 5c. Manual overrides (10:45 – 11:15)

**Action:**
On any lead row, click the Yes/No editor on the "Is an affiliate?" column.
Set it to No. Show the visual change.

**Narration:**
> "Every boolean column in the table is editable. If the automation got
> something wrong — said a site is an affiliate when it isn't — click the
> Yes-No-Clear pill and set the right value. This stamps an override timestamp
> so future enrichment runs leave it alone. Use Clear to remove the override
> and let the next auto-run reconsider."

### 5d. Bulk select + retry (11:15 – 12:00)

**Action:**
Click **Select rows** in the toolbar. Tick a few rows. Sticky bar appears.
Click **Affiliate** retry. Show the success message.

**Narration:**
> "Now the bulk-select feature. Click Select rows in the toolbar — a checkbox
> column appears. Tick a few leads. The sticky bar at the bottom lights up.
>
> The retry buttons re-enqueue the selected leads for any single enrichment
> stage. This is great for retrying a handful of failed domains without
> re-running the whole job. For example, if affiliate detection failed on
> twenty leads because of one network blip, select them all, hit Retry
> Affiliate, done."

### 5e. Bulk delete (12:00 – 12:30)

**Action:**
With rows still selected, click **Delete selected**. Show the typed-confirm
panel. Type `delete 5` (or whatever the count is). Click delete.

**Narration:**
> "And to delete — same sticky bar. Click Delete Selected, type 'delete' plus
> the count to confirm — that prevents accidental clicks — and the leads are
> gone. Their s-tags, screenshots, and enrichment data go with them."

---

## 6. Admin & operations (12:30 – 14:00)

### 6a. Country profiles (12:30 – 13:00)

**Action:**
Click **Country Profiles** in the sidebar. Show toggles for login state and
languages.

**Narration:**
> "Country Profiles. Fifteen GoLogin profiles, one per country. The toggle
> here — Is logged in — needs flipping after you sign into a Google account in
> that profile. Until you do, the scrape form shows a yellow warning when you
> pick that country."

### 6b. Rooster brands (13:00 – 13:30)

**Action:**
Click **Rooster Brands** in the sidebar. Show the editable list.

**Narration:**
> "Rooster Brands — your editable partner list. Twenty-eight domains seeded.
> The Rooster check stage searches every lead's page content and outgoing
> links for any active brand here. Add, edit, or deactivate as your partner
> mix evolves. Edits take effect immediately on the next enrichment run."

### 6c. Schedules (13:30 – 14:00)

**Action:**
Click **Schedules** in the sidebar. Show one example set.

**Narration:**
> "Schedules — for recurring scrapes. Define a set with a cron expression and
> a list of keyword-country combos. The system fires the scrapes
> automatically on the cron tick. Daily, weekly, whatever. Tick 'Run
> enrichment' on the set if you want every spawned job to auto-run the full
> chain."

---

## 7. Audit + onboarding (14:00 – 14:45)

### 7a. Activity log (14:00 – 14:20)

**Action:**
Click **Activity Log** in the sidebar. Show the filter chips and search.

**Narration:**
> "Activity Log captures every UI mutation — every scrape enqueue, every
> override, every deletion. Filter by action family, search by user, entity,
> or ID. This survives even when you delete a scrape job, so you keep the
> audit trail."

### 7b. Onboarding + Help pages (14:20 – 14:45)

**Action:**
Click **Onboarding** in the sidebar. Then click **Help & Docs**.

**Narration:**
> "Two pages I want you to bookmark. Onboarding is a guided tour of the same
> features I just covered, with checkboxes you can tick off as you learn.
> Help and Docs is the full technical reference — every API endpoint, every
> RPC, every cron job, environment variables, deployment instructions, and
> troubleshooting. When something breaks at one in the morning, that's the
> page you want."

---

## 8. Outro (14:45 – 15:00)

**Action:**
Cut back to the dashboard.

**Narration:**
> "That's the tour. Run a scrape, watch it complete, review the leads, fix
> anything the automation got wrong, and ship the keepers. If you forget any
> of this, the Onboarding and Help pages are always one click away in the
> sidebar. Happy hunting."

**Editor:**
End card with the Rooster logo and contact info / wiki link if applicable.
Fade to black.

---

## Production notes

- Record at 1920×1080 with the dashboard at default zoom (no browser-zoom in
  or out — keep the layout the team will actually see).
- Use a real keyword that produces real results so the demo doesn't look
  staged. "best online casinos 2026" with country = Oman is a solid choice
  because the Arabic vs English contrast is dramatic.
- Cut around any moment a real worker takes more than ~5 seconds — viewers
  zone out fast on a static screen. Speed-up clips to 4× with a clock overlay
  work well for those gaps.
- All passwords / tokens off-screen. Double-check screenshots for stray
  service-role keys before publishing.
- Captions: tools like Descript, Otter, or YouTube auto-captions handle this
  well; review for technical terms (GoLogin, Supabase, RPCs) the auto-tools
  will mangle.
- Total budget: roughly **15 minutes** delivered. Add an extra 10–15% buffer
  in raw recording for retakes.

---

## Updates since first draft

The script above was written before the following features shipped. Re-read
these and slot them into the relevant section before recording — most slot
into existing sections without changing the timing budget.

### Advanced filters + multi-sort (slot into §5 Working with leads)

The Leads page now has a monday.com-style Filter button, Sort button, and
active-chip row. Replace the SearchBar paragraph with:

> "Beside the search box, the Filter and Sort buttons are where the heavy
> lifting happens. Filter opens a popover with multi-row conditions —
> column dropdown, type-aware operator, value picker. Text columns get
> contains / starts-with / is-empty; numbers get equals / between / greater
> than; dates get before / after / between; selects and booleans get value
> pickers. Stack as many as you want; they combine with AND. Sort works
> the same way but for sort priority — first key is primary, subsequent
> are tiebreakers. Active filters and sorts show as chips above the table,
> each with an X to remove individually."

The same widget lives on `/scrape` (filter the jobs queue) and
`/scrape/[id]` (filter that job's leads), so cover it once and refer back
to it from each place.

### Bulk-action bar moved to the top (§5d/5e)

The bar that shows "1 selected · Retry stage / Affiliate / Rooster /
Contact / S-tags / Delete selected" now sits above the table (still
sticky on scroll), not below. Update the demo: tick a row → the bar
appears at the top → click Retry Rooster.

### Re-run with PPC / Organic filter (slot into §3c)

After "Re-run buttons" sentence, add:

> "These queue a fresh scrape that filters at insert time inside the
> database. So even though the worker scrapes everything, only the
> requested type lands. Useful when one result type came back malformed
> and you don't want to pay for a full re-scrape."

### Rooster cheap → deep (§4, stage 3 description)

Replace the original "stage 3 — Rooster partner check" paragraph with:

> "Three — Rooster partner check. First-pass is cheap: scan the cached
> HTML for outgoing href attributes pointing at brand domains, image alt
> attributes matching brand names like 'Spinjo', and image filenames like
> logo-spinjo.svg. If all three miss, the system auto-queues a
> rooster-deep follow-up — opens the page in Chromium, follows tracking
> redirects, and checks the resolved hostnames. This catches affiliate
> sites that hide brand links behind /go/ redirects without paying
> browser cost on first-pass hits."

### Force-complete enrichment (§3b)

After the Pause/Resume Enrichment paragraph, add:

> "There's also a Force complete button right there. If the chain stalls
> on a permanently-failed domain — say, a site that times out forever —
> Force complete cancels any pending queue rows and marks enrichment
> done so you can move on. The leads page bulk-select still lets you
> retry specific failed leads later if you want."

### Manual Google-login stickiness (§6a)

After "until you do, the scrape form shows a yellow warning…" add:

> "And the manual TRUE is sticky. Earlier the auto-detector would
> sometimes false-positive a logged-in session as logged-out and wipe
> your manual confirmation on the very next scrape. That's protected
> now — auto can confirm a sign-in, but it can't drop a manual TRUE."
