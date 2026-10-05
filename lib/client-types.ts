export type Task = {
  id: string;
  opportunityId: string | null;
  title: string;
  dueAt: string | null;
  estimatedMinutes: number;
  status: string;
  source: string;
  isNextAction?: boolean;
  createdAt?: string;
  opportunity?: Opportunity | null;
};
export type Milestone = {
  id: string;
  opportunityId: string;
  title: string;
  scheduledAt: string | null;
  result: string;
  status: string;
  reminderOffsets: number[];
};
export type Requirement = {
  id: string;
  deleteVersion?: string;
  opportunityId: string;
  materialId: string | null;
  name: string;
  completed: boolean;
  notes: string;
};
export type Activity = {
  id: string;
  opportunityId: string;
  type: string;
  content: string;
  createdAt: string;
};
export type StageHistory = {
  id: string;
  opportunityId: string;
  fromStage: string | null;
  toStage: string;
  occurredAt: string | null;
  recordedAt: string;
  source: 'initial' | 'transition' | 'legacy' | 'manual';
  valid: boolean;
  notes: string;
};
export type Material = {
  id: string;
  deleteVersion?: string;
  name: string;
  filePath: string;
  version: string;
  category: string;
  notes: string;
  fileExists: boolean;
  updatedAt: string;
};
export type Opportunity = {
  id: string;
  deleteVersion?: string;
  organization: string;
  role: string;
  direction: string;
  location: string;
  sourceName: string;
  sourceUrl: string;
  description: string;
  priority: 'high' | 'medium' | 'low';
  stage: string;
  closedReason?: 'unknown' | 'rejected' | 'withdrawn';
  stageHistory?: StageHistory[];
  deadline: string | null;
  reminderDays: number[];
  tags: string[];
  notes: string;
  specialNotes: string;
  review: string;
  decision: 'undecided' | 'pursue' | 'hold' | 'skip';
  fitScore: number;
  interestScore: number;
  nextAction: string;
  nextActionAt: string | null;
  highlights: string[];
  risks: string[];
  createdAt: string;
  updatedAt: string;
  lastActivityAt: string;
  stale: boolean;
  tasks: Task[];
  milestones: Milestone[];
  requirements: Requirement[];
  activities: Activity[];
};
export type WorkspaceState = {
  now: string;
  opportunities: Opportunity[];
  tasks: Task[];
  milestones: Milestone[];
  materials: Material[];
  requirements: Requirement[];
  drafts: unknown[];
  pendingDraftCount?: number;
  settings: Record<string, string>;
};
export type { Extraction } from '@/lib/extraction';
export type Mutate = (
  action: string,
  payload: Record<string, unknown>,
) => Promise<unknown>;
