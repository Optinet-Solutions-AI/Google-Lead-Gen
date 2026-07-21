'use client'

import { CheckpointCard } from './checkpoint-card'
import { useScrapeOnly } from './scrape-only-prefs'

type CardData = {
  row: React.ComponentProps<typeof CheckpointCard>['row']
  vncUrl: string | null
  screenshotUrl: string | null
  requester: React.ComponentProps<typeof CheckpointCard>['requester']
  isSearchEngine: boolean
}

/**
 * Client-side list renderer that honours the "Scrape-only" preference.
 * When ON, cards with `isSearchEngine=false` (lead-site enrichment
 * captchas — cookie banners on casino sites, etc.) are hidden and a
 * small note tells the operator how many are hidden.
 */
export function FilteredCheckpointList({
  cards,
  currentUserId,
}: {
  cards: CardData[]
  currentUserId: string
}) {
  const scrapeOnly = useScrapeOnly()
  const visible = scrapeOnly ? cards.filter(c => c.isSearchEngine) : cards
  const hiddenCount = cards.length - visible.length

  return (
    <div className="flex flex-col gap-3">
      {hiddenCount > 0 && (
        <p className="rounded-md border border-dashed border-[color:var(--color-border)] bg-[color:var(--color-bg-secondary)] px-3 py-1.5 text-[11px] text-[color:var(--color-text-secondary)]">
          Hiding <strong>{hiddenCount}</strong> lead-site captcha{hiddenCount === 1 ? '' : 's'} (cookie banners &amp; other enrichment walls). Click <strong>Show all</strong> above to see them.
        </p>
      )}
      {visible.length === 0 ? (
        <div className="rounded-md border border-dashed border-[color:var(--color-border)] bg-[color:var(--color-bg-primary)] px-4 py-10 text-center text-[12px] text-[color:var(--color-text-secondary)]">
          No scrape captchas waiting. Fleet is clear.
        </div>
      ) : (
        visible.map(card => (
          <CheckpointCard
            key={card.row.id}
            row={card.row}
            vncUrl={card.vncUrl}
            screenshotUrl={card.screenshotUrl}
            currentUserId={currentUserId}
            requester={card.requester}
            isSearchEngine={card.isSearchEngine}
          />
        ))
      )}
    </div>
  )
}
