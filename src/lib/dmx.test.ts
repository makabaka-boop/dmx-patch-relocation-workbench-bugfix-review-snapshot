import { describe, expect, it } from "vitest";
import {
  ConflictGroup,
  Fixture,
  PatchEngine,
  compareGroups,
  compareUtf8,
  computeGroups,
  endOf,
  parsePatch,
} from "./dmx";

/* ---------- 测试工具：确定性随机数与朴素两两预言机 ---------- */

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomPatch(
  rand: () => number,
  n: number,
  universes: number,
  maxFootprint: number,
): Fixture[] {
  const out: Fixture[] = [];
  for (let i = 0; i < n; i++) {
    const footprint = 1 + Math.floor(rand() * maxFootprint);
    const start = 1 + Math.floor(rand() * (513 - footprint));
    out.push({
      id: `f${i}`,
      universe: 1 + Math.floor(rand() * universes),
      start,
      footprint,
    });
  }
  return out;
}

function intersects(a: Fixture, b: Fixture): boolean {
  return a.universe === b.universe && a.start <= endOf(b) && b.start <= endOf(a);
}

/** 朴素 O(n²) 两两相交 + 并查集预言机。 */
function naiveGroups(fixtures: Fixture[]): ConflictGroup[] {
  const parent = new Map<string, string>(fixtures.map((f) => [f.id, f.id]));
  const find = (x: string): string => {
    let root = x;
    while (parent.get(root)! !== root) root = parent.get(root)!;
    let cur = x;
    while (parent.get(cur)! !== cur) {
      const next = parent.get(cur)!;
      parent.set(cur, root);
      cur = next;
    }
    return root;
  };
  for (let i = 0; i < fixtures.length; i++) {
    for (let j = i + 1; j < fixtures.length; j++) {
      if (intersects(fixtures[i], fixtures[j])) {
        const ra = find(fixtures[i].id);
        const rb = find(fixtures[j].id);
        if (ra !== rb) parent.set(ra, rb);
      }
    }
  }
  const comps = new Map<string, Fixture[]>();
  for (const f of fixtures) {
    const root = find(f.id);
    const arr = comps.get(root);
    if (arr) arr.push(f);
    else comps.set(root, [f]);
  }
  const groups: ConflictGroup[] = [];
  for (const members of comps.values()) {
    if (members.length < 2) continue;
    groups.push({
      universe: members[0].universe,
      minStart: Math.min(...members.map((m) => m.start)),
      ids: members.map((m) => m.id).sort(compareUtf8),
    });
  }
  groups.sort(compareGroups);
  return groups;
}

/** 朴素两两直接冲突预言机。 */
function naiveHits(
  fixtures: Fixture[],
  selfId: string,
  universe: number,
  start: number,
  footprint: number,
): string[] {
  const probe: Fixture = { id: selfId, universe, start, footprint };
  return fixtures
    .filter((f) => f.id !== selfId && intersects(f, probe))
    .map((f) => f.id)
    .sort(compareUtf8);
}

/* ---------- 导入校验 ---------- */

