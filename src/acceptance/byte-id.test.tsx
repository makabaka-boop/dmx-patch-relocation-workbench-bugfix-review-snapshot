// @vitest-environment happy-dom
/**
 * 验收：含前导/尾随/连续/全空格以及逗号、引号的合法 id 在全部流程中保持
 * 逐字节身份。
 *
 * 覆盖：
 * - 引擎层：parsePatch 接受形近 id、UTF-8 字节序分组、试移/提交目标准确、
 *   复核采纳集合与下载 JSON 逐字节往返；
 * - 界面层（三个选择入口）：冲突组按钮、查找框（含全空格 id）、复核表格 id 按钮，
 *   分别核对选中对象、试移/提交目标、采纳集合与下载内容；
 * - 查找失败不得改变当前选择、试移结果或补丁。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import App from "../App";
import { Fixture, PatchEngine, compareUtf8, parsePatch } from "../lib/dmx";
import {
  buildMergedPatch,
  reviewCandidate,
  reviewFromText,
  serializePatch,
} from "../lib/review";

afterEach(() => cleanup());

/* ---------------------------------------------------------------------- */
/* 验收补丁：8 具灯具，universe 1、footprint 2、start 1..8，闭区间首尾相接 */
/* （[1,2]、[2,3]、…、[8,9]）构成单一 8 具冲突组。                        */
/* ---------------------------------------------------------------------- */

const TRICKY_IDS = ["   ", " A", "A", "A ", "A  B", "a, b", "a,b", 'c"d'] as const;

const SORTED_IDS = ["   ", " A", "A", "A ", "A  B", "a, b", "a,b", 'c"d'];

function trickyPatch(): Fixture[] {
  return TRICKY_IDS.map((id, i) => ({
    id,
    universe: 1,
    start: i + 1, // 1..8
    footprint: 2,
  }));
}

/** 全部平移到 universe 2、start 不变：旧冲突对原样保留，无新增 ⇒ 8 项全采纳。 */
function trickyCandidate(): Fixture[] {
  return TRICKY_IDS.map((id, i) => ({
    id,
    universe: 2,
    start: i + 1,
    footprint: 2,
  }));
}

function jsonFile(patch: unknown, name = "patch.json"): File {
  return new File([JSON.stringify(patch)], name, { type: "application/json" });
}

async function blobText(blob: Blob): Promise<string> {
  if (typeof blob.text === "function") return blob.text();
  return new Response(blob).text();
}

/* ======================= 引擎层：逐字节身份 ======================= */

