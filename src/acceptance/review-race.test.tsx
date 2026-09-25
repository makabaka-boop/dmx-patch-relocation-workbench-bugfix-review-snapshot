// @vitest-environment happy-dom
/**
 * 验收：候选修订复核的异步读取竞态。
 *
 * 复核流程为「载入基线 → 选择候选文件 →（异步读取）→ 预览冲突裁决 → 下载合并
 * 补丁」。候选读取是异步的，读取期间界面仍在响应：可能又选择了新候选、提交了
 * 试移、或重新导入了基线。本文件用可控的 File/Blob 读取桩精确安排两份候选的
 * 完成顺序，并在读取挂起期间插入试移提交与基线重导入，逐次核对：
 *
 * - 屏幕上的候选结论（提案表、采纳列表）只对应**当前选中文件**与**当前基线
 *   修订**：乙先读完、甲后读完时，迟到的甲不得覆盖乙的预览与导出；
 * - 读取期间提交的试移不被迟到读取撤销或越过——旧候选完成不得把试移前的
 *   基线重新放进审核区（下载内容不得回到旧通道占用）；
 * - 读取期间重导基线，旧候选不得在新工程上留下过期审核；
 * - 失败读取（含迟到失败）不产生可下载的旧方案；
 * - 候选切换期间不短暂恢复上一份可提交结论；
 * - 正常顺序选择与既有行为保持兼容。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import App from "../App";
import { Fixture } from "../lib/dmx";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

/* ---------------------------------------------------------------------- */
/* 验收数据                                                                */
/* ---------------------------------------------------------------------- */

/** 基线：a/b/c 在 universe 1 首尾相接（[1,2]、[2,3]、[3,4]），单一冲突组。 */
const BASELINE: Fixture[] = [
  { id: "a", universe: 1, start: 1, footprint: 2 },
  { id: "b", universe: 1, start: 2, footprint: 2 },
  { id: "c", universe: 1, start: 3, footprint: 2 },
];

/** 候选甲：仅 a 搬到 universe 5 → 1 项提案，采纳 1。 */
const CANDIDATE_ALPHA: Fixture[] = [
  { id: "a", universe: 5, start: 1, footprint: 2 },
  { id: "b", universe: 1, start: 2, footprint: 2 },
  { id: "c", universe: 1, start: 3, footprint: 2 },
];

/** 候选乙：a/b/c 分别搬到 universe 5/6/7 → 3 项提案，全部采纳。 */
const CANDIDATE_BETA: Fixture[] = [
  { id: "a", universe: 5, start: 1, footprint: 2 },
  { id: "b", universe: 6, start: 2, footprint: 2 },
  { id: "c", universe: 7, start: 3, footprint: 2 },
];

/** 重导入的第二基线：x、y 同位冲突，与 a/b/c 完全不同的工程。 */
const BASELINE_2: Fixture[] = [
  { id: "x", universe: 1, start: 1, footprint: 1 },
  { id: "y", universe: 1, start: 1, footprint: 1 },
];

const ALPHA_TEXT = JSON.stringify(CANDIDATE_ALPHA);
const BETA_TEXT = JSON.stringify(CANDIDATE_BETA);

function jsonFile(patch: unknown, name: string): File {
  return new File([JSON.stringify(patch)], name, { type: "application/json" });
}

/* ---------------------------------------------------------------------- */
/* 可控文件读取桩：按文件名挂起，由测试显式决定完成（或失败）顺序            */
/* ---------------------------------------------------------------------- */

interface DeferredRead {
  resolve: (text: string) => void;
  reject: (err: unknown) => void;
}

function installControlledReads() {
  const queues = new Map<string, DeferredRead[]>();
  const original = Blob.prototype.text;
  vi.spyOn(Blob.prototype, "text").mockImplementation(function (this: Blob) {
    const name = (this as File).name;
    if (typeof name !== "string") {
      // 非 File 的 Blob（如下载产物）仍走原实现
      return original.call(this);
    }
    return new Promise<string>((resolve, reject) => {
      const q = queues.get(name) ?? [];
      q.push({ resolve, reject });
      queues.set(name, q);
    });
  });
  const take = (name: string): DeferredRead => {
    const q = queues.get(name);
    if (!q || q.length === 0) throw new Error(`没有挂起的读取：${name}`);
    return q.shift()!;
  };
  return {
    /** 让名为 name 的最早一次挂起读取成功完成，并冲刷界面更新。 */
    async resolveRead(name: string, text: string) {
      take(name).resolve(text);
      await flush();
    },
    /** 让名为 name 的最早一次挂起读取以原生读取失败收场，并冲刷界面更新。 */
    async rejectRead(name: string) {
      take(name).reject(new Error("模拟读取失败"));
      await flush();
    },
  };
}

