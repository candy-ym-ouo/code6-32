import { actions, plays, type Action, type Play } from './content.js';

// 每幕可用拍位：slot 取值 0..SLOTS_PER_ACT-1
export const SLOTS_PER_ACT = 4;
export const ACT_COUNT = 3;
// 入场动作（1 拍）必须从此时限之前开始
export const ENTER_BY_SLOT = 2;
// 允许的体力透支余量，与原有结算口径保持一致
export const STAMINA_TOLERANCE = 10;

export type TimelineEntry = { actionId:string; actorIds:string[]; act:number; slot:number };
export type DraftLike = { playId?:string; timeline?:TimelineEntry[]; endings?:number[] };
type RuleActor = { id:string; name:string; stamina:number };

export type ValidationResult = {
  ok:boolean;
  errors:string[];
  play?:Play;
  entries:{ action:Action; actorIds:string[]; act:number; slot:number }[];
};

/**
 * 编排规则：
 * 1. 长动作占位：动作占用 [slot, slot+duration) 每一拍，与同一演员的任何
 *    其他动作区间相交即判冲突（修复旧实现只标记最后一拍导致重叠漏判）。
 * 2. 同演员冲突：同一条目内演员不可重复；跨条目按逐拍占用表判定。
 * 3. 动作越界：幕/拍必须合法，长动作不得越过本幕结尾。
 * 4. 幕间衔接：不得出现空幕断层；每位演员在其登场的幕中必须先入场、
 *    最后退场，且入场须在开场时限内。
 * 5. 多角色协作：联合托举等动作必须满足最低参演人数。
 * 另含体力与结局完整性校验。
 */
