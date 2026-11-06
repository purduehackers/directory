import type { APIRoute } from 'astro';
import { getDirectorySnapshot } from '../../lib/server/id-directory';
import { filterAndSearchMembers } from '../../lib/server/search';

export const GET: APIRoute = async ({ url, locals }) => {
  if (!locals.user) {
    return new Response(JSON.stringify({ error: 'unauthorized' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const query = url.searchParams.get('q') || '';
  const role = url.searchParams.get('role') || 'all';
  const gradYear = url.searchParams.get('gradYear') || 'all';
  const sort = url.searchParams.get('sort') || (query ? 'relevance' : 'name_asc');

  const limitParam = url.searchParams.get('limit');
  const offsetParam = url.searchParams.get('offset');
  const limit = Math.min(Math.max(1, parseInt(limitParam || '100', 10) || 100), 500);
  const offset = offsetParam ? Math.max(0, parseInt(offsetParam, 10) || 0) : 0;

  try {
    const snapshot = await getDirectorySnapshot();
    const results = filterAndSearchMembers(snapshot, {
      query,
      role,
      gradYear,
      sort,
    });

    const paginated = results.slice(offset, offset + limit);

    const sanitizedMembers = paginated.map((m) => ({
      sub: m.sub,
      preferred_username: m.preferred_username,
      name: m.name,
      given_name: m.given_name,
      family_name: m.family_name,
      picture: m.picture,
      roles: m.roles,
      graduation_year: m.graduation_year,
      email: m.email,
      emails: m.emails,
      phone_number: m.phone_number,
      discord_id: m.discord_id,
      discord: m.discord,
      profile: m.profile,
    }));

    return new Response(
      JSON.stringify({
        total: results.length,
        offset,
        limit,
        members: sanitizedMembers,
      }),
      {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }
    );
  } catch (err: any) {
    console.error('[API Search] Search failed:', err);
    return new Response(
      JSON.stringify({
        error: 'failed_search',
        message: 'Failed to process directory search query.',
      }),
      {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      }
    );
  }
};
