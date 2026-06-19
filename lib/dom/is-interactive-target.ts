/**
 * Returns true when a mouse event originated inside a control that
 * already owns its click (button, form field, or anything explicitly
 * opted in with `data-row-interactive`).
 *
 * Used by table-row capture-phase handlers (Alt+Click multi-select,
 * left-click-to-clear, etc.) to bail out when the click belongs to
 * an inline kebab / label editor / form field — without this the
 * row-level handler runs first and swallows the click before the
 * control sees it.
 *
 * NOTE: `<a>` is intentionally excluded. Many tables wrap whole cells
 * in a Next `<Link>` for row-navigation, so treating every anchor as
 * interactive would defeat the "left-click anywhere clears selection"
 * gesture. The kebab and label editors below all render as <button>
 * (or use `data-row-interactive`) so the selector still catches them.
 */
export function isInteractiveTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false
  return Boolean(
    target.closest(
      'button, input, select, textarea, [role="button"], [data-row-interactive]',
    ),
  )
}
