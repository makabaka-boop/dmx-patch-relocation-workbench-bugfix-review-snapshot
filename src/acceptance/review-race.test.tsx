// @vitest-environment happy-dom
/**
 * 验收：候选修订文件的异步读取与工程状态变更（试调提交、基线重导入、候选重选）
 * 交错时的时效性。
 *
 * 通过 mock Blob.prototype.text 控制两份候选文件的完成顺序，并在读取期间插入
 * 试调提交与基线重导入，逐次核对：
 * - 屏幕上的候选预览、冲突清单与下载导出始终对应当前选中文件与当前基线修订；
 * - 迟到的读取（含失败）一律丢弃：不得覆盖当前结论、不得恢复旧结论、
 *   不得在新工程上留下过期审核；
 * - 失败读取不产生可下载的旧方案；候选切换期间不短暂恢复上一份可提交结论；
 * - 正常顺序选择与既有界面行为保持兼容。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import App from "../App";
import { Fixture, parsePatch } from "../lib/dmx";

/* ---------------------------------------------------------------------- */
/* 验收补丁                                                                */
/* ---------------------------------------------------------------------- */

/** 基线工程：A1[1,4] 与 A2[4,7] 端点相接成组；B1 孤立。 */
const BASE: Fixture[] = [
  { id: "A1", universe: 1, start: 1, footprint: 4 },
  { id: "A2", universe: 1, start: 4, footprint: 4 },
  { id: "B1", universe: 2, start: 10, footprint: 4 },
];

/** 候选甲：仅 A1 → u3（采纳集 {A1}，与乙可区分）。 */
const CAND_A: Fixture[] = [
  { id: "A1", universe: 3, start: 1, footprint: 4 },
  { id: "A2", universe: 1, start: 4, footprint: 4 },
  { id: "B1", universe: 2, start: 10, footprint: 4 },
];

/** 候选乙：仅 A2 → u4（采纳集 {A2}）。 */
const CAND_B: Fixture[] = [
  { id: "A1", universe: 1, start: 1, footprint: 4 },
  { id: "A2", universe: 4, start: 4, footprint: 4 },
  { id: "B1", universe: 2, start: 10, footprint: 4 },
];

/** 候选丙：仅 B1 → u7；A2 仍是“试调前”的旧占用 u1[4,7]。 */
const CAND_C: Fixture[] = [
  { id: "A1", universe: 1, start: 1, footprint: 4 },
  { id: "A2", universe: 1, start: 4, footprint: 4 },
  { id: "B1", universe: 7, start: 10, footprint: 4 },
];

/** 第二份基线（重新导入用）：完全不同的工程。 */
const BASE2: Fixture[] = [
  { id: "C1", universe: 1, start: 1, footprint: 2 },
  { id: "C2", universe: 1, start: 2, footprint: 2 },
];

/** 乙与当前基线的合并结果（A2 → u4，其余不动）。 */
const MERGED_B: Fixture[] = [
  { id: "A1", universe: 1, start: 1, footprint: 4 },
  { id: "A2", universe: 4, start: 4, footprint: 4 },
  { id: "B1", universe: 2, start: 10, footprint: 4 },
];

/* ---------------------------------------------------------------------- */
/* 可控的文件读取：按文件名登记 DeferredRead，未登记的文件走真实 text()      */
/* （基线导入、下载回读不受影响）。                                         */
/* ---------------------------------------------------------------------- */

interface DeferredRead {
  promise: Promise<string>;
  resolve: (text: string) => void;
  reject: (err: unknown) => void;
}

