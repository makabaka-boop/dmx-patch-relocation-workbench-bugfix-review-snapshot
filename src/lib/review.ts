/**
 * 修订补丁复核（revision review）：
 *
 * 在不改动 PatchEngine 当前补丁（基线）的前提下，复核一份候选修订：
 *
 * 1. 候选必须经 parsePatch 解析成功，且 id 集与基线完全一致；
 * 2. 任一位置字段（universe/start/footprint）变化的灯具构成一项“不可拆分提案”——
 *    要么完整采用候选的新位置，要么保留基线旧位置，不能只取其中部分字段；
 * 3. 提案超过 24 项则整体拒绝；
 * 4. 合并结果可保留旧冲突对，但不得新增任何冲突对（冲突 ⟺ 同 universe 闭区间相交）；
 * 5. 精确求出最大采纳数；采纳数并列时，以 compareUtf8 排序后的采纳 id 列表做
 *    字典序决胜（取字典序最小者）。
 *
 * 约束构建只针对 ≤24 项提案：与不变灯具的关系通过只读位置索引
 * O(log n + 命中数) 定位，绝不对基线做全量两两扫描；提案间至多 24² 个单元格。
 * 求解用 DFS 分支限界（变量按 id 字典序、采纳优先），叶子访问顺序即采纳列表
 * 字典序，首个达到最大采纳数的解即决胜解。
 */

import { Fixture, compareUtf8, endOf, parsePatch } from "./dmx";

export const MAX_PROPOSALS = 24;

/** 复核拒绝原因；调用方须恢复基线展示并清空候选。 */
export type ReviewError =
  | "INVALID_PATCH" // parsePatch 解析失败
  | "ID_MISMATCH" // id 集与基线不一致（缺失/多余/重复）
  | "TOO_MANY_PROPOSALS"; // 位置变化的提案超过 24 项

/** 求解预算耗尽等内部失败；调用方同样按“恢复基线、清空候选”处理。 */
export class ReviewFailure extends Error {}

/** 文本入口的失败类别：读取失败（JSON 无法解析）/求解失败（含索引查询异常）。 */
export type ReviewInputError = ReviewError | "READ_FAILED" | "SOLVE_FAILED";

/** 只读位置索引：PatchEngine.conflictingIds 即满足该形状。 */
export interface PositionIndex {
  conflictingIds(
    universe: number,
    start: number,
    footprint: number,
    excludeId: string,
  ): string[];
}

export interface Proposal {
  id: string;
  baseline: Fixture;
  candidate: Fixture;
}

export interface ReviewedProposal extends Proposal {
  /** 采纳候选位置（true）或保留基线位置（false）。 */
  adopted: boolean;
}

export interface ReviewResolution {
  proposals: ReviewedProposal[];
  /** 按 compareUtf8 排序的采纳 id 列表（字典序决胜结果）。 */
  adoptedIds: string[];
  adoptedCount: number;
  rejectedCount: number;
}

interface Clauses {
  n: number;
  /** 必须为 0（保留基线）的变量掩码：候选新位置与不变灯具产生新冲突。 */
  unaryZero: number;
  /** nand[i]：与 i 不得同时为 1 的变量（(1,1) 单元格为新冲突）。 */
  nand: number[];
  /** implies[i]：i=1 ⇒ 对应位变量必须为 1（禁止 (1,0) 单元格）。 */
  implies: number[];
}

/** 两灯是否冲突：同 universe 且闭区间相交（端点相接即相交）。 */
function conflicts(a: Fixture, b: Fixture): boolean {
  return a.universe === b.universe && a.start <= endOf(b) && b.start <= endOf(a);
}

/** 最低位的下标。 */
function ctz(b: number): number {
  return 31 - Math.clz32(b);
}

/**
 * 解析并复核候选修订。校验失败返回 { error }；求解异常抛 ReviewFailure。
 * 本函数不修改 index，也不修改任何输入数组。
 */