describe("验收（引擎层）：形近合法 id 的字节身份", () => {
  it("parsePatch 接受全部形近 id 且互不重复；trim 折叠后才会重复", () => {
    const parsed = parsePatch(trickyPatch());
    expect(parsed).not.toBeNull();
    expect(parsed!.map((f) => f.id)).toEqual([...TRICKY_IDS]);
    // 32 位全空格也是合法 id
    expect(parsePatch([{ id: " ".repeat(32), universe: 1, start: 1, footprint: 1 }])).not.toBeNull();
    // 真正的字节重复（不是 trim 后重复）才拒绝
    expect(
      parsePatch([
        { id: "A", universe: 1, start: 1, footprint: 1 },
        { id: "A", universe: 1, start: 2, footprint: 1 },
      ]),
    ).toBeNull();
  });

  it("组内 id 严格按 UTF-8 字节序，空格（0x20）排在最前", () => {
    const engine = new PatchEngine(trickyPatch());
    const groups = engine.getGroups();
    expect(groups).toHaveLength(1);
    expect(groups[0]).toEqual({ universe: 1, minStart: 1, ids: SORTED_IDS });
  });

  it("试移与提交按精确 id 命中：全空格 id、尾随空格 id、引号 id 各自动作", () => {
    const engine = new PatchEngine(trickyPatch());

    // "   "（start 1 [1,2]）原位仅与 " A"（[2,3]）相接
    const t1 = engine.trialMove("   ", 1, 1)!;
    expect(t1.fixture.id).toBe("   ");
    expect(t1.origin).toEqual([" A"]);
    expect(engine.trialMove("   ", 5, 10)!.canCommit).toBe(true);
    // 用 trim 后的 id 找不到（引擎中不存在 "A"... 此处用不存在的形近串）
    expect(engine.trialMove("    ", 5, 10)).toBeNull(); // 4 空格 ≠ 3 空格
    engine.commit("   ", 5, 10);
    expect(engine.getFixture("   ")).toEqual({ id: "   ", universe: 5, start: 10, footprint: 2 });
    // 其余灯具原地不动
    expect(engine.getFixture(" A")!.start).toBe(2);

    // 尾随空格 id "A " 与 "A" 是两具灯具
    expect(engine.getFixture("A ")!.start).toBe(4);
    expect(engine.getFixture("A")!.start).toBe(3);
    engine.commit("A ", 6, 200);
    expect(engine.getFixture("A ")).toEqual({ id: "A ", universe: 6, start: 200, footprint: 2 });
    expect(engine.getFixture("A")!.universe).toBe(1);

    // 含引号 id
    const tq = engine.trialMove('c"d', 7, 1)!;
    expect(tq).not.toBeNull();
    expect(tq.target).toEqual([]);
    engine.commit('c"d', 7, 1);
    expect(engine.getFixture('c"d')).toEqual({ id: 'c"d', universe: 7, start: 1, footprint: 2 });

    // 含逗号 id 同理
    engine.commit("a,b", 8, 1);
    expect(engine.getFixture("a,b")!.universe).toBe(8);
  });

  it("复核：采纳集合为精确数组（逗号/引号/空格均不歧义），下载 JSON 逐字节往返", () => {
    const baseline = trickyPatch();
    const engine = new PatchEngine(baseline);
    const candidate = trickyCandidate();
    const result = reviewCandidate(baseline, candidate, engine);
    expect(result.error).toBeNull();
    if (result.error) return;
    const { resolution } = result;
    expect(resolution.proposals.map((p) => p.id)).toEqual(SORTED_IDS);
    expect(resolution.adoptedIds).toEqual(SORTED_IDS);
    expect(resolution.adoptedCount).toBe(8);

    const merged = buildMergedPatch(baseline, resolution);
    expect(merged.map((f) => f.id)).toEqual(SORTED_IDS);
    const text = serializePatch(merged);
    // 原始 JSON 文本：引号被转义、空格与逗号原样保留
    expect(text).toContain('"c\\"d"');
    expect(text).toContain('"a,b"');
    expect(text).toContain('"a, b"');
    expect(text).toContain('" A"');
    expect(text).toContain('"   "');
    // parsePatch 回读逐字一致
    const reparsed = parsePatch(JSON.parse(text));
    expect(reparsed).toEqual(merged);
    // 位置确实采纳了候选
    expect(reparsed!.find((f) => f.id === 'c"d')).toEqual({
      id: 'c"d',
      universe: 2,
      start: 8,
      footprint: 2,
    });
    // 不写回引擎
    expect(engine.getFixture('c"d')!.universe).toBe(1);
  });

  it("文本入口对含特殊 id 的候选同样逐字节一致（READ/求解失败语义不变）", () => {
    const baseline = trickyPatch();
    const engine = new PatchEngine(baseline);
    const r = reviewFromText(JSON.stringify(trickyCandidate()), baseline, engine);
    expect(r.error).toBeNull();
    if (!r.error) expect(r.resolution.adoptedIds).toEqual(SORTED_IDS);
    expect(reviewFromText("not json", baseline, engine)).toEqual({ error: "READ_FAILED" });
  });

  it("普通无空格 id 的排序与 JSON 格式保持兼容", () => {
    const patch: Fixture[] = [
      { id: "b", universe: 1, start: 1, footprint: 2 },
      { id: "A", universe: 1, start: 2, footprint: 2 },
      { id: "a", universe: 1, start: 3, footprint: 2 },
    ];
    const engine = new PatchEngine(patch);
    expect(engine.getGroups()[0].ids).toEqual(["A", "a", "b"]);
    expect(compareUtf8("A", "a")).toBeLessThan(0);
    expect(serializePatch(patch)).toBe(JSON.stringify(patch, null, 2));
  });
});