function deferred(): DeferredRead {
  let resolve!: (text: string) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<string>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const pendingReads = new Map<string, DeferredRead[]>();
let realText: typeof Blob.prototype.text;

beforeEach(() => {
  pendingReads.clear();
  realText = Blob.prototype.text;
  vi.spyOn(Blob.prototype, "text").mockImplementation(function (this: Blob) {
    const name = (this as Partial<File>).name;
    const queue = name === undefined ? undefined : pendingReads.get(name);
    if (queue && queue.length > 0) return queue.shift()!.promise;
    return realText.call(this);
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  cleanup();
});

/** 登记一次受控读取并生成同名文件（文件内容无关紧要，text() 已被接管）。 */
function controlledFile(name: string): { file: File; read: DeferredRead } {
  const read = deferred();
  const queue = pendingReads.get(name) ?? [];
  queue.push(read);
  pendingReads.set(name, queue);
  return { file: new File(["<controlled>"], name, { type: "application/json" }), read };
}

async function resolveRead(read: DeferredRead, text: string) {
  await act(async () => {
    read.resolve(text);
    await read.promise;
  });
}

async function rejectRead(read: DeferredRead, err: unknown) {
  await act(async () => {
    read.reject(err);
    await read.promise.then(
      () => undefined,
      () => undefined,
    );
  });
}

/* ---------------------------------------------------------------------- */
/* 界面辅助                                                                */
/* ---------------------------------------------------------------------- */

type View = ReturnType<typeof render>;

function jsonFile(patch: unknown, name: string): File {
  return new File([JSON.stringify(patch)], name, { type: "application/json" });
}

function fileInputs(container: HTMLElement): HTMLInputElement[] {
  return [...container.querySelectorAll('input[type="file"]')] as HTMLInputElement[];
}

/** 导入基线（真实读取，立即完成）并等待导入横幅。 */
async function importBaseline(view: View, patch: Fixture[], name: string) {
  await userEvent.upload(fileInputs(view.container)[0], jsonFile(patch, name));
  await view.findByText(new RegExp(`已导入 ${patch.length} 具灯具`));
}

/** 选择候选文件：读取受控挂起，返回其 DeferredRead。 */
async function selectCandidate(view: View, name: string): Promise<DeferredRead> {
  const { file, read } = controlledFile(name);
  await userEvent.upload(fileInputs(view.container)[1], file);
  return read;
}

function reviewSection(container: HTMLElement): HTMLElement {
  return container.querySelector("section.review") as HTMLElement;
}

/** 复核区当前展示的采纳 id 列表（无结论时为空数组）。 */
function adoptedIds(container: HTMLElement): string[] {
  return [...reviewSection(container).querySelectorAll("[data-adopted-id]")].map(
    (li) => li.getAttribute("data-adopted-id")!,
  );
}

function downloadButton(view: View): HTMLButtonElement {
  return view.getByRole("button", { name: "下载合并结果 JSON" }) as HTMLButtonElement;
}

/** 冲突组面板中全部 chip 的 data-id（按 DOM 顺序）。 */
function groupChipIds(container: HTMLElement): string[][] {
  return [...container.querySelectorAll("ol.group-list li.group")].map((li) =>
    [...li.querySelectorAll(".chip")].map((b) => b.getAttribute("data-id")!),
  );
}

/** 点击下载并回读导出的 JSON。 */
async function downloadJson(view: View): Promise<Fixture[]> {
  const blobs: Blob[] = [];
  vi.stubGlobal("URL", {
    createObjectURL: (b: Blob) => {
      blobs.push(b);
      return "blob:mock";
    },
    revokeObjectURL: () => undefined,
  });
  try {
    fireEvent.click(downloadButton(view));
  } finally {
    vi.unstubAllGlobals();
  }
  expect(blobs).toHaveLength(1);
  const parsed = parsePatch(JSON.parse(await blobs[0].text()));
  expect(parsed).not.toBeNull();
  return parsed!;
}

/** 从冲突组选中灯具并提交一次试移到空闲位置。 */
async function commitMove(view: View, id: string, universe: string, start: string) {
  const { container } = view;
  const chip = [...container.querySelectorAll(".group .chip")].find(
    (el) => el.getAttribute("data-id") === id,
  ) as HTMLElement;
  fireEvent.click(chip);
  const [uniInput, startInput] = [...container.querySelectorAll(".inputs input")] as HTMLInputElement[];
  await userEvent.clear(uniInput);
  await userEvent.type(uniInput, universe);
  await userEvent.clear(startInput);
  await userEvent.type(startInput, start);
  fireEvent.click(view.getByRole("button", { name: "试移" }));
  expect(container.textContent).toContain("目标位无冲突，可提交。");
  fireEvent.click(view.getByRole("button", { name: "提交移动" }));
  await within(container).findByText(/已提交/);
}

/* ---------------------------------------------------------------------- */
/* 候选读取乱序                                                            */
/* ---------------------------------------------------------------------- */

describe("验收：候选读取乱序完成时，预览与导出只对应当前选中文件", () => {
  it("乙先读完、甲最后读完：页面保持乙的预览与导出，甲的迟到结果被丢弃", async () => {
    const view = render(<App />);
    await importBaseline(view, BASE, "base.json");

    const readA = await selectCandidate(view, "cand-a.json");
    const readB = await selectCandidate(view, "cand-b.json");

    // 乙先读完：屏幕显示乙的结论（采纳 A2），下载可用
    await resolveRead(readB, JSON.stringify(CAND_B));
    expect(adoptedIds(view.container)).toEqual(["A2"]);
    expect(downloadButton(view).disabled).toBe(false);

    // 甲最后读完：不得覆盖乙的结论，也不产生错误横幅
    await resolveRead(readA, JSON.stringify(CAND_A));
    const review = reviewSection(view.container);
    expect(adoptedIds(view.container)).toEqual(["A2"]);
    expect(review.querySelector(".banner.error")).toBeNull();

    // 冲突清单仍是基线（复核不写回引擎）
    expect(groupChipIds(view.container)).toEqual([["A1", "A2"]]);

    // 导出为乙与当前基线的合并结果
    expect(await downloadJson(view)).toEqual(MERGED_B);
  });

  it("旧候选先读完而新候选仍在读取：不短暂显示旧结论", async () => {
    const view = render(<App />);
    await importBaseline(view, BASE, "base.json");

    const readA = await selectCandidate(view, "cand-a.json");
    const readB = await selectCandidate(view, "cand-b.json");

    // 甲先读完，但当前选中的是乙（仍在读取）：审核区保持空白，不显示甲
    await resolveRead(readA, JSON.stringify(CAND_A));
    const review = reviewSection(view.container);
    expect(review.querySelector("[data-adopted-id]")).toBeNull();
    expect(downloadButton(view).disabled).toBe(true);
    expect(within(review).getByText(/选择一份候选修订以开始复核/)).toBeTruthy();

    // 乙读完：显示乙的结论
    await resolveRead(readB, JSON.stringify(CAND_B));
    expect(adoptedIds(view.container)).toEqual(["A2"]);
    expect(downloadButton(view).disabled).toBe(false);
  });

  it("正常顺序选择保持兼容：甲先读完显示甲，再选乙后显示乙", async () => {
    const view = render(<App />);
    await importBaseline(view, BASE, "base.json");

    const readA = await selectCandidate(view, "cand-a.json");
    await resolveRead(readA, JSON.stringify(CAND_A));
    expect(adoptedIds(view.container)).toEqual(["A1"]);
    expect(downloadButton(view).disabled).toBe(false);

    // 切换候选：旧结论立即撤销、下载立即禁用，不短暂保留可提交结论
    const readB = await selectCandidate(view, "cand-b.json");
    const review = reviewSection(view.container);
    expect(review.querySelector("[data-adopted-id]")).toBeNull();
    expect(downloadButton(view).disabled).toBe(true);
    expect(within(review).getByText(/选择一份候选修订以开始复核/)).toBeTruthy();

    await resolveRead(readB, JSON.stringify(CAND_B));
    expect(adoptedIds(view.container)).toEqual(["A2"]);
    expect(await downloadJson(view)).toEqual(MERGED_B);
  });
});

/* ---------------------------------------------------------------------- */
/* 读取期间的工程变更                                                      */
/* ---------------------------------------------------------------------- */

describe("验收：读取期间的工程变更使迟到的候选读取失效", () => {
  it("读取期间提交试调：迟到读取不得把试调前的基线放回审核区", async () => {
    const view = render(<App />);
    await importBaseline(view, BASE, "base.json");
    expect(groupChipIds(view.container)).toEqual([["A1", "A2"]]);

    // 候选丙读取期间，把 A2 从 u1[4,7] 搬到 u5[100,103]
    const readC = await selectCandidate(view, "cand-c.json");
    await commitMove(view, "A2", "5", "100");

    // 冲突清单已按提交重算：u1 只剩 A1，无冲突组
    expect(view.container.textContent).toContain("冲突组（0）");
    expect(groupChipIds(view.container)).toEqual([]);

    // 迟到的读取完成：不得出现任何复核结论（其基线快照是试调前的）
    await resolveRead(readC, JSON.stringify(CAND_C));
    const review = reviewSection(view.container);
    expect(review.querySelector("[data-adopted-id]")).toBeNull();
    expect(review.querySelector(".review-table")).toBeNull();
    expect(review.querySelector(".banner.error")).toBeNull();
    expect(within(review).getByText(/选择一份候选修订以开始复核/)).toBeTruthy();
    expect(downloadButton(view).disabled).toBe(true);

    // 冲突清单保持提交后的状态，不被迟到读取改写
    expect(view.container.textContent).toContain("冲突组（0）");
    expect(groupChipIds(view.container)).toEqual([]);
  });

  it("提交试调后重新选择候选：复核与导出基于当前基线，不包含刚被搬离的旧占用", async () => {
    const view = render(<App />);
    await importBaseline(view, BASE, "base.json");
    await commitMove(view, "A2", "5", "100");

    // 提交后重新选择候选丙：复核必须针对当前基线（A2 已在 u5）
    const readC = await selectCandidate(view, "cand-c.json");
    await resolveRead(readC, JSON.stringify(CAND_C));

    // 候选丙里 A2 的旧位置 u1[4,7] 成为提案，但采纳它会与 A1 产生新冲突 ⇒ 拒绝；
    // B1 → u7 无新增冲突 ⇒ 采纳。
    const review = reviewSection(view.container);
    const banner = within(review).getByText(/共 2 项提案/);
    expect(banner.textContent).toContain("采纳 1 项");
    expect(banner.textContent).toContain("拒绝 1 项");
    expect(adoptedIds(view.container)).toEqual(["B1"]);
    const verdict = [...review.querySelectorAll(".review-table tbody tr")].map((r) => [
      r.querySelector(".id-select")!.getAttribute("data-id"),
      r.querySelector("td")!.textContent,
    ]);
    expect(verdict).toEqual([
      ["A2", "拒绝"],
      ["B1", "采纳"],
    ]);

    // 导出与当前工程一致：A2 保持已提交的 u5[100,103]，不回退到旧占用 u1[4,7]
    expect(await downloadJson(view)).toEqual([
      { id: "A1", universe: 1, start: 1, footprint: 4 },
      { id: "A2", universe: 5, start: 100, footprint: 4 },
      { id: "B1", universe: 7, start: 10, footprint: 4 },
    ]);
    // 不写回引擎：冲突清单仍是提交后的状态
    expect(view.container.textContent).toContain("冲突组（0）");
  });

  it("读取期间重新导入基线：旧候选不得在新工程上留下过期审核", async () => {
    const view = render(<App />);
    await importBaseline(view, BASE, "base.json");

    const readA = await selectCandidate(view, "cand-a.json");
    // 读取期间导入全新基线（真实读取，立即完成）
    await importBaseline(view, BASE2, "base2.json");
    expect(groupChipIds(view.container)).toEqual([["C1", "C2"]]);

    // 旧候选迟到完成：既无结论也无错误横幅，新工程保持干净
    await resolveRead(readA, JSON.stringify(CAND_A));
    const review = reviewSection(view.container);
    expect(review.querySelector("[data-adopted-id]")).toBeNull();
    expect(review.querySelector(".review-table")).toBeNull();
    expect(review.querySelector(".banner.error")).toBeNull();
    expect(within(review).getByText(/选择一份候选修订以开始复核/)).toBeTruthy();
    expect(downloadButton(view).disabled).toBe(true);

    // 冲突清单仍是新工程
    expect(groupChipIds(view.container)).toEqual([["C1", "C2"]]);
  });
});

/* ---------------------------------------------------------------------- */
/* 失败读取                                                                */
/* ---------------------------------------------------------------------- */

describe("验收：失败读取不产生可下载的旧方案", () => {
  it("候选读取失败（JSON 无法解析）：仅提示错误，审核区无可下载结论", async () => {
    const view = render(<App />);
    await importBaseline(view, BASE, "base.json");

    const broken = await selectCandidate(view, "broken.json");
    await resolveRead(broken, "this is not json");

    const review = reviewSection(view.container);
    expect(within(review).getByText(/候选补丁无法读取/)).toBeTruthy();
    expect(review.querySelector("[data-adopted-id]")).toBeNull();
    expect(review.querySelector(".review-table")).toBeNull();
    expect(downloadButton(view).disabled).toBe(true);
  });

  it("当前候选读取失败、旧候选迟到成功：旧方案不得恢复，错误保持", async () => {
    const view = render(<App />);
    await importBaseline(view, BASE, "base.json");

    const readA = await selectCandidate(view, "cand-a.json");
    const readB = await selectCandidate(view, "cand-b.json");

    // 当前选择（乙）读取失败：审核区清空，仅剩错误
    await rejectRead(readB, new Error("disk read error"));
    const review = reviewSection(view.container);
    expect(within(review).getByText(/候选补丁无法读取/)).toBeTruthy();
    expect(review.querySelector("[data-adopted-id]")).toBeNull();
    expect(downloadButton(view).disabled).toBe(true);

    // 旧候选（甲）迟到且内容有效：不得把旧方案放回审核区，错误保持
    await resolveRead(readA, JSON.stringify(CAND_A));
    expect(review.querySelector("[data-adopted-id]")).toBeNull();
    expect(within(review).getByText(/候选补丁无法读取/)).toBeTruthy();
    expect(downloadButton(view).disabled).toBe(true);
  });
});