let reads: ReturnType<typeof installControlledReads>;

beforeEach(() => {
  reads = installControlledReads();
});

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

/* ---------------------------------------------------------------------- */
/* 界面辅助                                                                */
/* ---------------------------------------------------------------------- */

type View = ReturnType<typeof render>;

function fileInputs(view: View): { importInput: HTMLInputElement; reviewInput: HTMLInputElement } {
  const inputs = view.container.querySelectorAll('input[type="file"]');
  return {
    importInput: inputs[0] as HTMLInputElement,
    reviewInput: inputs[1] as HTMLInputElement,
  };
}

/** 导入基线并等待导入横幅。 */
async function importBaseline(view: View, patch: Fixture[], name: string, count: number) {
  const { importInput } = fileInputs(view);
  await userEvent.upload(importInput, jsonFile(patch, name));
  await reads.resolveRead(name, JSON.stringify(patch));
  await view.findByText(new RegExp(`已导入 ${count} 具灯具`));
}

async function uploadCandidate(view: View, patch: Fixture[], name: string) {
  const { reviewInput } = fileInputs(view);
  await userEvent.upload(reviewInput, jsonFile(patch, name));
}

/** 冲突组面板中全部 chip 的 data-id（按 DOM 顺序）。 */
function groupChipIds(container: HTMLElement): string[][] {
  return [...container.querySelectorAll("ol.group-list li.group")].map((li) =>
    [...li.querySelectorAll(".chip")].map((b) => b.getAttribute("data-id")!),
  );
}

/** 复核结论中的采纳 id 列表（界面逐项展示的顺序）。 */
function adoptedIdsOf(container: HTMLElement): string[] {
  return [...container.querySelectorAll("[data-adopted-id]")].map(
    (el) => el.getAttribute("data-adopted-id")!,
  );
}

function downloadButton(view: View): HTMLButtonElement {
  return view.getByRole("button", { name: "下载合并结果 JSON" }) as HTMLButtonElement;
}

/** 复核结论横幅（共 N 项提案…）是否展示。 */
function reviewSummaryOf(container: HTMLElement): string | null {
  return container.querySelector(".review .banner.ok")?.textContent ?? null;
}

function reviewErrorOf(container: HTMLElement): string | null {
  return container.querySelector(".review .banner.error")?.textContent ?? null;
}

/** 点击下载按钮并返回解析后的 JSON；断言恰好产生一个下载 Blob。 */
async function downloadJson(view: View): Promise<unknown> {
  const blobs: Blob[] = [];
  const create = vi.fn((b: Blob) => {
    blobs.push(b);
    return "blob:mock";
  });
  vi.stubGlobal("URL", { createObjectURL: create, revokeObjectURL: vi.fn() });
  try {
    fireEvent.click(downloadButton(view));
  } finally {
    vi.unstubAllGlobals();
  }
  expect(blobs).toHaveLength(1);
  return JSON.parse(await blobs[0].text());
}

function chipById(container: HTMLElement, id: string): HTMLElement {
  const el = [...container.querySelectorAll(".group .chip")].find(
    (c) => c.getAttribute("data-id") === id,
  );
  if (!el) throw new Error(`未找到冲突组按钮：${id}`);
  return el as HTMLElement;
}

function numericInputs(container: HTMLElement): HTMLInputElement[] {
  return [...container.querySelectorAll(".inputs input")] as HTMLInputElement[];
}

const MERGED_ALPHA = [
  { id: "a", universe: 5, start: 1, footprint: 2 },
  { id: "b", universe: 1, start: 2, footprint: 2 },
  { id: "c", universe: 1, start: 3, footprint: 2 },
];

const MERGED_BETA = [
  { id: "a", universe: 5, start: 1, footprint: 2 },
  { id: "b", universe: 6, start: 2, footprint: 2 },
  { id: "c", universe: 7, start: 3, footprint: 2 },
];

/* ---------------------------------------------------------------------- */
/* 竞态验收                                                                */
/* ---------------------------------------------------------------------- */

