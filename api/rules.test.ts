import assert from 'node:assert/strict';
import { actions, actors, towns } from './content.js';
import { validateProduction, type TimelineEntry, type DraftLike } from './rules.js';

assert.equal(towns.length, 8);
assert.equal(actions.length, 12);
assert.ok(actions.every(a => a.duration > 0 && a.stamina >= 0));

const cast = actors.slice(0, 3).map(a => ({ id: a.id, name: a.name, stamina: a.stamina }));
const E = (actionId: string, actorIds: string[], act: number, slot: number): TimelineEntry =>
  ({ actionId, actorIds, act, slot });

// 合法基线：每幕 slot0 三人入场，中段各自动作，slot3 三人退场
function validTimeline(): TimelineEntry[] {
  const tl: TimelineEntry[] = [];
  for (let act = 0; act < 3; act++) {
    tl.push(E('enter', ['mei', 'luo', 'yan'], act, 0));
    tl.push(E('bow', ['mei'], act, 1));
    tl.push(E('bow', ['luo'], act, 2));
    tl.push(E('exit', ['mei', 'luo', 'yan'], act, 3));
  }
  return tl;
}
const draft = (timeline: TimelineEntry[], over: Partial<DraftLike> = {}): DraftLike =>
  ({ playId: 'moon', timeline, endings: [0, 1, 2], ...over });
const check = (timeline: TimelineEntry[], over?: Partial<DraftLike>) =>
  validateProduction(cast, draft(timeline, over));
const has = (errors: string[], re: RegExp) => errors.some(m => re.test(m));

// 1. 基线合法
assert.equal(check(validTimeline()).ok, true, '基线编排应当通过');

// 2. 核心回归：长动作占位重叠（旧实现只标记最后一拍，漏判）
{
  const tl = validTimeline();
  // 第 1 幕：梅枝 slot1 放 2 拍的对决（占拍 1、2），slot1 再放 1 拍鞠躬（占拍 1）
  tl[1] = E('duel', ['mei'], 0, 1);
  tl.splice(2, 0, E('bow', ['mei'], 0, 1));
  const r = check(tl);
  assert.equal(r.ok, false, '长动作与同拍动作重叠必须拦截');
  assert.ok(has(r.errors, /时间冲突/), `应报时间冲突，实际：${r.errors.join('|')}`);
}

// 3. 长动作边界重叠：[1,3) 与 [2,4) 共享第 2 拍
{
  const tl = validTimeline();
  tl[1] = E('duel', ['mei'], 0, 1); // 占拍 1、2
  tl[2] = E('duel', ['luo'], 0, 2); // 不同演员，不冲突
  tl.splice(2, 0, E('duel', ['mei'], 0, 2)); // 同演员，占拍 2、3
  const r = check(tl);
  assert.ok(has(r.errors, /时间冲突/), `边界重叠必须报冲突，实际：${r.errors.join('|')}`);
}

// 4. 区间相邻不重叠应当放行：[1,3) 之后 slot3 退场
{
  const tl = validTimeline();
  tl[1] = E('duel', ['mei'], 0, 1); // 占拍 1、2
  // 退场在 slot3（拍 3），与 [1,3) 不相交
  const r = check(tl);
  assert.ok(!has(r.errors, /时间冲突/), `相邻区间不应报冲突，实际：${r.errors.join('|')}`);
}

// 5. 动作越界：长动作越过本幕结尾
{
  const tl = validTimeline();
  tl[1] = E('duel', ['yan'], 0, 3); // 2 拍动作从最后一拍开始
  const r = check(tl);
  assert.ok(has(r.errors, /越过了本幕结尾/), `应报越界，实际：${r.errors.join('|')}`);
}

// 6. 动作越界：幕/拍下标非法
{
  assert.ok(has(check([E('bow', ['mei'], 3, 0), ...validTimeline().slice(3)]).errors, /超出时间轴/));
  const badSlot = validTimeline();
  badSlot[1] = E('bow', ['mei'], 0, 4);
  assert.ok(has(check(badSlot).errors, /超出时间轴/));
  const negative = validTimeline();
  negative[1] = E('bow', ['mei'], -1, 0);
  assert.ok(has(check(negative).errors, /超出时间轴/));
}

// 7. 同演员冲突：同一条目内重复指定
{
  const tl = validTimeline();
  tl[1] = E('bow', ['mei', 'mei'], 0, 1);
  const r = check(tl);
  assert.ok(has(r.errors, /重复指定了同一演员/), `应报重复演员，实际：${r.errors.join('|')}`);
}

// 8. 同演员不冲突的并行是允许的：不同演员同一拍各自行动（基线入场即如此）
assert.equal(check(validTimeline()).errors.filter(m => /时间冲突/.test(m)).length, 0);

// 9. 幕间衔接：缺少入场
{
  const tl = validTimeline().filter(e => !(e.act === 1 && e.actionId === 'enter'));
  const r = check(tl);
  assert.ok(has(r.errors, /出场前未入场/), `应报未入场，实际：${r.errors.join('|')}`);
}