export function reviewCandidate(
  baseline: Fixture[],
  rawCandidate: unknown,
  index: PositionIndex,
): { error: ReviewError; resolution?: undefined } | { error: null; resolution: ReviewResolution } {
  const parsed = parsePatch(rawCandidate);
  if (!parsed) return { error: "INVALID_PATCH" };

  const baseById = new Map<string, Fixture>();
  for (const f of baseline) baseById.set(f.id, f);
  const candById = new Map<string, Fixture>();
  for (const f of parsed) candById.set(f.id, f);
  if (candById.size !== baseById.size) return { error: "ID_MISMATCH" };
  for (const id of baseById.keys()) {
    if (!candById.has(id)) return { error: "ID_MISMATCH" };
  }
  for (const id of candById.keys()) {
    if (!baseById.has(id)) return { error: "ID_MISMATCH" };
  }

  const proposals: Proposal[] = [];
  for (const id of baseById.keys()) {
    const b = baseById.get(id)!;
    const c = candById.get(id)!;
    if (b.universe !== c.universe || b.start !== c.start || b.footprint !== c.footprint) {
      proposals.push({ id, baseline: { ...b }, candidate: { ...c } });
    }
  }
  if (proposals.length > MAX_PROPOSALS) return { error: "TOO_MANY_PROPOSALS" };
  proposals.sort((p, q) => compareUtf8(p.id, q.id));

  const adoptedMask = solve(buildClauses(proposals, baseById, index));

  const reviewed: ReviewedProposal[] = proposals.map((p, i) => ({
    ...p,
    adopted: ((adoptedMask >> i) & 1) === 1,
  }));
  const adoptedIds = reviewed.filter((p) => p.adopted).map((p) => p.id);
  return {
    error: null,
    resolution: {
      proposals: reviewed,
      adoptedIds,
      adoptedCount: adoptedIds.length,
      rejectedCount: reviewed.length - adoptedIds.length,
    },
  };
}

/**
 * 构建二元/一元约束。
 * - 与不变灯具的关系：对每个候选新位置做一次索引查询（O(log n + 命中)），
 *   绝不全量扫描基线；
 * - 提案两两关系：n≤24，至多 276 对，直接判定四个取值单元格。
 * 旧冲突对（基线即相交）在任何单元格都允许保留；只有“新冲突”单元格被禁。
 */
function buildClauses(
  proposals: Proposal[],
  baseById: Map<string, Fixture>,
  index: PositionIndex,
): Clauses {
  const n = proposals.length;
  const isProposal = new Set(proposals.map((p) => p.id));
  const nand = new Array<number>(n).fill(0);
  const implies = new Array<number>(n).fill(0);
  let unaryZero = 0;

  // 一元：候选新位置与“永不移动”的不变灯具相交，且基线并不相交 ⇒ 采纳即新增冲突。
  for (let i = 0; i < n; i++) {
    const { id, baseline: bf, candidate: cf } = proposals[i];
    const hits = index.conflictingIds(cf.universe, cf.start, cf.footprint, id);
    for (const h of hits) {
      if (isProposal.has(h)) continue; // 与提案的关系由下方成对单元格覆盖
      const hf = baseById.get(h)!;
      if (!conflicts(bf, hf)) {
        unaryZero |= 1 << i;
        break;
      }
    }
  }

  // 成对：枚举 (i,j) 的四个单元格 (i∈{0,1}) × (j∈{0,1})，0=保留基线，1=采纳。
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const bi = proposals[i].baseline;
      const bj = proposals[j].baseline;
      const old = conflicts(bi, bj);
      if (conflicts(proposals[i].candidate, proposals[j].candidate) && !old) {
        nand[i] |= 1 << j; // 禁 (1,1)
        nand[j] |= 1 << i;
      }
      if (conflicts(proposals[i].candidate, bj) && !old) {
        implies[i] |= 1 << j; // 禁 (1,0)：i=1 ⇒ j=1
      }
      if (conflicts(bi, proposals[j].candidate) && !old) {
        implies[j] |= 1 << i; // 禁 (0,1)：j=1 ⇒ i=1
      }
    }
  }

  return { n, unaryZero, nand, implies };
}

/**
 * 精确求解：最大化采纳数；并列取采纳 id 列表字典序最小。
 * 变量按下标（已按 compareUtf8 排序）递增决策、采纳（1）优先，
 * 合法叶子的访问顺序即采纳列表字典序；只在采纳数严格更优时更新答案，
 * 故首个达到最大采纳数的叶子即决胜解。分支限界上界 ≤ 当前最优即可剪枝
 * （等数分支在 DFS 序中必然更晚、字典序更大，剪掉不影响决胜）。
 */
