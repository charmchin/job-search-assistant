import { guardLocalRequest } from '@/lib/local-request';
import { runtimeHealth } from '@/lib/runtime-health';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export async function GET(request: Request) {
  const blocked = guardLocalRequest(request);
  if (blocked) return blocked;
  return Response.json(runtimeHealth, {
    headers: { 'Cache-Control': 'no-store' },
  });
}
