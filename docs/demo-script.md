# Rooster Partners — 15-Minute Demo Script

A walkthrough of the lead-gen tool in plain language. Total runtime ~15 min.
Each section starts with a "Say this" line, followed by what to click and a
quick reason for the feature.

---

## Section 1 — What this tool is for (1 min)

**Say this:**

> "This is the tool we use to find new affiliate websites we should partner
> with — anywhere in the world. Today the team finds them by typing a
> keyword into Google, scrolling through pages, copying the URLs, then
> checking each one against our Monday board to see if we already know
> them. That whole process takes hours. This tool does it in a couple of
> minutes — search, dedupe, and figure out who to contact, all in one go."

**Show:** open the app at the **Dashboard** page. Point out the sidebar:
Scrape, Leads, Monday Data, Country Profiles, Rooster Brands, Activity
Log. Mention the "Users (Admin)" link if you're signed in as admin.

---

## Section 2 — Sign-in & who's who (1 min)

**Say this:**

> "Each person on the team has their own login — username and password,
> no email needed. Every action you take is recorded with your name, so
> we always know who queued a scrape, who marked something as not
> relevant, and who pushed a lead to Monday. This matters because the
> tool talks to the same Monday boards your colleagues are using
> day-to-day."

**Show:** point at the "Signed in as …" line at the bottom of the sidebar.

---

## Section 3 — Queue your first scrape (3 min)

**Say this:**

> "Let's pretend we want to find German casino sites for the keyword
> 'best online casino 2026'. Instead of manually opening Google in a
> German browser, we just fill out this form."

**Show:** click **Scrape** in the sidebar. Walk through each field:

1. **Keyword** — what you'd type into Google.
2. **Country** — pick **Germany**. Explain: "Each country has a fake
   browser profile that looks like a real person sitting in that country
   — same language, same IP address, same browser fingerprint. Google
   only shows you German results if it believes you're in Germany."
3. **Language** — only the languages that make sense for the country
   are shown. Pick **German**.
4. **Pages** — how many pages of Google to scrape (1-10). Each page is
   ~10 results. Explain: "More pages = more leads, but slower."
5. **Run enrichment after scrape** — leave this **on**. Explain: "If you
   tick this, after the scrape finishes the tool automatically goes to
   each website and figures out: are they on our Monday board already,
   are they an affiliate site or a brand, do they have contact details,
   what tracking links do they use, etc. If you untick it, you only get
   the bare URL list."

Click **Add to queue**. Show the new row appear in the table below.

**Optional:** mention the kebab menu (three dots): pause, retry, delete.

---

## Section 4 — Watching a scrape run (3 min)

**Say this:**

> "Once a scrape is queued, a worker picks it up. Here's what each
> column on this table means."

**Show:** point at the columns in `/scrape`:

- **Status** — pending → running → completed. If a captcha shows up,
  the tool auto-retries up to 10 times with a fresh IP each time. If
  it still hits a wall, you'll see "captcha" and can click retry. If
  enrichment is running after the scrape is done, you'll see
  "enriching · affiliate" or "enriching · all stages".
- **Started / Duration** — when it kicked off, how long it took.
  **Hover over the duration** to see the breakdown: "Scrape took 42s,
  Monday check 2s, Affiliate detection 1m 30s, Rooster check 5s,
  Contacts 45s, S-tags 30s, S-tag check 3s, Total 3m 37s." Explain:
  "This is how the team can spot bottlenecks at a glance."
- **Results** — total URLs found, with a breakdown of PPC ads vs.
  organic results.
- **Pipeline** — six small dots showing each enrichment step. Green
  with a tick = done. Hollow = not run yet.
- **Engine** — Google or Bing. (Today only Google works reliably.)

Click into a job to open `/scrape/[id]`. Show the per-row table — same
view as `/leads` but filtered to this one job.

---

## Section 5 — Browse the leads (3 min)

**Say this:**

> "Now let's look at the leads themselves. This is where most of the
> work happens after a scrape."

**Show:** click **Leads** in the sidebar.

Walk through each column:

- **Keyword** — what we searched for. Below it: "by Hannah" — who
  queued the scrape that produced this row.
- **Country / Type / Pos** — country, PPC ad or organic result, position
  on Google.
