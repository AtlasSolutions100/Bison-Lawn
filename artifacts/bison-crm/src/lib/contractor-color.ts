/**
 * One colour per contractor, the same everywhere: job pins on the dispatch
 * map, the crew marker for where that person is right now, the assigned
 * column on the board. His old system did this and he reads the map by it —
 * "I can see whose jobs are whose" — so the mapping is a pure function of the
 * user id and never depends on which page drew it first.
 */
const PALETTE = [
  "#2563eb", // blue
  "#dc2626", // red
  "#16a34a", // green
  "#9333ea", // purple
  "#ea580c", // orange
  "#0891b2", // cyan
  "#db2777", // pink
  "#ca8a04", // yellow
  "#4f46e5", // indigo
  "#65a30d", // lime
  "#0d9488", // teal
  "#b45309", // amber
];

/**
 * The colours the office actually picked, by user id.
 *
 * He designates a contractor's colour himself — "it will show up in a different
 * color that I've designated for that contractor, so I can see whose jobs are
 * whose" — but the ten places that draw a dot only ever have a job in hand, not
 * the team list. Rather than thread the whole team through each of them, the
 * page that already loads the team registers the choices and every dot picks
 * them up.
 */
const chosen = new Map<number, string>();

/**
 * Register the colours from a team list. Cheap and idempotent, so call it
 * during render — a page that loads users will have filled this in before its
 * rows draw, and a page that does not still gets the automatic colours.
 */
export function registerContractorColors(
  users: readonly { id: number; color?: string | null }[] | undefined,
): void {
  for (const user of users ?? []) {
    const picked = user.color?.trim();
    if (picked) chosen.set(user.id, picked);
    else chosen.delete(user.id);
  }
}

export function contractorColor(userId: number | null | undefined): string {
  if (userId == null) return "#6b7280"; // unassigned: grey
  return chosen.get(userId) ?? PALETTE[Math.abs(userId) % PALETTE.length];
}

/** The colours offered in the picker; his choice is not limited to these. */
export const COLOR_CHOICES = PALETTE;

/** Two-letter initials for a marker, "Adam Eich" -> "AE", "Mickie" -> "MI". */
export function initialsOf(name: string | null | undefined): string {
  const parts = (name ?? "").trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}