/* ======================= 界面层：三个入口 ======================= */

async function renderWithPatch(): Promise<ReturnType<typeof render>> {
  const view = render(<App />);
  const fileInput = view.container.querySelector(
    'input[type="file"]',
  ) as HTMLInputElement;
  await userEvent.upload(fileInput, jsonFile(trickyPatch()));
  // 导入成功横幅
  await view.findByText(/已导入 8 具灯具/);
  return view;
}

/** 冲突组面板中全部 chip 的 data-id（按 DOM 顺序）。 */
function groupChipIds(container: HTMLElement): string[][] {
  return [...container.querySelectorAll("ol.group-list li.group")].map((li) =>
    [...li.querySelectorAll(".chip")].map((b) => b.getAttribute("data-id")!),
  );
}

describe("验收（界面）：导入与形近 id 展示", () => {
  it("8 具形近 id 同属一组，chip 的文本与 data-id 均逐字节保留空格", async () => {
    const { container } = await renderWithPatch();
    expect(container.textContent).toContain("冲突组（1）");
    expect(groupChipIds(container)).toEqual([SORTED_IDS]);

    for (const id of ["   ", " A", "A", "A ", "A  B"]) {
      const chip = container.querySelector(`.chip[data-id=${cssEsc(id)}]`)!;
      expect(chip).toBeTruthy();
      // textContent 与原 id 完全相等（空格仍是空格，不被折叠/裁剪）
      const text = chip.querySelector(".id-text")!;
      expect(text.textContent).toBe(id);
      // 每个空格都可见：.id-space 数量 = 空格数
      expect(text.querySelectorAll(".id-space")).toHaveLength(
        [...id].filter((c) => c === " ").length,
      );
    }
    // 三个无空格/含逗号引号 id 仍可独立辨认
    expect(
      container.querySelector('.id-select, .chip[data-id=\'c"d\']') ||
        container.querySelector('.chip[data-id="a,b"]'),
    ).toBeTruthy();
  });
});

describe("验收（界面）：入口 1 — 冲突组按钮选择并提交", () => {
  it("点 “A” 的 chip：选中、试移、提交均落到 A，组被拆开", async () => {
    const { container, getByRole } = await renderWithPatch();

    fireEvent.click(byDataAttr(container, ".group .chip", "data-id", "A")!)
    expect(selectedIdOf(container)).toBe("A");

    // 原位直接冲突仅 " A" 与 "A "（形近但不同的灯具）；当前位置下目标位列表相同
    const trial = trialLists(container);
    expect(trial.origin).toEqual([" A", "A "]);
    expect(trial.target).toEqual([" A", "A "]);

    const [uniInput, startInput] = numericInputs(container);
    await userEvent.clear(uniInput);
    await userEvent.type(uniInput, "2");
    await userEvent.clear(startInput);
    await userEvent.type(startInput, "1");
    fireEvent.click(getByRole("button", { name: "试移" }));

    // 目标位无冲突方可提交
    expect(container.textContent).toContain("目标位无冲突，可提交。");
    fireEvent.click(getByRole("button", { name: "提交移动" }));

    // 提交成功横幅按字节显示 A
    const banner = await within(container).findByText(/已提交/);
    expect(banner.querySelector(".id-text")!.textContent).toBe("A");
    expect(banner.textContent).toContain("universe 2");

    // 组拆开：[1,2] 两具、[4,9] 五具；A 已离开 universe 1
    expect(groupChipIds(container)).toEqual([
      ["   ", " A"],
      ["A ", "A  B", "a, b", "a,b", 'c"d'],
    ]);
  });
});