// 10. 幕间衔接：缺少退场
{
  const tl = validTimeline().filter(e => !(e.act === 1 && e.actionId === 'exit'));
  const r = check(tl);
  assert.ok(has(r.errors, /结束前没有退场/), `应报未退场，实际：${r.errors.join('|')}`);
}

// 11. 幕间衔接：入场晚于开场时限
{
  const tl = validTimeline();
  for (let i = 0; i < tl.length; i++) if (tl[i].act === 2 && tl[i].actionId === 'enter') tl[i] = E('enter', ['mei', 'luo', 'yan'], 2, 3);
  const r = check(tl);
  assert.ok(has(r.errors, /入场晚于/), `应报入场过晚，实际：${r.errors.join('|')}`);
}

// 12. 幕间衔接：中间整幕留空造成断层
{
  const tl = validTimeline().filter(e => e.act !== 1);
  const r = check(tl);
  assert.ok(has(r.errors, /断层/), `应报幕间断层，实际：${r.errors.join('|')}`);
}

// 13. 幕间衔接：重复入场 / 重复退场
{
  const dupEnter = validTimeline();
  dupEnter.push(E('enter', ['mei'], 0, 2));
  assert.ok(has(check(dupEnter).errors, /重复入场/));
  const dupExit = validTimeline();
  dupExit.push(E('exit', ['mei'], 0, 2));
  assert.ok(has(check(dupExit).errors, /重复退场/));
}

// 13b. 同一演员入场与动作同拍属于真实占位冲突（入场本身占一拍），必须拦截
{
  const tl = validTimeline();
  tl[1] = E('bow', ['mei'], 0, 0); // 与梅枝入场同拍
  const r = check(tl);
  assert.ok(has(r.errors, /时间冲突/), `同拍入场应报占位冲突，实际：${r.errors.join('|')}`);
}

// 13c. 入场晚于其他动作 / 退场早于其他动作
{
  // 第 1 幕：梅枝 slot1 先鞠躬，slot2 才入场（无拍位冲突，但顺序非法）
  const late = validTimeline();
  late[0] = E('enter', ['luo', 'yan'], 0, 0);
  late[1] = E('bow', ['mei'], 0, 1);
  late.splice(2, 0, E('enter', ['mei'], 0, 2));
  assert.ok(has(check(late).errors, /先行动后入场/));
  // 第 1 幕：梅枝 slot0 退场，slot1 才鞠躬（顺序非法）
  const earlyExit = validTimeline();
  for (let i = 0; i < earlyExit.length; i++) {
    if (earlyExit[i].act === 0 && earlyExit[i].actionId === 'exit') {
      earlyExit[i] = E('exit', ['luo', 'yan'], 0, 3);
      earlyExit.splice(i, 0, E('exit', ['mei'], 0, 0));
      break;
    }
  }
  assert.ok(has(check(earlyExit).errors, /退场后仍有动作/));
}

// 14. 多角色协作：联合托举仅 1 人必须拦截
{
  const tl = validTimeline();
  tl[1] = E('lift', ['mei'], 0, 1); // 2 拍，占拍 1、2
  tl.splice(2, 1); // 移除 slot2 罗盘点的鞠躬，避免无关冲突
  const r = check(tl);
  assert.ok(has(r.errors, /需要至少 2 名演员协作/), `应报协作人数不足，实际：${r.errors.join('|')}`);
}

// 15. 多角色协作：联合托举 2 人同时占用相同拍位但不冲突，应当通过
{
  const tl = validTimeline();
  tl[1] = E('lift', ['mei', 'luo'], 0, 1); // 两人各占拍 1、2
  tl.splice(2, 1); // 移除 slot2 罗盘鞠躬（他正在托举）
  const r = check(tl);
  assert.equal(r.ok, true, `双人托举应合法，实际：${r.errors.join('|')}`);
}

// 16. 体力不足
{
  const weak = cast.map(a => a.id === 'mei' ? { ...a, stamina: 5 } : a);
  const r = validateProduction(weak, draft(validTimeline()));
  assert.ok(has(r.errors, /体力不足/), `应报体力不足，实际：${r.errors.join('|')}`);
}

// 17. 结局不完整
assert.ok(has(check(validTimeline(), { endings: [0, 1] }).errors, /结局选择不完整/));
assert.ok(has(check(validTimeline(), { endings: [0, 1, 9] }).errors, /结局选择不完整/));
assert.ok(has(check(validTimeline(), { endings: ['x', 0, 1] as unknown as number[] }).errors, /结局选择不完整/));

// 18. 未知剧目 / 未知动作 / 未知演员 / 空时间轴
assert.ok(has(check(validTimeline(), { playId: 'nope' }).errors, /剧目不存在/));
const unknownAction = validTimeline();
unknownAction[1] = E('nope', ['mei'], 0, 1);
assert.ok(has(check(unknownAction).errors, /未知动作/));
const unknownActor = validTimeline();
unknownActor[1] = E('bow', ['zzz'], 0, 1);
assert.ok(has(check(unknownActor).errors, /未知演员/));
assert.ok(has(check([]).errors, /至少安排一个木偶动作/));

// 19. 动作定义协作人数约束自洽
assert.ok(actions.filter(a => a.minActors).every(a => (a.minActors ?? 1) >= 2));

console.log('rules tests passed (19 groups)');
