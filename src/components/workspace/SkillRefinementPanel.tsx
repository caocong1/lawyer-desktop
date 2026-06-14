import {
  For,
  Show,
  createEffect,
  createSignal,
  onCleanup,
  onMount,
} from "solid-js";
import {
  adoptProposal,
  getSkilloptOverview,
  getSkilloptSettings,
  listAllFeedback,
  listEvalCases,
  listProposals,
  mineEvalCases,
  onSkillOptProgress,
  rejectProposal,
  runEvalCase,
  runSkillRefinement,
  setEvalCaseActive,
  setSkilloptSettings,
  type SkillOptProgressEvent,
  type SkillOptSettings,
} from "../../services/api";
import { Icon } from "../icons/Icons";
import "./SkillRefinementPanel.css";

export interface SkillRefinementPanelProps {
  open: boolean;
  onClose: () => void;
}

type Tab = "overview" | "feedback" | "cases" | "run" | "proposals" | "settings";

export function SkillRefinementPanel(props: SkillRefinementPanelProps) {
  const [tab, setTab] = createSignal<Tab>("overview");
  const [overview, setOverview] = createSignal<Awaited<ReturnType<typeof getSkilloptOverview>> | null>(null);
  const [feedback, setFeedback] = createSignal<Awaited<ReturnType<typeof listAllFeedback>>>([]);
  const [cases, setCases] = createSignal<Awaited<ReturnType<typeof listEvalCases>>>([]);
  const [proposals, setProposals] = createSignal<Awaited<ReturnType<typeof listProposals>>>([]);
  const [settings, setSettings] = createSignal<SkillOptSettings | null>(null);
  const [progress, setProgress] = createSignal<SkillOptProgressEvent[]>([]);
  const [running, setRunning] = createSignal(false);
  const [error, setError] = createSignal("");
  const [dryRun, setDryRun] = createSignal(true);
  const [targetSkill, setTargetSkill] = createSignal("");

  const refresh = async () => {
    try {
      setOverview(await getSkilloptOverview());
      setFeedback(await listAllFeedback(200));
      setCases(await listEvalCases());
      setProposals(await listProposals("staged"));
      setSettings(await getSkilloptSettings());
    } catch (e) {
      setError(String(e));
    }
  };

  onMount(() => {
    void refresh();
    let unlisten: (() => void) | undefined;
    void onSkillOptProgress((ev) => {
      setProgress((prev) => [...prev.slice(-50), ev]);
    }).then((u) => {
      unlisten = u;
    });
    onCleanup(() => unlisten?.());
  });

  createEffect(() => {
    if (props.open) void refresh();
  });

  const handleRunRefinement = async () => {
    setRunning(true);
    setProgress([]);
    setError("");
    try {
      await runSkillRefinement({
        targetSkill: targetSkill().trim() || undefined,
        dryRun: dryRun(),
        rolloutsK: 2,
        nights: 1,
      });
      await refresh();
    } catch (e) {
      setError(String(e));
    } finally {
      setRunning(false);
    }
  };

  const handleRunCase = async (caseId: string) => {
    setRunning(true);
    setError("");
    try {
      const result = await runEvalCase(caseId);
      setProgress((p) => [
        ...p,
        {
          stage: "eval",
          message: `用例得分 ${result.run.score.toFixed(3)}`,
          progress: result.run.score,
        },
      ]);
      await refresh();
    } catch (e) {
      setError(String(e));
    } finally {
      setRunning(false);
    }
  };

  const saveSettings = async () => {
    const s = settings();
    if (!s) return;
    try {
      await setSkilloptSettings(s);
      await refresh();
    } catch (e) {
      setError(String(e));
    }
  };

  return (
    <Show when={props.open}>
      <div class="skill-refinement-overlay" onClick={props.onClose}>
        <div class="skill-refinement-panel" onClick={(e) => e.stopPropagation()}>
          <header class="srp-header">
            <h2>技能精炼（管理员）</h2>
            <button type="button" class="srp-close" title="关闭 (Ctrl+Shift+O)" onClick={props.onClose}>
              <Icon name="x" />
            </button>
          </header>

          <nav class="srp-tabs">
            <For each={[
              ["overview", "概览"],
              ["feedback", "反馈箱"],
              ["cases", "测试用例"],
              ["run", "优化运行"],
              ["proposals", "提案审阅"],
              ["settings", "设置"],
            ] as const}>
              {([id, label]) => (
                <button
                  type="button"
                  class={`srp-tab${tab() === id ? " active" : ""}`}
                  onClick={() => setTab(id)}
                >
                  {label}
                </button>
              )}
            </For>
          </nav>

          <Show when={error()}>
            <div class="srp-error">{error()}</div>
          </Show>

          <div class="srp-body">
            <Show when={tab() === "overview"}>
              <Show when={overview()} fallback={<p>加载中…</p>}>
                {(o) => (
                  <div class="srp-stats">
                    <div class="srp-stat">
                      <span class="srp-stat-num">{o().feedback_count}</span>
                      <span>条律师反馈</span>
                    </div>
                    <div class="srp-stat">
                      <span class="srp-stat-num">{o().eval_case_count}</span>
                      <span>个活跃用例</span>
                    </div>
                    <div class="srp-stat">
                      <span class="srp-stat-num">{o().staged_proposals}</span>
                      <span>待审提案</span>
                    </div>
                    <p class="srp-hint">
                      闸门：{o().settings.gate} · 自治：{o().settings.auto_adopt} ·
                      预算：{o().settings.budget_tokens} tokens
                    </p>
                  </div>
                )}
              </Show>
            </Show>

            <Show when={tab() === "feedback"}>
              <div class="srp-list">
                <For each={feedback()} fallback={<p class="srp-empty">暂无反馈</p>}>
                  {(fb) => (
                    <div class="srp-row">
                      <span class={`srp-badge ${fb.rating}`}>{fb.rating === "up" ? "👍" : "👎"}</span>
                      <span>{fb.skill_name ?? "—"}</span>
                      <span class="srp-muted">{fb.comment ?? ""}</span>
                      <span class="srp-muted">{fb.created_at.slice(0, 16)}</span>
                    </div>
                  )}
                </For>
              </div>
              <button type="button" class="srp-action" onClick={() => void mineEvalCases().then(refresh)}>
                从反馈沉淀用例
              </button>
            </Show>

            <Show when={tab() === "cases"}>
              <div class="srp-list">
                <For each={cases()} fallback={<p class="srp-empty">无用例</p>}>
                  {(c) => (
                    <div class="srp-row case">
                      <strong>{c.name}</strong>
                      <span class="srp-tag">{c.split}</span>
                      <span class="srp-muted">{c.target_skill ?? ""}</span>
                      <button
                        type="button"
                        class="srp-action small"
                        disabled={running()}
                        onClick={() => void handleRunCase(c.id)}
                      >
                        运行
                      </button>
                      <button
                        type="button"
                        class="srp-action small"
                        onClick={() =>
                          void setEvalCaseActive(c.id, !c.active).then(refresh)
                        }
                      >
                        {c.active ? "停用" : "启用"}
                      </button>
                    </div>
                  )}
                </For>
              </div>
            </Show>

            <Show when={tab() === "run"}>
              <div class="srp-form">
                <label>
                  目标技能（可选）
                  <input
                    type="text"
                    value={targetSkill()}
                    onInput={(e) => setTargetSkill(e.currentTarget.value)}
                    placeholder="如 matter-intake"
                  />
                </label>
                <label class="srp-check">
                  <input
                    type="checkbox"
                    checked={dryRun()}
                    onChange={(e) => setDryRun(e.currentTarget.checked)}
                  />
                  干跑（不写入提案文件）
                </label>
                <button
                  type="button"
                  class="srp-action primary"
                  disabled={running()}
                  onClick={() => void handleRunRefinement()}
                >
                  {running() ? "运行中…" : "启动技能精炼"}
                </button>
              </div>
              <div class="srp-log">
                <For each={progress()}>
                  {(p) => (
                    <div class="srp-log-line">
                      <span class="srp-tag">{p.stage}</span> {p.message}
                    </div>
                  )}
                </For>
              </div>
            </Show>

            <Show when={tab() === "proposals"}>
              <div class="srp-list proposals">
                <For each={proposals()} fallback={<p class="srp-empty">无待审提案</p>}>
                  {(p) => (
                    <div class="srp-proposal">
                      <div class="srp-row">
                        <strong>{p.target_path.split(/[/\\]/).pop()}</strong>
                        <span>
                          val {p.val_before?.toFixed(2) ?? "?"} → {p.val_after?.toFixed(2) ?? "?"}
                        </span>
                      </div>
                      <p class="srp-muted">{p.rationale}</p>
                      <pre class="srp-diff">{p.diff.slice(0, 800)}{p.diff.length > 800 ? "…" : ""}</pre>
                      <div class="srp-row">
                        <button
                          type="button"
                          class="srp-action primary"
                          onClick={() => void adoptProposal(p.id).then(refresh)}
                        >
                          采纳
                        </button>
                        <button
                          type="button"
                          class="srp-action"
                          onClick={() => void rejectProposal(p.id).then(refresh)}
                        >
                          拒绝
                        </button>
                      </div>
                    </div>
                  )}
                </For>
              </div>
            </Show>

            <Show when={tab() === "settings"}>
              <Show when={settings()} fallback={<p>加载中…</p>}>
                {(s) => (
                  <div class="srp-form">
                    <label class="srp-check">
                      <input
                        type="checkbox"
                        checked={s().enabled}
                        onChange={(e) =>
                          setSettings({ ...s(), enabled: e.currentTarget.checked })
                        }
                      />
                      启用技能精炼
                    </label>
                    <label>
                      闸门
                      <select
                        value={s().gate}
                        onChange={(e) => setSettings({ ...s(), gate: e.currentTarget.value })}
                      >
                        <option value="on">开启（严格提分）</option>
                        <option value="off">关闭（贪婪）</option>
                      </select>
                    </label>
                    <label>
                      自治采纳
                      <select
                        value={s().auto_adopt}
                        onChange={(e) =>
                          setSettings({ ...s(), auto_adopt: e.currentTarget.value })
                        }
                      >
                        <option value="off">关闭</option>
                        <option value="low_risk">仅低风险</option>
                        <option value="all">全部过闸</option>
                      </select>
                    </label>
                    <label>
                      Token 预算
                      <input
                        type="number"
                        value={s().budget_tokens}
                        onInput={(e) =>
                          setSettings({
                            ...s(),
                            budget_tokens: Number(e.currentTarget.value) || 0,
                          })
                        }
                      />
                    </label>
                    <label>
                      评测数据根（每行一个路径）
                      <textarea
                        rows={4}
                        value={s().eval_data_roots.join("\n")}
                        onInput={(e) =>
                          setSettings({
                            ...s(),
                            eval_data_roots: e.currentTarget.value
                              .split("\n")
                              .map((x) => x.trim())
                              .filter(Boolean),
                          })
                        }
                      />
                    </label>
                    <button type="button" class="srp-action primary" onClick={() => void saveSettings()}>
                      保存设置
                    </button>
                  </div>
                )}
              </Show>
            </Show>
          </div>
        </div>
      </div>
    </Show>
  );
}
