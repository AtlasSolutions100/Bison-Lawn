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

export function contractorColor(userId: number | null | undefined): string {
  if (userId == null) return "#6b7280"; // unassigned: grey
  return PALETTE[Math.abs(userId) % PALETTE.length];
}

/** Two-letter initials for a marker, "Adam Eich" -> "AE", "Mickie" -> "MI". */
export function initialsOf(name: string | null | undefined): string {
  const parts = (name ?? "").trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}