describe("验收（复核竞态）：候选读取完成顺序", () => {
  it("连续选择甲、乙：乙先读完展示乙，甲迟到不得覆盖乙的预览与导出", async () => {
    const view = render(<App />);
    await importBaseline(view, BASELINE, "baseline.json", 3);

    await uploadCandidate(view, CANDIDATE_ALPHA, "alpha.json");
    await uploadCandidate(view, CANDIDATE_BETA, "beta.json");
    // 两份读取均挂起：审核区无任何结论、下载不可用
    expect(reviewSummaryOf(view.container)).toBeNull();
    expect(downloadButton(view).disabled).toBe(true);

    // 乙先读完：屏幕展示乙的结论（3 项提案全采纳）
    await reads.resolveRead("beta.json", BETA_TEXT);
    expect(reviewSummaryOf(view.container)).toContain("共 3 项提案：采纳 3 项、拒绝 0 项");
    expect(adoptedIdsOf(view.container)).toEqual(["a", "b", "c"]);
    expect(downloadButton(view).disabled).toBe(false);

    // 甲最后读完：不得重新显示甲的预览，乙的结论与导出保持不变
    await reads.resolveRead("alpha.json", ALPHA_TEXT);
    expect(reviewSummaryOf(view.container)).toContain("共 3 项提案：采纳 3 项、拒绝 0 项");
    expect(adoptedIdsOf(view.container)).toEqual(["a", "b", "c"]);
    expect(reviewErrorOf(view.container)).toBeNull();
    expect(downloadButton(view).disabled).toBe(false);

    // 导出仍是乙的合并结果；冲突清单仍是基线（复核不写回引擎）
    expect(await downloadJson(view)).toEqual(MERGED_BETA);
    expect(groupChipIds(view.container)).toEqual([["a", "b", "c"]]);
  });

  it("过期会话的迟到读取失败被忽略：不覆盖当前结论、不弹出失败横幅", async () => {
    const view = render(<App />);
    await importBaseline(view, BASELINE, "baseline.json", 3);

    await uploadCandidate(view, CANDIDATE_ALPHA, "alpha.json");
    await uploadCandidate(view, CANDIDATE_BETA, "beta.json");
    // 乙（当前候选）先成功
    await reads.resolveRead("beta.json", BETA_TEXT);
    expect(reviewSummaryOf(view.container)).toContain("共 3 项提案：采纳 3 项");

    // 甲（旧候选）迟到失败：界面保持乙的结论，无失败横幅，下载仍可用
    await reads.rejectRead("alpha.json");
    expect(reviewSummaryOf(view.container)).toContain("共 3 项提案：采纳 3 项");
    expect(adoptedIdsOf(view.container)).toEqual(["a", "b", "c"]);
    expect(reviewErrorOf(view.container)).toBeNull();
    expect(downloadButton(view).disabled).toBe(false);
    expect(await downloadJson(view)).toEqual(MERGED_BETA);
  });

  it("正常顺序保持兼容：依次选择甲、乙，结论随选择替换，导出对应当前候选", async () => {
    const view = render(<App />);
    await importBaseline(view, BASELINE, "baseline.json", 3);

    await uploadCandidate(view, CANDIDATE_ALPHA, "alpha.json");
    await reads.resolveRead("alpha.json", ALPHA_TEXT);
    expect(reviewSummaryOf(view.container)).toContain("共 1 项提案：采纳 1 项、拒绝 0 项");
    expect(adoptedIdsOf(view.container)).toEqual(["a"]);
    expect(await downloadJson(view)).toEqual(MERGED_ALPHA);

    // 正常重选乙：旧结论被替换为乙的结论
    await uploadCandidate(view, CANDIDATE_BETA, "beta.json");
    await reads.resolveRead("beta.json", BETA_TEXT);
    expect(reviewSummaryOf(view.container)).toContain("共 3 项提案：采纳 3 项、拒绝 0 项");
    expect(adoptedIdsOf(view.container)).toEqual(["a", "b", "c"]);
    expect(await downloadJson(view)).toEqual(MERGED_BETA);
  });
});

