import { eq } from 'drizzle-orm';
import { materials, materialRequirements } from '@/db/schema';
import {
  makeId,
  required,
  unreachable,
  type ActionContext,
  type ActionResult,
  type CommandFor,
} from './context';
import { assertRecordEdit } from './edit-guard';
import { ActionError } from './errors';
import { sameEditValue } from '../opportunity-edit';
import { deleteVersion, materialDeleteVersion } from '../delete-version';

export type MaterialsCommand = CommandFor<
  | 'createMaterial'
  | 'updateMaterial'
  | 'deleteMaterial'
  | 'createRequirement'
  | 'deleteRequirement'
  | 'updateRequirement'
>;

export function applyMaterialCommand(
  context: ActionContext,
  command: MaterialsCommand,
): ActionResult {
  const { tx, timestamp, opportunity, activity } = context;
  switch (command.action) {
    case 'createMaterial': {
      const id = makeId('mat');
      tx.insert(materials)
        .values({
          ...command.payload,
          id,
          createdAt: timestamp,
          updatedAt: timestamp,
        })
        .run();
      return { id };
    }
    case 'updateMaterial': {
      const { id, expected, ...changes } = command.payload;
      const current = required(
        tx.select().from(materials).where(eq(materials.id, id)).get(),
        '材料',
      );
      assertRecordEdit('material', expected, current);
      tx.update(materials)
        .set({ ...changes, updatedAt: timestamp })
        .where(eq(materials.id, id))
        .run();
      if (
        (changes.filePath !== undefined &&
          changes.filePath !== current.filePath) ||
        (changes.version !== undefined && changes.version !== current.version)
      ) {
        const links = tx
          .select()
          .from(materialRequirements)
          .where(eq(materialRequirements.materialId, id))
          .all();
        tx.update(materialRequirements)
          .set({ completed: false })
          .where(eq(materialRequirements.materialId, id))
          .run();
        for (const opportunityId of new Set(links.map((r) => r.opportunityId)))
          activity(
            opportunityId,
            'material',
            `材料路径或版本已替换：${changes.name ?? current.name}，请重新核对就绪状态`,
          );
      }
      return { id };
    }
    case 'deleteMaterial': {
      const { id, expectedVersion } = command.payload;
      const current = required(
        tx.select().from(materials).where(eq(materials.id, id)).get(),
        '材料',
      );
      const links = tx
        .select()
        .from(materialRequirements)
        .where(eq(materialRequirements.materialId, id))
        .all();
      if (
        expectedVersion &&
        materialDeleteVersion(current, links) !== expectedVersion
      )
        throw new ActionError(
          '未移除：材料或关联要求已变化，请核对最新内容后重新确认移除。',
          409,
          'EDIT_CONFLICT',
        );
      tx.update(materialRequirements)
        .set({ materialId: null, completed: false })
        .where(eq(materialRequirements.materialId, id))
        .run();
      tx.delete(materials).where(eq(materials.id, id)).run();
      for (const opportunityId of new Set(links.map((r) => r.opportunityId)))
        activity(
          opportunityId,
          'material',
          `移除了材料引用：${current.name}，岗位要求保留并恢复待准备`,
        );
      return { id };
    }
    case 'createRequirement': {
      const fields = command.payload;
      opportunity(fields.opportunityId);
      if (fields.materialId)
        required(
          tx
            .select()
            .from(materials)
            .where(eq(materials.id, fields.materialId))
            .get(),
          '关联材料',
        );
      const id = makeId('req');
      tx.insert(materialRequirements)
        .values({ ...fields, id, completed: false })
        .run();
      activity(
        fields.opportunityId,
        'material',
        `添加材料要求：${fields.name}`,
      );
      return { id };
    }
    case 'deleteRequirement': {
      const { id, expectedVersion } = command.payload;
      const current = required(
        tx
          .select()
          .from(materialRequirements)
          .where(eq(materialRequirements.id, id))
          .get(),
        '材料要求',
      );
      if (expectedVersion && deleteVersion(current) !== expectedVersion)
        throw new ActionError(
          '未移除：岗位要求已变化，请关闭编辑并核对最新内容后重新确认移除。',
          409,
          'EDIT_CONFLICT',
        );
      tx.delete(materialRequirements)
        .where(eq(materialRequirements.id, id))
        .run();
      activity(
        current.opportunityId,
        'material',
        `移除了材料要求：${current.name}`,
      );
      return { id };
    }
    case 'updateRequirement': {
      const { id, expected, expectedMaterial, ...changes } = command.payload;
      const current = required(
        tx
          .select()
          .from(materialRequirements)
          .where(eq(materialRequirements.id, id))
          .get(),
        '材料要求',
      );
      assertRecordEdit('requirement', expected, current);
      if (expectedMaterial) {
        const linked = required(
          tx
            .select()
            .from(materials)
            .where(eq(materials.id, expectedMaterial.id))
            .get(),
          '关联材料',
        );
        if (
          current.materialId !== linked.id ||
          !sameEditValue(expectedMaterial.filePath, linked.filePath) ||
          !sameEditValue(expectedMaterial.version, linked.version)
        )
          throw new ActionError(
            '未保存：关联材料的路径或版本已变化，请重新核对新文件后标记就绪。',
            409,
            'EDIT_CONFLICT',
          );
      }
      if (changes.materialId)
        required(
          tx
            .select()
            .from(materials)
            .where(eq(materials.id, changes.materialId))
            .get(),
          '关联材料',
        );
      if (
        changes.materialId !== undefined &&
        changes.materialId !== current.materialId
      )
        changes.completed = false; // A replacement needs an explicit new readiness check.
      tx.update(materialRequirements)
        .set(changes)
        .where(eq(materialRequirements.id, id))
        .run();
      activity(
        current.opportunityId,
        'material',
        changes.completed === true && !current.completed
          ? `材料已就绪：${changes.name ?? current.name}`
          : `更新材料要求：${changes.name ?? current.name}`,
      );
      return { id };
    }
  }
  return unreachable(command);
}
