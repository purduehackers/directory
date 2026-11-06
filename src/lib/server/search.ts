import MiniSearch from 'minisearch';
import {
  buildDirectorySnapshot,
  type DirectoryMember,
  type DirectorySnapshot,
  type IndexedMember,
} from './id-directory';

export type SortOption = 'relevance' | 'name_asc' | 'name_desc' | 'grad_desc' | 'grad_asc';

export type SearchOptions = {
  query?: string;
  role?: string;
  gradYear?: number | string;
  sort?: SortOption | string;
  searchIndex?: MiniSearch<IndexedMember>;
};

export function filterAndSearchMembers(
  membersOrSnapshot: DirectoryMember[] | DirectorySnapshot,
  options: SearchOptions = {}
): DirectoryMember[] {
  const isSnapshot = !Array.isArray(membersOrSnapshot);
  let list = isSnapshot ? membersOrSnapshot.members : membersOrSnapshot;
  const searchIndex = isSnapshot
    ? membersOrSnapshot.searchIndex
    : options.searchIndex ?? buildDirectorySnapshot(list).searchIndex;

  // 1. Role Filter
  if (options.role && options.role !== 'all') {
    const roleLower = options.role.toLowerCase();
    if (roleLower === 'member') {
      list = list.filter((m) => !m.roles || m.roles.length === 0);
    } else {
      list = list.filter((m) =>
        m.roles?.some((r) => r.toLowerCase() === roleLower)
      );
    }
  }

  // 2. Graduation Year Filter
  if (options.gradYear && options.gradYear !== 'all') {
    const year = Number(options.gradYear);
    if (!isNaN(year)) {
      list = list.filter((m) => m.graduation_year === year);
    }
  }

  // 3. Text Query Search (via pre-built MiniSearch index)
  const MAX_QUERY_LENGTH = 100;
  const MAX_QUERY_TOKENS = 8;
  const q = options.query
    ?.trim()
    .slice(0, MAX_QUERY_LENGTH)
    .split(/\s+/)
    .slice(0, MAX_QUERY_TOKENS)
    .join(' ');
  const scoreMap = new Map<string, number>();

  if (q && q.length > 0) {
    const results = searchIndex.search(q);
    for (const r of results) {
      scoreMap.set(r.sub, r.score);
    }
    list = list.filter((m) => scoreMap.has(m.sub));
  }

  // 4. Sorting
  // Preserve MiniSearch relevance order when a query is present unless an explicit
  // non-relevance sort was specifically requested.
  const explicitSort = options.sort;
  const effectiveSort: SortOption =
    q && q.length > 0 && (!explicitSort || explicitSort === 'relevance')
      ? 'relevance'
      : (explicitSort as SortOption) || 'name_asc';

  return [...list].sort((a, b) => {
    switch (effectiveSort) {
      case 'relevance': {
        const diff = (scoreMap.get(b.sub) || 0) - (scoreMap.get(a.sub) || 0);
        if (diff !== 0) return diff;
        return (a.name || a.preferred_username).localeCompare(b.name || b.preferred_username);
      }
      case 'name_desc':
        return (b.name || b.preferred_username).localeCompare(a.name || a.preferred_username);
      case 'grad_desc':
        return (b.graduation_year || 0) - (a.graduation_year || 0);
      case 'grad_asc':
        return (a.graduation_year || 9999) - (b.graduation_year || 9999);
      case 'name_asc':
      default:
        return (a.name || a.preferred_username).localeCompare(b.name || b.preferred_username);
    }
  });
}

export function getAvailableGradYears(members: DirectoryMember[]): number[] {
  const years = new Set<number>();
  for (const m of members) {
    if (m.graduation_year) {
      years.add(m.graduation_year);
    }
  }
  return [...years].sort((a, b) => b - a);
}
