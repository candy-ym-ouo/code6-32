import assert from 'node:assert/strict';
import { actions, actors, plays, towns } from './content.js';
import { validateProduction, ACT_COUNT, SLOTS_PER_ACT, type ProductionDraft, type ProductionTimelineEntry } from './rules.js';

assert.equal(towns.length, 8);
assert.equal(actions.length, 12);
assert.ok(actions.every(a => a.duration > 0 && a.stamina >= 0));

// 每场新戏只有初始三名演员，体力足够测试用
const troupe = actors.slice(0, 3).map(a => ({ id:a.id, name:a.name, stamina:a.stamina }));
const e = (partial:Partial<ProductionTimelineEntry>):ProductionTimelineEntry => ({
  actionId:'enter', actorIds:[troupe[0].id], act:0, slot:0, ...partial,
});
const draft = (timeline:ProductionTimelineEntry[], over:Partial<ProductionDraft> = {}):ProductionDraft => ({
  playId:plays[0].id, assignments:{}, timeline, endings:[0, 0, 0], ...over,
});
// 三幕各一个入场，保证幕间衔接与结局完整，作为其余用例的干净基线
const baseline = ():ProductionTimelineEntry[] => [
  e({ act:0, slot:0 }), e({ actionId:'bow', actorIds:[troupe[1].id], act:1, slot:0 }),
  e({ actionId:'exit', actorIds:[troupe[2].id], act:2, slot:0 }),
];
const valid = (d:ProductionDraft) => assert.deepEqual(validateProduction({ actors:troupe }, d).errors, []);
const invalid = (d:ProductionDraft, fragment:string) => {
  const errors = validateProduction({ actors:troupe }, d).errors;
  assert.ok(errors.length > 0, `expected validation failure for「${fragment}」`);
  assert.ok(errors.some(x => x.includes(fragment)), `expected error mentioning「${fragment}」, got: ${errors.join('；')}`);
};

// 1. 正常编排通过（含多演员协作的联合托举）
valid(draft([
  e({ actionId:'lift', actorIds:[troupe[0].id, troupe[1].id], act:0, slot:0 }),
  e({ actionId:'bow', actorIds:[troupe[2].id], act:1, slot:0 }),
  e({ actionId:'exit', actorIds:[troupe[0].id], act:2, slot:0 }),
]));

// 2. 长动作占位重叠（核心回归）：duel 占第 1-2 拍，enter 落在第 2 拍 —— 旧逻辑只查末拍会漏判
invalid(draft(baseline().concat([
  e({ actionId:'duel', actorIds:[troupe[0].id], act:0, slot:1 }),
  e({ actionId:'enter', actorIds:[troupe[0].id], act:0, slot:2 }),
])), '时间冲突');

// 3. 旧逻辑的反向漏判：先放 enter 在第 2 拍，再放 duel 在第 1-2 拍，同样必须报错
invalid(draft(baseline().concat([
  e({ actionId:'enter', actorIds:[troupe[0].id], act:0, slot:2 }),
  e({ actionId:'duel', actorIds:[troupe[0].id], act:0, slot:1 }),
])), '时间冲突');

// 4. 紧邻但不重叠的两个长/短动作应通过：duel 占 0-1，enter 在 2
valid(draft(baseline().concat([
  e({ actionId:'duel', actorIds:[troupe[0].id], act:0, slot:1 }),
  e({ actionId:'enter', actorIds:[troupe[0].id], act:0, slot:3 }),
])));

// 5. 同演员冲突：两个动作在同一拍
invalid(draft(baseline().concat([
  e({ actionId:'bow', actorIds:[troupe[0].id], act:0, slot:2 }),
  e({ actionId:'cry', actorIds:[troupe[0].id], act:0, slot:2 }),
])), '时间冲突');

// 6. 不同演员同一拍可以同台
valid(draft(baseline().concat([
  e({ actionId:'bow', actorIds:[troupe[1].id], act:0, slot:2 }),
  e({ actionId:'cry', actorIds:[troupe[0].id], act:0, slot:2 }),
])));

// 7. 动作越界：起点超范围
invalid(draft([e({ act:0, slot:4 })]), '超出时间轴');
invalid(draft([e({ act:3, slot:0 })]), '超出时间轴');

// 8. 动作越界：长动作越过幕边界（第 4 拍起两拍动作）
invalid(draft(baseline().concat([
  e({ actionId:'duel', actorIds:[troupe[0].id], act:0, slot:SLOTS_PER_ACT - 1 }),
])), '幕边界');
assert.equal(SLOTS_PER_ACT, 4);
assert.equal(ACT_COUNT, 3);

// 9. 幕间衔接：跳过空幕，第 2 幕有动作但第 1 幕空
invalid(draft([
  e({ act:0, slot:0 }),
  e({ actionId:'bow', actorIds:[troupe[0].id], act:2, slot:0 }),
]), '空幕');

// 10. 幕间衔接：未从第 1 幕开始
invalid(draft([e({ act:1, slot:0 })]), '第 1 幕');

// 11. 多角色协作：联合托举只有一名演员
invalid(draft(baseline().concat([
  e({ actionId:'lift', actorIds:[troupe[0].id], act:0, slot:2 }),
])), '协作');

// 12. 多角色协作：演员重复挂名不算两名
invalid(draft(baseline().concat([
  e({ actionId:'lift', actorIds:[troupe[0].id, troupe[0].id], act:0, slot:2 }),
])), '重复出现');

// 13. 同一条长动作内，多名演员各自的占位都要登记（第二名与他人动作冲突也要报）
invalid(draft(baseline().concat([
  e({ actionId:'lift', actorIds:[troupe[0].id, troupe[1].id], act:0, slot:2 }),
  e({ actionId:'bow', actorIds:[troupe[1].id], act:0, slot:3 }),
])), '时间冲突');

// 14. 结构与完整性
invalid(draft([]), '至少安排一个木偶动作');
invalid(draft(baseline(), { playId:'nope' }), '剧目不存在');
invalid(draft(baseline(), { endings:[0, 1] }), '结局选择不完整');

// 15. 体力：超出可用 +10 的容错时拒绝（每人三幕基线 + 大量高消耗动作）
const exhausted = actors.slice(0, 1).map(a => ({ id:a.id, name:a.name, stamina:10 }));
const heavyTimeline:ProductionTimelineEntry[] = [];
for (let k = 0; k < 4; k++) heavyTimeline.push(e({ actionId:'duel', actorIds:[exhausted[0].id], act:0, slot:0 }));
assert.ok(validateProduction({ actors:exhausted }, draft(heavyTimeline)).errors.some(x => x.includes('体力不足')));

console.log('rules tests passed (15 scenarios)');
