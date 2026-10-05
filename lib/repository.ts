import { db } from '@/lib/db';
import { readWorkspaceState } from './workspace-repository';

export async function getWorkspaceState(now = new Date()) {
  return readWorkspaceState(db, now);
}

export function makeId(prefix: string) {
  return `${prefix}_${crypto.randomUUID()}`;
}