describe("parsePatch 校验", () => {
  const valid = { id: "a", universe: 1, start: 1, footprint: 1 };

  it("接受合法边界值", () => {
    expect(parsePatch([valid])).toEqual([valid]);
    expect(
      parsePatch([{ id: "x".repeat(32), universe: 32768, start: 512, footprint: 1 }]),
    ).not.toBeNull();
    // start + footprint = 513 合法
    expect(parsePatch([{ id: "a", universe: 1, start: 1, footprint: 512 }])).not.toBeNull();
    expect(parsePatch([{ id: "a b", universe: 1, start: 1, footprint: 1 }])).not.toBeNull();
    const max = Array.from({ length: 200_000 }, (_, i) => ({
      id: `id${i}`,
      universe: 1,
      start: 1,
      footprint: 1,
    }));
    expect(parsePatch(max)).toHaveLength(200_000);
  });

  const invalidCases: Array<[string, unknown]> = [
    ["非数组", { 0: valid }],
    ["空数组", []],
    ["超过 200000 项", Array(200_001).fill(valid)],
    ["条目为 null", [null]],
    ["条目为数组", [[1, 2, 3]]],
    ["id 为空串", [{ ...valid, id: "" }]],
    ["id 超过 32 位", [{ ...valid, id: "x".repeat(33) }]],
    ["id 含非 ASCII", [{ ...valid, id: "灯" }]],
    ["id 含控制字符", [{ ...valid, id: "a\tb" }]],
    ["id 含 DEL", [{ ...valid, id: "ab" }]],
    ["id 非字符串", [{ ...valid, id: 7 }]],
    ["id 重复", [valid, { ...valid }]],
    ["universe 为 0", [{ ...valid, universe: 0 }]],
    ["universe 为 32769", [{ ...valid, universe: 32_769 }]],
    ["universe 非整数", [{ ...valid, universe: 1.5 }]],
    ["universe 为字符串", [{ ...valid, universe: "1" }]],
    ["start 为 0", [{ ...valid, start: 0 }]],
    ["start 为 513", [{ ...valid, start: 513 }]],
    ["start 非整数", [{ ...valid, start: 2.5 }]],
    ["footprint 为 0", [{ ...valid, footprint: 0 }]],
    ["footprint 为 513", [{ ...valid, footprint: 513 }]],
    ["start+footprint 为 514", [{ ...valid, start: 2, footprint: 512 }]],
    ["缺少 footprint", [{ id: "a", universe: 1, start: 1 }]],
  ];

  it("非法输入整体返回 null", () => {
    for (const [name, data] of invalidCases) {
      expect(parsePatch(data), name).toBeNull();
    }
  });
});

/* ---------- UTF-8 字节序 ---------- */

describe("UTF-8 字节序比较", () => {
  it("按字节序而非 UTF-16 码元序", () => {
    expect(compareUtf8("A", "a")).toBeLessThan(0);
    expect(compareUtf8("a1", "a2")).toBeLessThan(0);
    expect(compareUtf8("ab", "abc")).toBeLessThan(0);
    expect(compareUtf8("z", "é")).toBeLessThan(0); // 0x7A < 0xC3
    expect(compareUtf8("é", "中")).toBeLessThan(0); // 0xC3 < 0xE4
    expect(compareUtf8("abc", "abc")).toBe(0);
    // U+FFFF 的 UTF-8 (EF BF BF) < U+1F600 的 UTF-8 (F0 ...)，与 UTF-16 码元序相反
    expect(compareUtf8("￿", "\u{1F600}")).toBeLessThan(0);
    expect("￿" < "\u{1F600}").toBe(false);
  });
});

/* ---------- 冲突分组 ---------- */