- **Domain** — clickable. Opens the **detail drawer** on the right.
- **URL** — the full link.
- **Is on Monday?** — green tick if we already have this domain on one
  of our four Monday boards: Affiliates, Leads, Not Relevant, Email
  Undelivered. (Explain: "We check the website cell on every board AND
  every comment posted on those items, so if someone wrote 'they also
  use brandx-mirror.com' as a comment, we still catch it.")
- **Is an affiliate?** — yes / no, based on counting outbound tracking
  links and casino-related signals. We even use AI as a tie-breaker
  when it's borderline.
- **Rooster brand?** — yes / no, based on whether the domain is one of
  our own brands.
- **Has contacts?** — yes / no, did we find an email or contact form.
- **S-tags / Verified s-tags** — every tracking parameter (e.g. `?s=AB12`)
  found on the affiliate's outbound links. We click each one to see
  where it goes, then check whether that final landing page is one of
  our brands. This tells us *which* casinos they currently promote.

**Click a row's domain** to open the drawer. Walk through:

- **Mark as not relevant** — explain: "If you scroll through and see
  a result that's clearly junk — a forum, a news site, your own
  competitor's marketing page — click this. The lead disappears from
  the default view, the system stops trying to enrich it, and the next
  time we see this domain anywhere, it's auto-filtered. Reversible if
  you change your mind."
- **Push to Monday** — explain: "If a lead is genuinely interesting,
  click this to create a new item on the *Leads* Monday board with the
  domain, contact email, screenshot attached, and the s-tags posted as
  an update. From there it enters your normal sales workflow."
- **Context block** — keyword, country, batch number, who queued it,
  link back to the scrape job.
- **Monday duplicate check** — if matched, shows the board it was
  found on. Badge says how it matched: nothing = exact match,
  "subdomain match" = matched on the registered domain (so
  `de.trustpilot.com` matched `trustpilot.com`), "in updates" =
  found in a board comment.
- **Screenshot** — for PPC ads, we capture a screenshot of the landing
  page so you can see the creative.
- **Affiliate detection** — score, casino-related score, outbound link
  count, and a list of indicators (e.g. "casino vocabulary detected",
  "10+ outbound links to gambling sites").
- **Rooster brand check** — which of our brands appear on the page.
- **Contacts** — emails, phones, contact-page URL.
- **S-tags** — tracking parameters with their final landing pages,
  redirect chains, and screenshots.

Close the drawer. Show the **filters** at the top — search, country
dropdown, type dropdown, plus advanced filter and multi-sort if you
need precise queries. Mention: "If a lead got auto-flagged 'not
relevant' (because it matched our Not Relevant Monday board), there's
a 'Show not-relevant (N)' toggle at the top that brings them back into
view temporarily."

---

## Section 6 — Monday Data + manual sync (1 min)

**Say this:**

> "Whenever we say 'check Monday', we don't actually call Monday's API
> live — that would be slow. Instead we keep a copy of the four boards
> here in the tool, refreshed automatically every night at midnight CET.
> If you've just added or deleted a Monday item and want the change
> reflected immediately, click 'Sync now'."

**Show:** click **Monday Data** → switch between the 4 boards (Leads,
Affiliates, Not Relevant, Email Undelivered) and the items vs.
updates tabs. Click **Sync now**.

---

## Section 7 — Bulk actions (1 min)

**Say this:**

> "If you want to act on a batch of leads at once, click 'Select rows'
> at the top of the table to turn on checkboxes, tick a few, and a
> bulk action bar appears."

**Show:** click "Select rows", tick 2-3 leads, point at the bar:
re-enrich a stage, delete (with typed confirmation so you can't
fat-finger it).

---

## Section 8 — Country Profiles & Rooster Brands (1 min)

**Say this:**

> "These two pages are mostly admin reference. **Country Profiles**
> shows every country we can scrape from — green dot means the GoLogin
> browser is logged into Google, which is required for some countries
> like France and Germany. **Rooster Brands** is the list of our own
> brand domains the system uses to detect 'is this an affiliate
> promoting one of *us*'."

**Show:** click each, show the lists, scroll briefly, move on.

---

## Section 9 — Activity Log (1 min)

**Say this:**

> "Every action — queueing a scrape, marking a lead as not relevant,
> pushing to Monday, even adjusting a flag — is recorded here with
> who, when, and what changed. Useful for audit and for tracing 'wait,
> why did this lead disappear?'"

**Show:** click **Activity Log**. Filter by action type if there's
time.

---

## Section 10 — Admin: add a user (1 min)

*(Skip if your audience isn't an admin.)*

**Say this:**

> "If you're an admin, you can add new team members from here. Pick a
> username, optionally a display name, and a password — there's an
> autogenerate button if you can't think of one. The new user can sign
> in immediately and every action they take going forward is recorded
> with their name."

**Show:** click **Users (Admin)**. Click the regenerate buttons,
explain you don't have to actually create a user.

---

## Section 11 — Wrap up (1 min)

**Say this:**

> "So in summary — type a keyword, pick a country, click queue. A few
> minutes later you've got a list of websites with everything we need
> to know about each one, deduplicated against Monday, with screenshots
> and contact info. Junk gets filtered. Good leads get pushed to
> Monday with one click. The team focuses on the conversation, not the
> grunt work."

**Optional close:** "Any questions?"

---

## Quick cheatsheet — total time

| Section | Topic | Time |
|---|---|---|
| 1 | What it's for | 1 min |
| 2 | Sign-in | 1 min |
| 3 | Queue a scrape | 3 min |
| 4 | Watch it run | 3 min |
| 5 | Browse leads + drawer | 3 min |
| 6 | Monday data | 1 min |
| 7 | Bulk actions | 1 min |
| 8 | Profiles + Brands | 1 min |
| 9 | Activity Log | 1 min |
| 10 | Admin add user | 1 min |
| 11 | Wrap up | 1 min |
| **Total** | | **~15 min** |

If you're tight on time, drop sections 7-9 and you're at ~12 min.

---

## Speaker tips

- Pre-queue one scrape **30 minutes before the demo** so you have a
  fully-completed job to walk through in section 4 (don't make the
  audience wait for it to finish live).
- Open the app on a wide monitor — the leads table has many columns.
- Have a "good lead" picked out in advance for the section-5 drawer
  walkthrough so it shows interesting affiliate signals + s-tags.
- If anyone asks "what about Bing?" — say "Bing is on the roadmap;
  their bot detection is currently blocking us, so we're working
  around it."