describe("验收（界面）：入口 2 — 查找框逐字节匹配", () => {
  it("前导空格、全空格 id 均可精确选中，不被 trim", async () => {
    const { container, getByRole } = await renderWithPatch();
    const input = getByRole("textbox", { name: "按 id 查找灯具" }) as HTMLInputElement;

    await userEvent.clear(input);
    await userEvent.type(input, " A");
    fireEvent.click(getByRole("button", { name: "选择" }));
    expect(selectedIdOf(container)).toBe(" A");

    await userEvent.clear(input);
    await userEvent.type(input, "   "); // 全空格 id
    fireEvent.click(getByRole("button", { name: "选择" }));
    expect(selectedIdOf(container)).toBe("   ");
    // 输入框内容也未被改写
    expect(input.value).toBe("   ");

    // 回车同样逐字节提交
    await userEvent.clear(input);
    await userEvent.type(input, "a,b{enter}");
    expect(selectedIdOf(container)).toBe("a,b");
  });

  it("查找不存在的形近 id：选择、试移结果、补丁均不变，警告按字节显示", async () => {
    const { container, getByRole } = await renderWithPatch();

    // 先从冲突组选中 A 并产生试移
    fireEvent.click(byDataAttr(container, ".group .chip", "data-id", "A")!)
    expect(selectedIdOf(container)).toBe("A");
    expect(trialLists(container).origin).toEqual([" A", "A "]);

    const input = getByRole("textbox", { name: "按 id 查找灯具" }) as HTMLInputElement;
    await userEvent.clear(input);
    await userEvent.type(input, " A "); // 不存在：空格-A-空格
    fireEvent.click(getByRole("button", { name: "选择" }));

    // 警告横幅中的 id 逐字节保留
    const warn = container.querySelector(".banner.warn")!;
    expect(warn).toBeTruthy();
    const warnId = warn.querySelector(".id-text")!;
    expect(warnId.textContent).toBe(" A ");
    expect(warnId.getAttribute("data-id")).toBe(" A ");

    // 当前选择与试移未改变
    expect(selectedIdOf(container)).toBe("A");
    expect(trialLists(container).origin).toEqual([" A", "A "]);
    // 补丁未改变：详情仍是 universe 1 / start 3，冲突组仍 1 个
    expect(container.textContent).toContain("冲突组（1）");
    const fixtureText = container.querySelector("dl.fixture")!.textContent!;
    expect(fixtureText).toContain("universe");
    const dds = [...container.querySelectorAll("dl.fixture dd")].map((d) => d.textContent);
    expect(dds).toContain("1");
    expect(dds).toContain("3");

    // 空串（全空格 trim 后为空的等价场景）同样只是失败，不改状态
    await userEvent.clear(input);
    fireEvent.click(getByRole("button", { name: "选择" }));
    expect(selectedIdOf(container)).toBe("A");
    expect(trialLists(container).origin).toEqual([" A", "A "]);
  });
});