function solve(clauses: Clauses): number {
  const { n, unaryZero, nand, implies } = clauses;
  const ALL = (1 << n) - 1;
  const NODE_BUDGET = 5_000_000;
  let nodes = 0;
  let bestOnes = 0;
  let bestMask = 0;

  // 反向蕴含：reverse[i] 中的 j 满足 j=1 ⇒ i=1，故 i=0 ⇒ j=0。
  const reverse = new Array<number>(n).fill(0);
  for (let i = 0; i < n; i++) {
    let m = implies[i];
    while (m) {
      const b = m & -m;
      reverse[ctz(b)] |= 1 << i;
      m ^= b;
    }
  }

  /** 固定值闭包传播；同一变量被同时要求 1 与 0 时返回 null。 */
  const propagate = (onesIn: number, zerosIn: number): { ones: number; zeros: number } | null => {
    let ones = onesIn;
    let zeros = zerosIn;
    for (;;) {
      if (ones & zeros) return null;
      let newOnes = 0;
      let m = ones;
      while (m) {
        const b = m & -m;
        newOnes |= implies[ctz(b)]; // 1 ⇒ 蕴含邻居 1
        m ^= b;
      }
      newOnes &= ~ones;
      if (newOnes & zeros) return null;
      let newZeros = 0;
      m = ones;
      while (m) {
        const b = m & -m;
        newZeros |= nand[ctz(b)]; // 1 ⇒ nand 邻居 0
        m ^= b;
      }
      m = zeros;
      while (m) {
        const b = m & -m;
        newZeros |= reverse[ctz(b)]; // 0 ⇒ 反向蕴含前驱 0
        m ^= b;
      }
      newZeros &= ~zeros;
      if (newZeros & ones) return null;
      if (newOnes === 0 && newZeros === 0) return { ones, zeros };
      ones |= newOnes;
      zeros |= newZeros;
    }
  };

  const dfs = (onesIn: number, zerosIn: number): void => {
    if (++nodes > NODE_BUDGET) throw new ReviewFailure("solver node budget exceeded");
    const fixed = onesIn | zerosIn;
    if (fixed === ALL) {
      const count = bitCount(onesIn);
      if (count > bestOnes) {
        bestOnes = count;
        bestMask = onesIn;
      }
      return;
    }
    // 上界 = 已采纳 + 剩余全部采纳；不能严格超过当前最优即剪枝。
    if (bitCount(onesIn) + n - bitCount(fixed) <= bestOnes) return;
    const b = (~fixed & ALL) & -(~fixed & ALL); // 最小未固定变量（字典序叶子顺序）
    const p1 = propagate(onesIn | b, zerosIn | (unaryZero & b)); // 先试采纳（一元禁取则立即为 0 → 冲突）
    if (p1) dfs(p1.ones, p1.zeros);
    const p0 = propagate(onesIn, zerosIn | b); // 再试保留基线
    if (p0) dfs(p0.ones, p0.zeros);
  };

  const init = propagate(0, unaryZero);
  if (!init) throw new ReviewFailure("initial propagation failed（全保留基线本应恒可行）");
  dfs(init.ones, init.zeros);
  return bestMask;
}

function bitCount(mask: number): number {
  let x = mask;
  x = x - ((x >>> 1) & 0x55555555);
  x = (x & 0x33333333) + ((x >>> 2) & 0x33333333);
  x = (x + (x >>> 4)) & 0x0f0f0f0f;
  return (x * 0x01010101) >>> 24;
}

/**
 * 按复核结论构造合并补丁（采纳项取候选位置，其余保留基线），
 * 按 compareUtf8 对 id 排序，返回全新数组，不触碰引擎。
 */
export function buildMergedPatch(baseline: Fixture[], resolution: ReviewResolution): Fixture[] {
  const adopted = new Map<string, Fixture>();
  for (const p of resolution.proposals) {
    if (p.adopted) adopted.set(p.id, { ...p.candidate });
  }
  return baseline
    .map((f) => {
      const c = adopted.get(f.id);
      return c ? { ...c } : { ...f };
    })
    .sort((a, b) => compareUtf8(a.id, b.id));
}

/** 下载用序列化：可读的 JSON 文本（UTF-8）。 */
export function serializePatch(patch: Fixture[]): string {
  return JSON.stringify(patch, null, 2);
}

/**
 * 文本入口：读取候选文件文本并复核。
 * JSON 解析失败 → READ_FAILED；校验失败 → 对应 ReviewError；
 * 求解（含索引查询）异常 → SOLVE_FAILED。任何失败都由调用方恢复基线、清空候选。
 */
export function reviewFromText(
  text: string,
  baseline: Fixture[],
  index: PositionIndex,
): { error: ReviewInputError } | { error: null; resolution: ReviewResolution } {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { error: "READ_FAILED" };
  }
  try {
    const result = reviewCandidate(baseline, raw, index);
    if (result.error) return { error: result.error };
    return { error: null, resolution: result.resolution };
  } catch {
    return { error: "SOLVE_FAILED" };
  }
}