describe("computeGroups", () => {
  it("闭区间端点相接即冲突", () => {
    const groups = computeGroups([
      { id: "a", universe: 1, start: 1, footprint: 2 }, // [1,2]
      { id: "b", universe: 1, start: 2, footprint: 2 }, // [2,3] 与 a 相切于 2
      { id: "c", universe: 1, start: 4, footprint: 1 }, // [4,4] 与 b 隔 1 通道，不冲突
    ]);
    expect(groups).toEqual([{ universe: 1, minStart: 1, ids: ["a", "b"] }]);
  });

  it("通道 512 端点相接", () => {
    const groups = computeGroups([
      { id: "x", universe: 1, start: 510, footprint: 3 }, // [510,512]
      { id: "y", universe: 1, start: 512, footprint: 1 }, // [512,512]
    ]);
    expect(groups).toEqual([{ universe: 1, minStart: 510, ids: ["x", "y"] }]);
  });

  it("嵌套区间属于同组", () => {
    const groups = computeGroups([
      { id: "outer", universe: 1, start: 1, footprint: 512 },
      { id: "inner", universe: 1, start: 100, footprint: 100 },
      { id: "core", universe: 1, start: 120, footprint: 20 },
      { id: "free", universe: 1, start: 1, footprint: 1 }, // 被 outer 覆盖，也同组
    ]);
    expect(groups).toEqual([
      { universe: 1, minStart: 1, ids: ["core", "free", "inner", "outer"] },
    ]);
  });

  it("不同 universe 不相交", () => {
    const groups = computeGroups([
      { id: "a", universe: 1, start: 1, footprint: 10 },
      { id: "b", universe: 2, start: 1, footprint: 10 },
    ]);
    expect(groups).toEqual([]);
  });

  it("孤立灯具不成组", () => {
    const groups = computeGroups([
      { id: "a", universe: 1, start: 1, footprint: 1 },
      { id: "b", universe: 1, start: 100, footprint: 10 },
    ]);
    expect(groups).toEqual([]);
  });

  it("组内 id 按 UTF-8 字节序", () => {
    const groups = computeGroups([
      { id: "b", universe: 1, start: 1, footprint: 4 },
      { id: "A", universe: 1, start: 2, footprint: 4 },
      { id: "a", universe: 1, start: 3, footprint: 4 },
    ]);
    expect(groups[0].ids).toEqual(["A", "a", "b"]);
  });

  it("组按 universe、最小 start、首 id 排序", () => {
    const groups = computeGroups([
      { id: "x", universe: 2, start: 10, footprint: 6 }, // u2 [10,15]
      { id: "y", universe: 2, start: 15, footprint: 5 }, // u2 [15,19] 与 x 相切
      { id: "p", universe: 1, start: 100, footprint: 5 },
      { id: "q", universe: 1, start: 102, footprint: 5 },
      { id: "r", universe: 1, start: 5, footprint: 5 },
      { id: "s", universe: 1, start: 6, footprint: 5 },
    ]);
    expect(groups).toEqual([
      { universe: 1, minStart: 5, ids: ["r", "s"] },
      { universe: 1, minStart: 100, ids: ["p", "q"] },
      { universe: 2, minStart: 10, ids: ["x", "y"] },
    ]);
  });

  it("compareGroups 首 id 次序作为最终决胜", () => {
    const a: ConflictGroup = { universe: 1, minStart: 5, ids: ["b", "x"] };
    const b: ConflictGroup = { universe: 1, minStart: 5, ids: ["a", "y"] };
    expect(compareGroups(a, b)).toBeGreaterThan(0);
    expect(compareGroups(b, a)).toBeLessThan(0);
  });

  it("与朴素两两预言机一致（随机补丁）", () => {
    const rand = mulberry32(1_234_567);
    for (let round = 0; round < 300; round++) {
      const n = 1 + Math.floor(rand() * 60);
      const patch = randomPatch(rand, n, 4, 24);
      expect(computeGroups(patch)).toEqual(naiveGroups(patch));
      expect(new PatchEngine(patch).getGroups()).toEqual(naiveGroups(patch));
    }
  });
});

/* ---------- 试移与提交 ---------- */