describe("验收（界面）：入口 3 — 复核表格 id 按钮、采纳集合与下载", () => {
  async function openReview(view: ReturnType<typeof render>) {
    const inputs = view.container.querySelectorAll('input[type="file"]');
    const reviewInput = inputs[1] as HTMLInputElement;
    await userEvent.upload(reviewInput, jsonFile(trickyCandidate(), "candidate.json"));
    await view.findByText(/采纳 8 项/);
  }

  it("采纳集合逐项可辨（逗号/引号 id 不与分隔符混淆），顺序为字节序", async () => {
    const view = await renderWithPatch();
    await openReview(view);
    const items = [...view.container.querySelectorAll("[data-adopted-id]")].map((li) => ({
      id: li.getAttribute("data-adopted-id"),
      text: li.querySelector(".id-text")!.textContent,
    }));
    expect(items.map((x) => x.id)).toEqual(SORTED_IDS);
    for (const x of items) expect(x.text).toBe(x.id);
    // 界面不再用 “逗号+空格” 拼接：采纳项是独立列表元素
    expect(view.container.querySelectorAll(".adopted-list li")).toHaveLength(8);
  });

  it("从复核表格点含引号 id：基线引擎选中该灯具，试移/提交目标准确", async () => {
    const view = await renderWithPatch();
    await openReview(view);
    const { container, getByRole } = view;

    const rowButton = byDataAttr(container, ".review-table .id-select", "data-id", 'c"d')!
    expect(rowButton).toBeTruthy();
    fireEvent.click(rowButton);
    expect(selectedIdOf(container)).toBe('c"d');

    // 复核不写回引擎：详情显示基线位置 u1 / start 8；原位仅与 "a,b" 相接
    const dds = [...container.querySelectorAll("dl.fixture dd")].map((d) => d.textContent);
    expect(dds).toContain("1");
    expect(dds).toContain("8");
    expect(trialLists(container).origin).toEqual(["a,b"]);

    // 提交该具（引号 id）到空闲位
    const [uniInput, startInput] = numericInputs(container);
    await userEvent.clear(uniInput);
    await userEvent.type(uniInput, "3");
    await userEvent.clear(startInput);
    await userEvent.type(startInput, "1");
    fireEvent.click(getByRole("button", { name: "试移" }));
    fireEvent.click(getByRole("button", { name: "提交移动" }));
    const banner = await within(container).findByText(/已提交/);
    expect(banner.querySelector(".id-text")!.textContent).toBe('c"d');
    // 原组少了 c"d：剩 7 具仍链式相接
    expect(groupChipIds(container)).toEqual([
      ["   ", " A", "A", "A ", "A  B", "a, b", "a,b"],
    ]);
  });

  it("下载 JSON 内容逐字节正确且不写回引擎", async () => {
    const view = await renderWithPatch();
    await openReview(view);

    const blobs: Blob[] = [];
    const create = vi.fn((b: Blob) => {
      blobs.push(b);
      return "blob:mock";
    });
    const revoke = vi.fn();
    vi.stubGlobal("URL", { createObjectURL: create, revokeObjectURL: revoke });
    try {
      fireEvent.click(view.getByRole("button", { name: "下载合并结果 JSON" }));
    } finally {
      vi.unstubAllGlobals();
    }
    expect(create).toHaveBeenCalledTimes(1);

    const text = await blobText(blobs[0]);
    // 特殊字符在 JSON 文本中的形态
    expect(text).toContain('"c\\"d"');
    expect(text).toContain('"a, b"');
    expect(text).toContain('"   "');
    const parsed = parsePatch(JSON.parse(text));
    expect(parsed).not.toBeNull();
    expect(parsed!.map((f) => f.id)).toEqual(SORTED_IDS); // 字节序
    const byId = new Map(parsed!.map((f) => [f.id, f]));
    TRICKY_IDS.forEach((id, i) => {
      expect(byId.get(id)).toEqual({ id, universe: 2, start: i + 1, footprint: 2 });
    });

    // 不写回引擎：冲突组面板仍是基线的 1 组 8 具
    expect(view.container.textContent).toContain("冲突组（1）");
    expect(groupChipIds(view.container)).toEqual([SORTED_IDS]);
  });
});

/* ------------------------------ 辅助查询 ------------------------------ */

function selectedIdOf(container: HTMLElement): string {
  return container.querySelector('[data-testid="selected-id"] .id-text')!.getAttribute("data-id")!;
}

/** 试移面板中原位/目标位两个列表各自的 chip data-id。 */
function trialLists(container: HTMLElement): { origin: string[]; target: string[] } {
  const blocks = [...container.querySelectorAll(".trial .lists > div")];
  const idsOf = (block: Element) =>
    [...block.querySelectorAll(".chip")].map((b) => b.getAttribute("data-id")!);
  return { origin: idsOf(blocks[0]), target: idsOf(blocks[1]) };
}

/** 用 getAttribute 逐元素匹配 data-*，避开属性选择器对引号等特殊字符的解析。 */
function byDataAttr(
  container: HTMLElement,
  tag: string,
  attr: string,
  value: string,
): HTMLElement | null {
  return (
    ([...container.querySelectorAll(tag)].find(
      (el) => el.getAttribute(attr) === value,
    ) as HTMLElement | undefined) ?? null
  );
}

function numericInputs(container: HTMLElement): HTMLInputElement[] {
  return [...container.querySelectorAll(".inputs input")] as HTMLInputElement[];
}

/** 生成可用于 querySelector 的属性选择器转义（id 仅含可打印 ASCII）。 */
function cssEsc(id: string): string {
  return JSON.stringify(id);
}
