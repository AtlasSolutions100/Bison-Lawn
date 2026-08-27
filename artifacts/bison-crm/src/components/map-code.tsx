import { ExternalLink } from 'lucide-react';

/**
 * Adam asked to "connect" the aquifer site to the customer record. It is a
 * public lookup form with no documented API, so there is nothing to connect to:
 * anything reading it would be screen-scraping a municipal page that can change
 * shape without notice, and a wrong water district means a backflow test filed
 * with the wrong purveyor. The district is typed and stored by us; this link
 * only opens the lookup so an address can be checked in a second tab.
 */
const WATER_PROVIDER_LOOKUP_URL = 'https://www.spokaneaquifer.org/contact/find-my-water-provider/';

export function WaterProviderLookupLink() {
  return (
    <a
      href={WATER_PROVIDER_LOOKUP_URL}
      target="_blank"
      rel="noopener noreferrer"
      className="inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline"
    >
      Look up provider <ExternalLink className="w-3 h-3" />
    </a>
  );
}

const MAP_CODE_CHIP_CLASSES = [
  'bg-blue-100 text-blue-800 border-blue-200',
  'bg-emerald-100 text-emerald-800 border-emerald-200',
  'bg-amber-100 text-amber-900 border-amber-200',
  'bg-violet-100 text-violet-800 border-violet-200',
  'bg-rose-100 text-rose-800 border-rose-200',
  'bg-teal-100 text-teal-800 border-teal-200',
  'bg-orange-100 text-orange-900 border-orange-200',
  'bg-indigo-100 text-indigo-800 border-indigo-200',
];

/**
 * His old system had a "Map Code Colors" setting he filled in by hand. Deriving
 * the colour from the code means there is nothing to configure and no way for a
 * new zone to show up uncoloured — and because it is a pure function of the
 * text, one zone keeps its colour across every screen and every reload.
 */
export function mapCodeChipClass(code: string) {
  let hash = 0;
  for (const char of code.trim().toUpperCase()) hash = (hash * 31 + char.charCodeAt(0)) % 1000003;
  return MAP_CODE_CHIP_CLASSES[hash % MAP_CODE_CHIP_CLASSES.length];
}

export function MapCodeBadge({ code }: { code: string }) {
  return (
    <span className={`px-2 py-0.5 text-xs font-bold rounded-md border ${mapCodeChipClass(code)}`}>
      {code.trim().toUpperCase()}
    </span>
  );
}