describe("试移与提交", () => {
  it("分别列出原位与目标位的直接冲突", () => {
    const engine = new PatchEngine([
      { id: "a", universe: 1, start: 1, footprint: 4 }, // [1,4] 与 b 冲突
      { id: "b", universe: 1, start: 3, footprint: 4 }, // [3,6]
      { id: "blocker", universe: 2, start: 5, footprint: 10 }, // [5,14]
    ]);
    const t = engine.trialMove("a", 2, 6)!;
    expect(t.origin).toEqual(["b"]);
    expect(t.target).toEqual(["blocker"]);
    expect(t.canCommit).toBe(false);
  });

  it("目标位被占用时提交被拒绝且补丁不变", () => {
    const engine = new PatchEngine([
      { id: "a", universe: 1, start: 1, footprint: 4 },
      { id: "b", universe: 1, start: 3, footprint: 4 },
      { id: "blocker", universe: 2, start: 5, footprint: 10 },
    ]);
    const before = engine.exportFixtures();
    const r = engine.commit("a", 2, 6)!;
    expect(r.canCommit).toBe(false);
    expect(engine.exportFixtures()).toEqual(before);
    expect(engine.getGroups()).toEqual([
      { universe: 1, minStart: 1, ids: ["a", "b"] },
    ]);
  });

  it("提交后冲突组被拆开", () => {
    const engine = new PatchEngine([
      { id: "a", universe: 1, start: 1, footprint: 10 }, // [1,10]
      { id: "b", universe: 1, start: 5, footprint: 11 }, // [5,15] 桥接 a 与 c/d
      { id: "c", universe: 1, start: 12, footprint: 9 }, // [12,20]
      { id: "d", universe: 1, start: 18, footprint: 8 }, // [18,25]
    ]);
    expect(engine.getGroups()).toEqual([
      { universe: 1, minStart: 1, ids: ["a", "b", "c", "d"] },
    ]);
    const t = engine.trialMove("b", 2, 1)!;
    expect(t.canCommit).toBe(true);
    engine.commit("b", 2, 1);
    // 桥被移走：a 孤立，c/d 仍成组
    expect(engine.getGroups()).toEqual([{ universe: 1, minStart: 12, ids: ["c", "d"] }]);
    expect(engine.getFixture("b")).toEqual({ id: "b", universe: 2, start: 1, footprint: 11 });
  });

  it("提交后原 universe 清空则整组消失", () => {
    const engine = new PatchEngine([
      { id: "a", universe: 1, start: 1, footprint: 4 },
      { id: "b", universe: 1, start: 2, footprint: 4 },
    ]);
    engine.commit("a", 9, 100);
    engine.commit("b", 9, 200);
    expect(engine.getGroups()).toEqual([]);
  });

  it("非法目标返回 null", () => {
    const engine = new PatchEngine([{ id: "a", universe: 1, start: 1, footprint: 4 }]);
    expect(engine.trialMove("a", 0, 1)).toBeNull();
    expect(engine.trialMove("a", 32_769, 1)).toBeNull();
    expect(engine.trialMove("a", 1, 0)).toBeNull();
    expect(engine.trialMove("a", 1, 513)).toBeNull();
    expect(engine.trialMove("a", 1, 510)).toBeNull(); // 510+4 > 513
    expect(engine.trialMove("a", 1.5, 1)).toBeNull();
    expect(engine.trialMove("ghost", 1, 1)).toBeNull();
    expect(engine.trialMove("a", 1, 509)).not.toBeNull(); // 509+4 = 513 合法
  });

  it("试移与提交在随机操作序列下与朴素预言机一致", () => {
    const rand = mulberry32(987_654_321);
    for (let round = 0; round < 40; round++) {
      const patch = randomPatch(rand, 40, 3, 32);
      const engine = new PatchEngine(patch);
      const state = patch.map((f) => ({ ...f }));
      for (let step = 0; step < 100; step++) {
        const f = state[Math.floor(rand() * state.length)];
        const universe = 1 + Math.floor(rand() * 4);
        const start = 1 + Math.floor(rand() * (513 - f.footprint));
        const trial = engine.trialMove(f.id, universe, start)!;
        expect(trial.origin).toEqual(naiveHits(state, f.id, f.universe, f.start, f.footprint));
        expect(trial.target).toEqual(naiveHits(state, f.id, universe, start, f.footprint));
        expect(trial.canCommit).toBe(trial.target.length === 0);
        const before = engine.exportFixtures();
        engine.commit(f.id, universe, start);
        if (trial.canCommit) {
          f.universe = universe;
          f.start = start;
        } else {
          expect(engine.exportFixtures()).toEqual(before); // 补丁不变
        }
        expect(engine.getGroups()).toEqual(naiveGroups(state));
      }
    }
  });
});