describe("验收（复核竞态）：读取期间的基线变更", () => {
  it("读取期间提交试移：迟到读取不得把试移前的基线重新放进审核区", async () => {
    const view = render(<App />);
    await importBaseline(view, BASELINE, "baseline.json", 3);

    // 选择候选甲，读取挂起
    await uploadCandidate(view, CANDIDATE_ALPHA, "alpha.json");
    expect(reviewSummaryOf(view.container)).toBeNull();

    // 读取期间提交一次试移：a → universe 2 起始 10
    fireEvent.click(chipById(view.container, "a"));
    const [uniInput, startInput] = numericInputs(view.container);
    await userEvent.clear(uniInput);
    await userEvent.type(uniInput, "2");
    await userEvent.clear(startInput);
    await userEvent.type(startInput, "10");
    fireEvent.click(view.getByRole("button", { name: "试移" }));
    fireEvent.click(view.getByRole("button", { name: "提交移动" }));
    await view.findByText(/已提交/);
    // 提交已生效：universe 1 只剩 b、c 的冲突组
    expect(groupChipIds(view.container)).toEqual([["b", "c"]]);

    // 甲的读取迟到完成：不得把试移前的基线重新放进审核区
    await reads.resolveRead("alpha.json", ALPHA_TEXT);
    expect(reviewSummaryOf(view.container)).toBeNull();
    expect(reviewErrorOf(view.container)).toBeNull();
    expect(adoptedIdsOf(view.container)).toEqual([]);
    expect(downloadButton(view).disabled).toBe(true);
    expect(view.container.textContent).toContain("选择一份候选修订以开始复核");
    // 已提交的试移不被撤销：冲突清单仍是提交后的状态
    expect(groupChipIds(view.container)).toEqual([["b", "c"]]);

    // 重新选择同一候选：复核针对的是提交后的当前基线修订
    await uploadCandidate(view, CANDIDATE_ALPHA, "alpha.json");
    await reads.resolveRead("alpha.json", ALPHA_TEXT);
    expect(reviewSummaryOf(view.container)).toContain("共 1 项提案：采纳 1 项、拒绝 0 项");
    const table = view.container.querySelector(".review-table")!.textContent!;
    expect(table).toContain("u2 · 10–11（fp 2）"); // 基线位置 = 试移提交后的位置
    expect(table).toContain("u5 · 1–2（fp 2）"); // 候选位置
    expect(groupChipIds(view.container)).toEqual([["b", "c"]]);
  });

  it("读取期间重导基线：旧候选不得在新工程上留下过期审核", async () => {
    const view = render(<App />);
    await importBaseline(view, BASELINE, "baseline.json", 3);

    // 选择候选甲，读取挂起（其基线快照属于旧工程）
    await uploadCandidate(view, CANDIDATE_ALPHA, "alpha.json");

    // 读取期间重导基线：换成 x/y 的全新工程
    await importBaseline(view, BASELINE_2, "baseline2.json", 2);
    expect(groupChipIds(view.container)).toEqual([["x", "y"]]);

    // 旧候选迟到完成：审核区保持空白，新工程不被过期审核污染
    await reads.resolveRead("alpha.json", ALPHA_TEXT);
    expect(reviewSummaryOf(view.container)).toBeNull();
    expect(reviewErrorOf(view.container)).toBeNull();
    expect(adoptedIdsOf(view.container)).toEqual([]);
    expect(downloadButton(view).disabled).toBe(true);
    expect(view.container.textContent).toContain("选择一份候选修订以开始复核");
    // 冲突清单与统计仍是新工程
    expect(groupChipIds(view.container)).toEqual([["x", "y"]]);
    expect(view.container.querySelector(".stats")!.textContent).toContain(
      "2 具灯具 · 1 个冲突组",
    );
  });
});

describe("验收（复核竞态）：失败读取与切换期间的可下载状态", () => {
  it("当前候选读取失败：不产生可下载的旧方案，切换期间不恢复旧结论", async () => {
    const view = render(<App />);
    await importBaseline(view, BASELINE, "baseline.json", 3);

    // 甲先成功：结论可下载
    await uploadCandidate(view, CANDIDATE_ALPHA, "alpha.json");
    await reads.resolveRead("alpha.json", ALPHA_TEXT);
    expect(reviewSummaryOf(view.container)).toContain("共 1 项提案：采纳 1 项");
    expect(downloadButton(view).disabled).toBe(false);

    // 切换到乙：读取挂起期间，上一份可提交结论立即撤销、不得短暂恢复
    await uploadCandidate(view, CANDIDATE_BETA, "beta.json");
    expect(reviewSummaryOf(view.container)).toBeNull();
    expect(adoptedIdsOf(view.container)).toEqual([]);
    expect(downloadButton(view).disabled).toBe(true);

    // 乙读取失败：展示失败，且甲的旧方案不被恢复、不可下载
    await reads.rejectRead("beta.json");
    expect(reviewErrorOf(view.container)).toContain("候选补丁无法读取");
    expect(reviewSummaryOf(view.container)).toBeNull();
    expect(adoptedIdsOf(view.container)).toEqual([]);
    expect(downloadButton(view).disabled).toBe(true);
  });

  it("当前候选失败、旧候选迟到成功：失败终态不被旧方案覆盖", async () => {
    const view = render(<App />);
    await importBaseline(view, BASELINE, "baseline.json", 3);

    await uploadCandidate(view, CANDIDATE_ALPHA, "alpha.json");
    await uploadCandidate(view, CANDIDATE_BETA, "beta.json");

    // 乙（当前候选）读到非法内容：READ_FAILED，候选清空
    await reads.resolveRead("beta.json", "{not json");
    expect(reviewErrorOf(view.container)).toContain("候选补丁无法读取");
    expect(downloadButton(view).disabled).toBe(true);

    // 甲（旧候选）迟到成功：不得把可下载的旧方案放回审核区
    await reads.resolveRead("alpha.json", ALPHA_TEXT);
    expect(reviewSummaryOf(view.container)).toBeNull();
    expect(adoptedIdsOf(view.container)).toEqual([]);
    expect(reviewErrorOf(view.container)).toContain("候选补丁无法读取");
    expect(downloadButton(view).disabled).toBe(true);
  });
});
