import { ChangeEvent, FormEvent, ReactNode, useRef, useState } from "react";
import {
  ConflictGroup,
  Fixture,
  INVALID_PATCH,
  MAX_CHANNEL,
  MAX_UNIVERSE,
  MIN_UNIVERSE,
  PatchEngine,
  TrialResult,
  endOf,
  parsePatch,
} from "./lib/dmx";
import {
  ReviewInputError,
  ReviewResolution,
  buildMergedPatch,
  reviewFromText,
  serializePatch,
} from "./lib/review";
import { IdText } from "./components/IdText";

interface Notice {
  kind: "ok" | "warn" | "error";
  // ReactNode：警告中嵌入逐字节渲染的 id（含空格/逗号/引号也不与正文混淆）
  text: ReactNode;
}

/** 确定性演示补丁：链式组、端点相接、嵌套、孤立灯具各若干。 */
function demoPatch(): Fixture[] {
  const fixtures: Fixture[] = [];
  let n = 0;
  const add = (universe: number, start: number, footprint: number) => {
    n += 1;
    fixtures.push({
      id: `demo-${String(n).padStart(3, "0")}`,
      universe,
      start,
      footprint,
    });
  };
  add(1, 1, 10); // [1,10]  ─┐
  add(1, 5, 11); // [5,15]   ├ 链式冲突组
  add(1, 12, 9); // [12,20] ─┘
  add(2, 10, 6); // [10,15] ─┐ 端点相接于 15
  add(2, 15, 5); // [15,19] ─┘
  add(3, 1, 512); // [1,512] ─┐
  add(3, 100, 100); // [100,199] ├ 嵌套冲突组
  add(3, 120, 20); // [120,139] ─┘
  add(4, 1, 1); // 孤立
  add(4, 100, 10); // 孤立
  add(5, 200, 50); // 孤立
  return fixtures;
}

/** 冲突 id 列表：每个 id 是一个选择入口；key/data-id 均为原始 id 字符串。 */
function IdList({ ids, onSelect }: { ids: string[]; onSelect: (id: string) => void }) {
  if (ids.length === 0) return <p className="muted">（空）</p>;
  return (
    <div className="chips">
      {ids.map((id) => (
        <button
          key={id}
          className="chip"
          onClick={() => onSelect(id)}
          data-id={id}
          title={id}
        >
          <IdText id={id} />
        </button>
      ))}
    </div>
  );
}

