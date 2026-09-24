import { actions, plays } from './content.js';

export type ProductionTimelineEntry = { actionId:string; actorIds:string[]; act:number; slot:number };
export type ProductionDraft = { playId:string; assignments:Record<string, unknown>; timeline:ProductionTimelineEntry[]; endings:number[] };
export type TourActorLike = { id:string; name:string; stamina:number };

export const ACT_COUNT = 3;
export const SLOTS_PER_ACT = 4;

type Result = { errors:string[]; p:(typeof plays)[number]|undefined };

// 编排校验：剧目时间轴为 3 幕 × 每幕 4 拍的网格。
// 长动作（duration > 1）从起始拍开始连续占位，占位不可越过幕边界，
// 同一名演员占用的任何一拍都不能与其他动作重叠。
export function validateProduction(
  t:{ actors:TourActorLike[] },
  d:Partial<ProductionDraft>|null|undefined,
):Result {
  const errors:string[] = [];
  if (!d || typeof d !== 'object') return { errors:['编排数据格式错误'], p:undefined };

  const p = plays.find(x => x.id === d.playId);
  if (!p) errors.push('剧目不存在');

  const timeline = Array.isArray(d.timeline) ? d.timeline : [];
  if (timeline.length === 0) errors.push('至少安排一个木偶动作');

  // actor-act-slot -> 占位动作下标；known[i] 标记第 i 条是否为结构完整的动作
  const occupied = new Map<string, number>();
  const reportedConflicts = new Set<string>();
  const usedActs = new Set<number>();
  const known: boolean[] = [];

  timeline.forEach((e, i) => {
    if (!e || typeof e !== 'object') { errors.push('动作数据格式错误'); known[i] = false; return; }

    const action = actions.find(x => x.id === e.actionId);
    if (!action) errors.push('包含未知动作');

    const validPos = Number.isInteger(e.slot) && Number.isInteger(e.act)
      && e.slot >= 0 && e.slot < SLOTS_PER_ACT && e.act >= 0 && e.act < ACT_COUNT;
    if (!validPos) { errors.push('动作位置超出时间轴'); known[i] = false; return; }

    usedActs.add(e.act);
    const duration = action?.duration ?? 1;
    const endSlot = e.slot + duration - 1;
    if (endSlot >= SLOTS_PER_ACT) {
      errors.push(`「${action?.name ?? '动作'}」从第 ${e.slot + 1} 拍起共 ${duration} 拍，超出第 ${e.act + 1} 幕边界`);
      known[i] = false; return;
    }

    const ids = Array.isArray(e.actorIds) ? e.actorIds : [];
    const minActors = action?.minActors ?? 1;
    if (ids.length < minActors) {
      errors.push(`「${action?.name}」需要至少 ${minActors} 名演员协作`);
    }

    // 同一条动作里重复挂同一名演员没有意义，也会污染占格统计
    const entryActors = new Set<string>();
    for (const id of ids) {
      if (!t.actors.some(a => a.id === id)) { errors.push('包含未知演员'); continue; }
      if (entryActors.has(id)) errors.push(`同一名演员在「${action?.name ?? '动作'}」中重复出现`);
      entryActors.add(id);

      for (let s = e.slot; s <= endSlot; s++) {
        const key = `${id}-${e.act}-${s}`;
        const j = occupied.get(key);
        if (j !== undefined) {
          const pair = i < j ? `${i}-${j}-${id}` : `${j}-${i}-${id}`;
          if (!reportedConflicts.has(pair)) {
            reportedConflicts.add(pair);
            errors.push(`演员在第 ${e.act + 1} 幕第 ${s + 1} 拍存在时间冲突（长动作占位重叠）`);
          }
        } else {
          occupied.set(key, i);
        }
      }
    }
    known[i] = true;
  });

  // 幕间衔接：第 1 幕必须开演，已使用的幕之间不允许跳过空幕
  let firstAct = -1;
  for (let act = 0; act < ACT_COUNT; act++) if (usedActs.has(act)) { firstAct = act; break; }
  if (firstAct > 0) errors.push('编排必须从第 1 幕开始');
  if (firstAct === 0) {
    for (let act = 0; act < ACT_COUNT; act++) {
      if (!usedActs.has(act) && act + 1 < ACT_COUNT && usedActs.has(act + 1)) {
        errors.push(`第 ${act + 1} 幕为空，幕间不能跳过空幕直接进入第 ${act + 2} 幕`);
      }
    }
  }

  // 体力结算：协作动作的每名参与演员都要支付该动作的体力消耗
  for (const actor of t.actors) {
    let used = 0;
    timeline.forEach((e, i) => {
      if (!known[i] || !Array.isArray(e?.actorIds) || !e.actorIds.includes(actor.id)) return;
      used += actions.find(x => x.id === e.actionId)?.stamina ?? 0;
    });
    if (used > actor.stamina + 10) errors.push(`${actor.name}体力不足（需要 ${used}，可用 ${actor.stamina}）`);
  }

  const endings = Array.isArray(d.endings) ? d.endings : [];
  if (endings.length !== ACT_COUNT || endings.some(x => !Number.isInteger(x) || x < 0 || x > 2)) {
    errors.push('结局选择不完整');
  }

  return { errors, p };
}
