import { describe, expect, it } from "vitest";
import { Fixture, PatchEngine, computeGroups } from "./dmx";

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

/**
 * 性能契约：20 万灯具全网核验 + 2000 次试移（含可提交时的提交与重算）
 * 须在 4 秒内完成，且试移命中（原位+目标位冲突列表长度之和）总数 ≤ 10000。
 * 生成器固定种子，灯具散布于 20000 个 universe，保证命中数确定性达标。
 */
describe("性能契约", () => {
  it(
    "200000 具灯具核验 + 2000 次试移 < 4s，命中总数 ≤ 10000",
    () => {
      const rand = mulberry32(20_260_919);
      const fixtures: Fixture[] = [];
      for (let i = 0; i < 200_000; i++) {
        const footprint = 1 + Math.floor(rand() * 16);
        const start = 1 + Math.floor(rand() * (513 - footprint));
        fixtures.push({
          id: `fx-${i.toString(36)}`,
          universe: 1 + Math.floor(rand() * 20_000),
          start,
          footprint,
        });
      }

      const t0 = performance.now();
      const engine = new PatchEngine(fixtures);
      const initialGroups = engine.getGroups();
      expect(initialGroups.length).toBeGreaterThan(0);

      let hits = 0;
      let commits = 0;
      for (let i = 0; i < 2000; i++) {
        const f = fixtures[Math.floor(rand() * fixtures.length)];
        const universe = 1 + Math.floor(rand() * 32_768);
        const start = 1 + Math.floor(rand() * (513 - f.footprint));
        const trial = engine.trialMove(f.id, universe, start);
        expect(trial).not.toBeNull();
        hits += trial!.origin.length + trial!.target.length;
        if (trial!.canCommit) {
          engine.commit(f.id, universe, start);
          commits += 1;
        }
      }
      const elapsed = performance.now() - t0;

      expect(hits).toBeLessThanOrEqual(10_000);
      expect(elapsed).toBeLessThan(4_000);
      // 增量提交后的分组必须与全量重算一致
      expect(engine.getGroups()).toEqual(computeGroups(engine.exportFixtures()));
      console.log(
        `perf: ${elapsed.toFixed(1)}ms, hits=${hits}, commits=${commits}, initialGroups=${initialGroups.length}`,
      );
    },
    30_000,
  );
});
