/**
 * role → reach, mirroring the `reach:` frontmatter in core/roles/ (RFC-0041).
 *
 * `reach` is how far down a role documents its own subtree, used by the
 * Comprehensible level:
 *   Infinity ("full") — the whole subtree is the role's own anatomy (self-
 *                       contained widgets: inputs, menus, button, controls…).
 *   2                 — a two-level internal grammar (group→item, row→cell).
 *   1                 — one chrome level; the payload carries its own roles.
 *
 * core/roles/ is the authority; this table is the kit's copy of its reach data.
 * Keep them in sync when a role is added or its reach changes.
 */
const FULL = Infinity

export const ROLE_REACH: Record<string, number> = {
  accordion: 1,
  'action-sheet': FULL,
  alert: FULL,
  avatar: FULL,
  badge: FULL,
  banner: FULL,
  breadcrumb: FULL,
  button: FULL,
  card: 1,
  carousel: 2,
  checkbox: FULL,
  chip: FULL,
  'color-picker': FULL,
  combobox: FULL,
  'command-palette': 1,
  'context-menu': FULL,
  'date-picker': FULL,
  dialog: 1,
  divider: FULL,
  drawer: 1,
  'dropdown-menu': FULL,
  'empty-state': 1,
  'file-uploader': FULL,
  'floating-action-button': FULL,
  'full-screen-overlay': 1,
  gallery: 2,
  hyperlink: FULL,
  'item-indicator': FULL,
  'launch-screen': FULL,
  'loading-indicator': FULL,
  'navigation-menu': 2,
  pagination: FULL,
  popover: FULL,
  'progress-indicator': FULL,
  'radio-button': FULL,
  'search-bar': FULL,
  'segmented-control': FULL,
  select: FULL,
  sidebar: 2,
  skeleton: FULL,
  slider: FULL,
  stepper: FULL,
  switch: FULL,
  'tab-bar': FULL,
  table: 2,
  'text-area': FULL,
  'text-field': FULL,
  'time-picker': FULL,
  toast: FULL,
  toolbar: 1,
  tooltip: FULL,
  'top-navigation-bar': 1,
  tree: 2,
}

/**
 * Reach for a role value. An unknown role (not in the catalog) documents only
 * itself — reach 0 — so it still counts as an anchor but covers nothing below.
 */
export function reachOf(role: string): number {
  return role in ROLE_REACH ? ROLE_REACH[role] : 0
}
