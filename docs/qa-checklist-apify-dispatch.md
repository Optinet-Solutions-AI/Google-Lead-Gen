# QA checklist — scraping after the AWS shutdown

**For the QA testers.** You don't need to know anything about the change to run
this. Work top to bottom and write down the result of each numbered check.

## What changed, in one paragraph

Scraping used to run on two servers we rented from Amazon. That account was
suspended on 14 October, and **scraping has been completely broken since** —
every scrape queued since then just sat there doing nothing. The work has been
moved so it no longer needs those servers. This checklist is to confirm
scraping actually works again, and that nothing else broke on the way.

**The single most important thing you are testing: does a new scrape come back
with results?** Everything else is detail.

---

## Before you start

- Site: **https://google-lead-gen.vercel.app**
- Sign in with your own account.
- If you land on a **"Choose a password"** screen, that is expected for new
  accounts — set your own password and carry on.
- Have a keyword and country in mind that you would normally scrape.

> If the site asks you to sign in again part-way through, note it down — that
> is worth reporting but is not what this checklist is about.

---

## 1. A new scrape returns results  ← the main test

1. Click **Scrape** in the left sidebar.
2. Click the **+ Scrape** button (top right on desktop; on a phone it is the
   round button floating above the feedback icon).
3. Fill in the form:
   - **Country** — pick one you normally use
   - **Keywords** — type one keyword
   - **Pages** — leave the default
   - **Device** — leave the default
   - Leave everything else alone
4. Press **Submit**.
5. You should get a **ticket** confirming it was queued. Note the batch number.
6. Go back to **Scrape**. Your batch should appear in the list.
7. **Wait up to 5 minutes**, refreshing now and then.

**Pass:** the batch reaches **completed** and the Results column shows a number
greater than zero.

**Fail:** it is still *pending* after 5 minutes, or it goes to *failed*.
→ Report the batch number and the exact status.

> A scrape now takes a couple of minutes rather than seconds. That is normal —
> it waits for the search service to finish. Anything beyond 5 minutes is not.

---

## 2. Open the batch and check the results

Click your batch from the Scrape list.

8. **Results are listed** — you see rows of websites, not an empty table.
9. **The counts add up.** The header reads something like
   *"12 rows · 7 hidden · 2 same-site duplicates collapsed from 21 found"*.
   Every result is accounted for. **Fail** if it claims a number of results but
   the table below is empty.
10. **"What it is" column** — most rows have a short description of the site
    ("Norwegian casino review and comparison site"). A few blanks are fine;
    *every* row blank is a fail.
11. **"Already exists?" column** — every row says **On Monday**, **In system**
    or **New**. **Fail** if any row is blank.
12. **Analysis strip** at the top shows counts (on keyword / off keyword, new /
    in system, affiliate).

---

## 3. One batch per scrape — no stuck "PPC still running"

This is the part most likely to look wrong if something slipped.

13. Your scrape should have produced **one row** in the Scrape list, not two.
14. The batch must **not** say *"PPC still running"* or sit at a status that
    never finishes.

**Pass:** one row, finishes cleanly.
**Fail:** two rows for one keyword, or a batch stuck waiting for ads.

> Google ads were only ever collected by the old servers, and for our keywords
> Google returned none anyway for months. They are gone on purpose. Bing
> scrapes still include ads.

---

## 4. Editing labels still works

Use any batch with results.

15. Click the label in the **Already exists?** column on any row. A menu should
    open **fully visible** — not cut off by the edge of the table.
16. Do the same for **Is an affiliate?**, **Rooster brand?**, **S-tags** and
    **Has contacts?**.
17. Change one label and refresh the page. The change should still be there.
18. Scroll the table sideways — the column headers should stay visible at the
    top while you scroll.

**Fail:** any menu appears clipped, trapped inside the table, or in the wrong
place on the screen.

---

## 5. Marking something not relevant actually hides it

19. On a row, open the **Already exists?** menu and choose a **Not relevant**
    board. The menu warns *"also hides it"*.
20. Refresh. That row should now be **hidden** from the default view.
21. Click **Show not-relevant** at the top right — the row reappears, marked as
    hidden.

**Fail:** the row stays visible as normal after step 20.

---

## 6. Old batches still open

22. Go to **Scrape**, switch the date filter to **All dates** and the owner
    filter to **All**.
23. Open any batch from **before October**. It should open and show its
    results as before.
24. Some old batches will show as **cancelled** with a message about the VM
    fleet being retired. That is expected and correct — not a bug.

---

## 7. Only if you are an admin

25. Go to **Admin → Integrations**.
26. **Apify** and **OpenAI** should both show a key present.
27. Press **Test connection** on each. Both should pass.

---

## Reporting

For anything that fails, send:

- the **check number** from this list
- the **batch number** or the page URL
- what you expected and what happened
- a screenshot if it is a visual problem

Send it the usual way. The two things worth flagging immediately rather than
batching up are: **scrapes not completing at all** (check 1) and **a batch
claiming results it does not show** (check 9).