export default function App() {
  const [engine, setEngine] = useState<PatchEngine | null>(null);
  const [groups, setGroups] = useState<ConflictGroup[]>([]);
  const [fixtureCount, setFixtureCount] = useState(0);
  const [importError, setImportError] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [uniInput, setUniInput] = useState("1");
  const [startInput, setStartInput] = useState("1");
  const [trial, setTrial] = useState<TrialResult | null>(null);
  const [lookup, setLookup] = useState("");
  const [cap, setCap] = useState(200);

  // 修订补丁复核：结论、复核错误横幅、生成结果用的基线快照
  const [review, setReview] = useState<ReviewResolution | null>(null);
  const [reviewError, setReviewError] = useState<ReviewInputError | null>(null);
  const [reviewBaseline, setReviewBaseline] = useState<Fixture[]>([]);

  // 工程修订号：基线替换（导入/演示）、试调提交、候选或基线文件重选都会使其递增。
  // 文件读取是异步的；读取完成后仅当修订号未变——即结果仍对应当前选中文件与
  // 当前基线修订——才允许落地；迟到的读取（含失败）一律静默丢弃，绝不把过期
  // 预览、过期错误或过期基线快照写回界面。
  const revisionRef = useRef(0);

  const selected: Fixture | null =
    engine && selectedId ? engine.getFixture(selectedId) ?? null : null;

  function loadPatch(fixtures: Fixture[]) {
    // 基线整体替换：推进修订号，作废旧基线上一切未完成的文件读取
    revisionRef.current += 1;
    const eng = new PatchEngine(fixtures);
    const g = eng.getGroups();
    setEngine(eng);
    setGroups(g);
    setFixtureCount(eng.size);
    setImportError(null);
    setNotice({ kind: "ok", text: `已导入 ${eng.size} 具灯具，检出 ${g.length} 个冲突组。` });
    setSelectedId(null);
    setTrial(null);
    setLookup("");
    setCap(200);
    // 基线被整体替换：撤销任何既有复核结论与候选
    setReview(null);
    setReviewError(null);
    setReviewBaseline([]);
  }

  function failImport() {
    // 契约：非法补丁显示 INVALID_PATCH 并保留旧补丁（不清空 engine/groups）
    setImportError(INVALID_PATCH);
    setNotice(null);
  }

  async function onFile(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    // 连续选择基线文件时只有最后选择的有效；读取期间落地的其他工程变更
    // （试调提交、候选重选等）同样使本读取过期
    revisionRef.current += 1;
    const revision = revisionRef.current;
    let parsed: Fixture[] | null = null;
    try {
      parsed = parsePatch(JSON.parse(await file.text()));
    } catch {
      parsed = null;
    }
    // 迟到读取：已有更新的选择或工程变更，静默丢弃（含失败结果）
    if (revisionRef.current !== revision) return;
    if (!parsed) {
      failImport();
      return;
    }
    loadPatch(parsed);
  }

  function selectFixture(id: string) {
    if (!engine) return;
    const f = engine.getFixture(id);
    if (!f) {
      // 查找失败：只显示警告，绝不改变当前选择、试移结果与补丁
      setNotice({
        kind: "warn",
        text: (
          <>
            未找到灯具 “<IdText id={id} />”。
          </>
        ),
      });
      return;
    }
    setSelectedId(id);
    setUniInput(String(f.universe));
    setStartInput(String(f.start));
    // 选中即在当前位置试移一次，直接展示原位冲突
    setTrial(engine.trialMove(id, f.universe, f.start));
    setNotice(null);
  }

  /** 查找入口：逐字节使用输入框内容（不 trim、不折叠空白），全空格 id 同样可查。 */
  function submitLookup(e: FormEvent) {
    e.preventDefault();
    selectFixture(lookup);
  }

  function runTrial() {
    if (!engine || !selectedId) return;
    const r = engine.trialMove(selectedId, Number(uniInput), Number(startInput));
    if (!r) {
      setTrial(null);
      setNotice({
        kind: "error",
        text: `输入不合法：universe 须为 ${MIN_UNIVERSE}–${MAX_UNIVERSE} 的整数，start 须为 1–${MAX_CHANNEL} 的整数且 start+footprint ≤ 513。`,
      });
      return;
    }
    setTrial(r);
    setNotice(null);
  }

  function commitTrial() {
    if (!engine || !selectedId || !trial || !trial.canCommit) return;
    const r = engine.commit(selectedId, trial.targetUniverse, trial.targetStart);
    if (!r || !r.canCommit) {
      setNotice({ kind: "warn", text: "目标位存在冲突，提交被拒绝，补丁保持不变。" });
      return;
    }
    setGroups(engine.getGroups());
    setUniInput(String(r.targetUniverse));
    setStartInput(String(r.targetStart));
    setTrial(engine.trialMove(selectedId, r.targetUniverse, r.targetStart));
    // 引擎补丁被改写：旧复核结论针对的是旧基线快照，立即撤销；
    // 同时推进修订号——任何迟到的候选读取都不得把试调前的基线放回审核区
    revisionRef.current += 1;
    setReview(null);
    setReviewError(null);
    setReviewBaseline([]);
    setNotice({
      kind: "ok",
      text: (
        <>
          已提交：<IdText id={selectedId} /> → universe {r.targetUniverse} 起始{" "}
          {r.targetStart}，冲突组已重算。
        </>
      ),
    });
  }

  /** 复核失败文案；任一失败都恢复基线展示（引擎从未被写回）并清空候选。 */
  function reviewErrorText(err: ReviewInputError): string {
    switch (err) {
      case "READ_FAILED":
        return "候选补丁无法读取（JSON 解析失败）：已撤销结论、恢复基线，候选已清空。";
      case "INVALID_PATCH":
        return "候选补丁未通过 parsePatch 校验：已撤销结论、恢复基线，候选已清空。";
      case "ID_MISMATCH":
        return "候选补丁 id 集与基线不一致：已撤销结论、恢复基线，候选已清空。";
      case "TOO_MANY_PROPOSALS":
        return "位置变化的提案超过 24 项：候选被拒绝，已恢复基线并清空候选。";
      case "SOLVE_FAILED":
        return "复核求解失败：已撤销结论、恢复基线，候选已清空。";
    }
  }

  async function onReviewFile(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file || !engine) return;
    // 重新选择候选：立即撤销旧结论（含旧基线快照），并推进修订号，
    // 使此前任何候选的迟到读取（含失败）都不再落地
    revisionRef.current += 1;
    const revision = revisionRef.current;
    setReview(null);
    setReviewError(null);
    setReviewBaseline([]);
    const eng = engine;
    const baseline = eng.exportFixtures();
    let text: string;
    try {
      text = await file.text();
    } catch {
      // 读取失败：仅当本候选仍是当前选择时才报告；否则静默丢弃
      if (revisionRef.current === revision) setReviewError("READ_FAILED");
      return;
    }
    // 读取期间若发生候选重选、试调提交或基线重导入，修订号已变：
    // 本结果针对的是旧文件或旧基线，必须丢弃——不得覆盖当前结论，
    // 不得恢复旧结论，也不得在新工程上留下过期审核。
    if (revisionRef.current !== revision) return;
    const result = reviewFromText(text, baseline, eng);
    if (result.error) {
      // 校验/求解失败：恢复基线展示、清空候选
      setReviewError(result.error);
      return;
    }
    setReview(result.resolution);
    setReviewBaseline(baseline);
  }

  function downloadResult() {
    if (!review) return;
    const merged = buildMergedPatch(reviewBaseline, review);
    const blob = new Blob([serializePatch(merged)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "merged-patch.json";
    a.click();
    URL.revokeObjectURL(url);
    // 仅下载，不写回引擎
  }

  return (
    <div className="app">
      <header className="top">
        <h1>DMX 补丁冲突台</h1>
        <div className="actions">
          <label className="file-btn">
            导入 JSON 补丁
            <input type="file" accept="application/json,.json" onChange={onFile} hidden />
          </label>
          <button onClick={() => loadPatch(demoPatch())}>载入演示补丁</button>
        </div>
        <p className="stats">
          {engine
            ? `${fixtureCount} 具灯具 · ${groups.length} 个冲突组`
            : "空补丁台 — 请导入 1–200000 项的 JSON 数组"}
        </p>
      </header>

      {importError ? (
        <div className="banner error" role="alert">
          {importError} — 导入被拒绝，已保留旧补丁。
        </div>
      ) : null}
      {notice ? <div className={`banner ${notice.kind}`}>{notice.text}</div> : null}

      <main className="layout">
        <section className="panel">
          <h2>冲突组（{groups.length}）</h2>
          {groups.length === 0 ? (
            <p className="muted">{engine ? "无冲突。" : "尚未导入补丁。"}</p>
          ) : null}
          <ol className="group-list">
            {groups.slice(0, cap).map((g) => (
              <li key={`${g.universe}:${g.minStart}:${g.ids[0]}`} className="group">
                <header>
                  universe {g.universe} · 起始 {g.minStart} · {g.ids.length} 具
                </header>
                <div className="chips">
                  {g.ids.map((id) => (
                    <button
                      key={id}
                      className={id === selectedId ? "chip selected" : "chip"}
                      onClick={() => selectFixture(id)}
                      data-id={id}
                      title={id}
                    >
                      <IdText id={id} />
                    </button>
                  ))}
                </div>
              </li>
            ))}
          </ol>
          {groups.length > cap ? (
            <button className="more" onClick={() => setCap((c) => c * 5)}>
              显示更多（{Math.min(cap, groups.length)} / {groups.length}）
            </button>
          ) : null}
        </section>

        <section className="panel">
          <h2>试移灯具</h2>
          <form className="lookup" onSubmit={submitLookup}>
            <input
              value={lookup}
              onChange={(e) => setLookup(e.target.value)}
              placeholder="按 id 查找灯具（逐字节匹配，含首尾/连续空格）"
              aria-label="按 id 查找灯具"
              spellCheck={false}
            />
            <button type="submit" disabled={!engine}>
              选择
            </button>
          </form>
          {selected ? (
            <>
              <dl className="fixture">
                <div>
                  <dt>id</dt>
                  <dd data-testid="selected-id">
                    <IdText id={selected.id} />
                  </dd>
                </div>
                <div>
                  <dt>universe</dt>
                  <dd>{selected.universe}</dd>
                </div>
                <div>
                  <dt>start</dt>
                  <dd>{selected.start}</dd>
                </div>
                <div>
                  <dt>footprint</dt>
                  <dd>{selected.footprint}</dd>
                </div>
                <div>
                  <dt>占用区间</dt>
                  <dd>
                    [{selected.start}, {endOf(selected)}]
                  </dd>
                </div>
              </dl>
              <div className="inputs">
                <label>
                  新 universe（{MIN_UNIVERSE}–{MAX_UNIVERSE}）
                  <input
                    value={uniInput}
                    inputMode="numeric"
                    onChange={(e) => {
                      setUniInput(e.target.value);
                      setTrial(null);
                    }}
                  />
                </label>
                <label>
                  新 start（1–{MAX_CHANNEL + 1 - selected.footprint}）
                  <input
                    value={startInput}
                    inputMode="numeric"
                    onChange={(e) => {
                      setStartInput(e.target.value);
                      setTrial(null);
                    }}
                  />
                </label>
                <button onClick={runTrial}>试移</button>
              </div>
              {trial ? (
                <div className="trial">
                  <div className="lists">
                    <div>
                      <h3>原位直接冲突（{trial.origin.length}）</h3>
                      <IdList ids={trial.origin} onSelect={selectFixture} />
                    </div>
                    <div>
                      <h3>目标位直接冲突（{trial.target.length}）</h3>
                      <IdList ids={trial.target} onSelect={selectFixture} />
                    </div>
                  </div>
                  {trial.canCommit ? (
                    <>
                      <p className="ok-text">目标位无冲突，可提交。</p>
                      <button className="commit" onClick={commitTrial}>
                        提交移动
                      </button>
                    </>
                  ) : (
                    <p className="warn-text">
                      目标位被 {trial.target.length} 具灯具阻挡，提交已禁止，补丁保持不变。
                    </p>
                  )}
                </div>
              ) : (
                <p className="muted">调整目标后点击“试移”。</p>
              )}
            </>
          ) : (
            <p className="muted">
              {engine ? "从冲突组或查找框选择一具灯具。" : "请先导入补丁。"}
            </p>
          )}
        </section>
      </main>

      <section className="panel review">
        <h2>修订补丁复核</h2>
        <p className="muted review-rule">
          候选须经 parsePatch 解析且 id 集与基线一致；任一位置字段（universe/start/footprint）变化即一项
          <strong> 不可拆分提案</strong>，超过 24 项拒绝；每项只能整体采纳候选或保留基线。合并结果可保留旧冲突对、
          不得新增冲突对。精确求最大采纳数，并列时以 compareUtf8 排序的采纳 id 列表字典序决胜。
          下载结果不写回引擎。
        </p>
        <div className="actions">
          <label className="file-btn">
            选择候选修订 JSON
            <input
              type="file"
              accept="application/json,.json"
              onChange={onReviewFile}
              hidden
              disabled={!engine}
            />
          </label>
          <button onClick={downloadResult} disabled={!review}>
            下载合并结果 JSON
          </button>
        </div>
        {!engine ? <p className="muted">请先导入基线补丁。</p> : null}
        {reviewError ? (
          <div className="banner error" role="alert">
            {reviewErrorText(reviewError)}
          </div>
        ) : null}
        {review ? (
          <>
            <div className="banner ok">
              共 {review.proposals.length} 项提案：采纳 {review.adoptedCount} 项、拒绝{" "}
              {review.rejectedCount} 项（最大采纳数；采纳 id 列表字典序决胜）。
              {review.proposals.length === 0 ? "候选与基线完全相同，无提案。" : ""}
            </div>
            {review.proposals.length > 0 ? (
              <table className="review-table">
                <thead>
                  <tr>
                    <th>结论</th>
                    <th>id</th>
                    <th>基线位置</th>
                    <th>候选位置</th>
                  </tr>
                </thead>
                <tbody>
                  {review.proposals.map((p) => (
                    <tr key={p.id} className={p.adopted ? "row-adopt" : "row-reject"}>
                      <td className={p.adopted ? "ok-text" : "warn-text"}>
                        {p.adopted ? "采纳" : "拒绝"}
                      </td>
                      <td>
                        {/* 第三个选择入口：点击 id 即在基线引擎中选中该灯具 */}
                        <button
                          type="button"
                          className="id-select"
                          data-id={p.id}
                          title={p.id}
                          disabled={!engine}
                          onClick={() => selectFixture(p.id)}
                        >
                          <IdText id={p.id} />
                        </button>
                      </td>
                      <td>{formatPos(p.baseline)}</td>
                      <td>{formatPos(p.candidate)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <p className="muted">候选与基线位置完全一致，无需修订。</p>
            )}
            {/* 每个采纳 id 独立成项：id 自身含逗号/引号/空格时也不会与分隔符混淆 */}
            <div className="adopted">
              <span className="muted">采纳 id（compareUtf8 序）：</span>
              {review.adoptedIds.length > 0 ? (
                <ul className="adopted-list">
                  {review.adoptedIds.map((id) => (
                    <li key={id} data-adopted-id={id} title={id}>
                      <IdText id={id} />
                    </li>
                  ))}
                </ul>
              ) : (
                <span className="muted">（无）</span>
              )}
            </div>
          </>
        ) : reviewError ? null : (
          <p className="muted">选择一份候选修订以开始复核；重选任意补丁立即撤销当前结论。</p>
        )}
      </section>
    </div>
  );
}

/** 位置预览：u=universe, 区间 [start, start+footprint-1]。 */
function formatPos(f: Fixture): string {
  return `u${f.universe} · ${f.start}–${endOf(f)}（fp ${f.footprint}）`;
}
