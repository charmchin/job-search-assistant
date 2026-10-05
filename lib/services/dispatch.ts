import type { ActionCommand } from '../action-schema';
import {
  createActionContext,
  unreachable,
  type Writer,
  type ActionResult,
} from './context';
import { applyOpportunityCommand } from './opportunities';
import { applyTaskCommand } from './tasks';
import { applyMilestoneCommand } from './milestones';
import { applyMaterialCommand } from './materials';
import { applyWorkspaceCommand } from './workspace';

// Exhaustive dispatch: adding a schema command requires selecting its owner.
// All handlers remain synchronous and share one transaction and timestamp.
export function applyCommand(
  tx: Writer,
  command: ActionCommand,
  timestamp: Date,
): ActionResult {
  const context = createActionContext(tx, timestamp);
  switch (command.action) {
    case 'createOpportunity':
    case 'updateOpportunity':
    case 'deleteOpportunity':
    case 'addStageHistory':
    case 'invalidateStageHistory':
      return applyOpportunityCommand(context, command);
    case 'createTask':
    case 'updateTask':
    case 'setNextTask':
      return applyTaskCommand(context, command);
    case 'createMilestone':
    case 'updateMilestone':
      return applyMilestoneCommand(context, command);
    case 'createMaterial':
    case 'updateMaterial':
    case 'deleteMaterial':
    case 'createRequirement':
    case 'deleteRequirement':
    case 'updateRequirement':
      return applyMaterialCommand(context, command);
    case 'addActivity':
    case 'discardDraft':
    case 'saveSettings':
      return applyWorkspaceCommand(context, command);
  }
  return unreachable(command);
}
