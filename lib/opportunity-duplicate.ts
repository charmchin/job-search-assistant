type Identity = { organization?: string; role?: string; sourceUrl?: string };
type ExistingOpportunity = Identity & { id: string };

export const DUPLICATE_OPPORTUNITY_MESSAGE =
  '该机会已在机会库中，请勿重复添加。';

const normalizeName = (value = '') =>
  value.normalize('NFKC').replace(/\s+/g, '').toLowerCase();
function normalizeParams(params: URLSearchParams) {
  for (const key of new Set(params.keys()))
    if (/^utm_/i.test(key) || /^(gclid|fbclid)$/i.test(key)) params.delete(key);
  params.sort();
}
function normalizeUrl(value = '') {
  if (!value.trim()) return '';
  try {
    const url = new URL(value.trim());
    // Plain section anchors do not identify a job. Hash routes and parameters do.
    if (!url.hash || /^#[\p{L}\p{N}_-]+$/u.test(url.hash)) url.hash = '';
    else if (url.hash.includes('?')) {
      const queryAt = url.hash.indexOf('?');
      const route = url.hash.slice(0, queryAt);
      const params = new URLSearchParams(url.hash.slice(queryAt + 1));
      normalizeParams(params);
      url.hash = route + (params.size ? `?${params}` : '');
    }
    // Keep job identifiers as strings, including IDs beyond Number precision.
    normalizeParams(url.searchParams);
    return url.href;
  } catch {
    return value.trim();
  }
}

export function findDuplicateOpportunity<T extends ExistingOpportunity>(
  rows: T[],
  candidate: Identity,
): T | undefined {
  const url = normalizeUrl(candidate.sourceUrl);
  const organization = normalizeName(candidate.organization);
  const role = normalizeName(candidate.role);
  return (
    (url
      ? rows.find((row) => normalizeUrl(row.sourceUrl) === url)
      : undefined) ??
    (organization && role
      ? rows.find(
          (row) =>
            normalizeName(row.organization) === organization &&
            normalizeName(row.role) === role,
        )
      : undefined)
  );
}

export function duplicateOpportunityDetails(row: ExistingOpportunity) {
  return {
    duplicateId: row.id,
    duplicateOrganization: row.organization || '',
    duplicateRole: row.role || '',
  };
}