export function validateProduction(actors:RuleActor[], d:DraftLike):ValidationResult {
  const errors:string[] = [];
  const entries:ValidationResult['entries'] = [];
  if (!d || typeof d !== 'object') return { ok:false, errors:['编排数据格式错误'], entries };

  const play = plays.find(x => x.id === d.playId);
  if (!play) errors.push('剧目不存在');

  const timeline = Array.isArray(d.timeline) ? d.timeline : [];
  if (timeline.length === 0) errors.push('至少安排一个木偶动作');

  const actorById = new Map(actors.map(a => [a.id, a]));
  // busy[actorId][act]：每一拍占用该拍的条目下标；-1 表示空闲
  const busy = new Map<string, Int16Array[]>();
  for (const a of actors) {
    busy.set(a.id, Array.from({length:ACT_COUNT}, () => new Int16Array(SLOTS_PER_ACT).fill(-1)));
  }
  // participation[actorId][act]：该演员在该幕登场的条目（按下标收集）
  const participation = new Map<string, number[][]>();
  for (const a of actors) participation.set(a.id, Array.from({length:ACT_COUNT}, () => []));
  const actsUsed = new Array(ACT_COUNT).fill(false);
  // 与 timeline 下标对齐的解析结果；无法解析的条目为 null
  const resolved:(ValidationResult['entries'][number]|null)[] = new Array(timeline.length).fill(null);

  timeline.forEach((e, index) => {
    if (!e || typeof e !== 'object') { errors.push('动作数据格式错误'); return; }
    const action = actions.find(x => x.id === e.actionId);
    if (!action) { errors.push('包含未知动作'); return; }
    const { act, slot } = e;
    const where = `第${Number.isInteger(act)?act+1:'?'}幕第${Number.isInteger(slot)?slot+1:'?'}拍「${action.name}」`;

    // 越界：幕、拍合法性
    if (!Number.isInteger(act) || act < 0 || act >= ACT_COUNT ||
        !Number.isInteger(slot) || slot < 0 || slot >= SLOTS_PER_ACT) {
      errors.push(`${where}位置超出时间轴`);
      return;
    }
    // 越界：长动作占位不得越过本幕最后一拍
    const end = slot + action.duration; // 排他结束拍
    if (end > SLOTS_PER_ACT) {
      errors.push(`${where}时长 ${action.duration} 拍，越过了本幕结尾`);
      return;
    }

    const rawIds = Array.isArray(e.actorIds) ? e.actorIds : [];
    if (rawIds.length === 0) errors.push(`${where}至少需要一名演员`);
    // 同一条目内的同演员重复
    const actorIds = [...new Set(rawIds)];
    if (actorIds.length < rawIds.length) errors.push(`${where}重复指定了同一演员`);

    // 多角色协作：最低参演人数
    const minActors = action.minActors ?? 1;
    if (actorIds.length < minActors) errors.push(`${where}需要至少 ${minActors} 名演员协作`);

    for (const id of actorIds) {
      const actor = actorById.get(id);
      if (!actor) { errors.push(`${where}包含未知演员`); continue; }

      // 同演员冲突：逐拍区间相交判定
      const grid = busy.get(id)!;
      for (let beat = slot; beat < end; beat++) {
        const holder = grid[act][beat];
        if (holder !== -1) {
          const h = timeline[holder];
          const ha = actions.find(x => x.id === h?.actionId);
          errors.push(`${actor.name}在第${act+1}幕第${beat+1}拍存在时间冲突（与${ha?`「${ha.name}」` : '另一动作'}重叠）`);
        } else {
          grid[act][beat] = index;
        }
      }
      participation.get(id)![act].push(index);
    }
    actsUsed[act] = true;
    resolved[index] = { action, actorIds, act, slot };
    entries.push(resolved[index]!);
  });

  // 幕间衔接：不得出现空幕断层（后面还有幕要用，中间却空着）
  for (let act = 0; act < ACT_COUNT; act++) {
    if (!actsUsed[act] && actsUsed.some((u, i) => i > act && u)) {
      errors.push(`第${act+1}幕没有安排任何动作，幕间出现断层`);
    }
  }

  // 幕间衔接：每位演员在其登场的幕中，必须先入场、最后退场
  for (const actor of actors) {
    for (let act = 0; act < ACT_COUNT; act++) {
      const seq = participation.get(actor.id)![act]
        .map(i => resolved[i])
        .filter((x):x is NonNullable<typeof x> => x !== null);
      if (seq.length === 0) continue;
      const enters = seq.filter(x => x.action.id === 'enter');
      const exits = seq.filter(x => x.action.id === 'exit');
      // 入场：唯一、不晚于开场时限、不晚于同幕任何其他动作
      if (enters.length === 0) {
        errors.push(`${actor.name}在第${act+1}幕出场前未入场（首个动作应为「入场」）`);
      } else {
        if (enters.length > 1) errors.push(`${actor.name}在第${act+1}幕重复入场`);
        const enter = enters[0];
        const earliestOther = Math.min(...seq.filter(x => x.action.id !== 'enter').map(x => x.slot));
        if (enter.slot > ENTER_BY_SLOT) errors.push(`${actor.name}在第${act+1}幕的入场晚于第${ENTER_BY_SLOT+1}拍`);
        if (Number.isFinite(earliestOther) && enter.slot > earliestOther) {
          errors.push(`${actor.name}在第${act+1}幕先行动后入场，幕间衔接顺序错误`);
        }
      }
      // 退场：唯一、不早于同幕任何其他动作
      if (exits.length === 0) {
        errors.push(`${actor.name}在第${act+1}幕结束前没有退场（最后一个动作应为「退场」）`);
      } else {
        if (exits.length > 1) errors.push(`${actor.name}在第${act+1}幕重复退场`);
        const exit = exits[0];
        const latestOther = Math.max(...seq.filter(x => x.action.id !== 'exit').map(x => x.slot));
        if (Number.isFinite(latestOther) && exit.slot < latestOther) {
          errors.push(`${actor.name}在第${act+1}幕退场后仍有动作，幕间衔接顺序错误`);
        }
      }
    }
  }

  // 体力（含原有 +10 透支余量口径）
  for (const actor of actors) {
    const used = entries
      .filter(e => e.actorIds.includes(actor.id))
      .reduce((n, e) => n + e.action.stamina, 0);
    if (used > actor.stamina + STAMINA_TOLERANCE) errors.push(`${actor.name}体力不足`);
  }

  // 结局：三幕各选一个，且索引必须存在于该剧目的结局列表
  const endingCount = play?.endings.length ?? 3;
  const endingList = Array.isArray(d.endings) ? d.endings : [];
  if (endingList.length !== ACT_COUNT ||
      endingList.some(x => !Number.isInteger(x) || x < 0 || x >= endingCount)) {
    errors.push('结局选择不完整');
  }

  return { ok: errors.length === 0, errors, play, entries };
}
