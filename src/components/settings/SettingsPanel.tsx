import { createSignal, onMount, For, Show } from "solid-js";
import { open } from "@tauri-apps/plugin-dialog";
import {
  getProviderPresets,
  getFastModelPresets,
  getActiveProvider,
  getFastProvider,
  setupProvider,
  setupFastProvider,
  testProvider,
  testFastProvider,
  getSkillsRoot,
  setSkillsRoot,
  listSkills,
  getMcpHealth,
  getAllowedFileDirs,
  setAllowedFileDirs,
} from "../../services/api";
import type { LlmProvider, ProviderPreset, SkillMetadata } from "../../services/api";
import { useSettings } from "../../stores/settings";
import "./SettingsPanel.css";

export interface SettingsPanelProps {
  onClose: () => void;
  onSaved?: (message: string) => void;
}

export function SettingsPanel(props: SettingsPanelProps) {
  const [activeTab, setActiveTab] = createSignal<
    "provider" | "skills" | "files" | "mcp" | "about"
  >("provider");
  const [presets, setPresets] = createSignal<ProviderPreset[]>([]);
  const [selectedPreset, setSelectedPreset] = createSignal<string>("qwen");
  const [apiKey, setApiKey] = createSignal("");
  const [baseUrl, setBaseUrl] = createSignal("");
  const [modelName, setModelName] = createSignal("");
  const [testResult, setTestResult] = createSignal<string | null>(null);
  const [fastTestResult, setFastTestResult] = createSignal<string | null>(null);
  const [testing, setTesting] = createSignal(false);
  const [fastTesting, setFastTesting] = createSignal(false);
  const [saving, setSaving] = createSignal(false);
  const [fastSaving, setFastSaving] = createSignal(false);
  const [hasSavedApiKey, setHasSavedApiKey] = createSignal(false);
  const [fastEnabled, setFastEnabled] = createSignal(false);
  const [fastPreset, setFastPreset] = createSignal<string>("deepseek");
  const [fastBaseUrl, setFastBaseUrl] = createSignal("");
  const [fastModelName, setFastModelName] = createSignal("");
  const [fastApiKey, setFastApiKey] = createSignal("");
  const [fastHasSavedApiKey, setFastHasSavedApiKey] = createSignal(false);
  const [fastPresets, setFastPresets] = createSignal<ProviderPreset[]>([]);
  const [skillsPath, setSkillsPath] = createSignal("");
  const [skills, setSkills] = createSignal<SkillMetadata[]>([]);
  const [skillsCount, setSkillsCount] = createSignal(0);
  const [mcpHealth, setMcpHealth] = createSignal<Record<string, boolean>>({});
  const [allowedDirs, setAllowedDirs] = createSignal<string[]>([]);
  const [dirsLoading, setDirsLoading] = createSignal(false);
  const [dirsSaving, setDirsSaving] = createSignal(false);
  const [dirsMessage, setDirsMessage] = createSignal<string | null>(null);

  const { setIsConfigured, setActiveProvider } = useSettings();

  type SavedProvider = Pick<
    LlmProvider,
    "name" | "display_name" | "api_base_url" | "model_name" | "api_key"
  >;

  function resolvePresetSelection(saved: SavedProvider, presetList: ProviderPreset[]): string {
    if (saved.name === "custom") return "custom";
    const preset = presetList.find((p) => p.name === saved.name);
    if (!preset) return "custom";
    if (saved.api_base_url !== preset.api_base_url) return "custom";
    return saved.name;
  }

  async function resolveApiKeyForRequest(): Promise<string | undefined> {
    const entered = apiKey().trim();
    if (entered) return entered;
    if (!hasSavedApiKey()) return undefined;
    const saved = await getActiveProvider();
    return saved?.api_key;
  }

  function applySavedProvider(saved: SavedProvider, presetList: ProviderPreset[]) {
    const selection = resolvePresetSelection(saved, presetList);
    setSelectedPreset(selection);
    setBaseUrl(saved.api_base_url);
    setModelName(saved.model_name);
    setApiKey("");
    setHasSavedApiKey(Boolean(saved.api_key));
  }

  async function resolveFastApiKeyForRequest(): Promise<string | undefined> {
    const entered = fastApiKey().trim();
    return entered || undefined;
  }

  function selectFastPreset(name: string) {
    const preset = fastPresets().find((p) => p.name === name);
    if (preset) {
      setFastPreset(name);
      setFastBaseUrl(preset.api_base_url);
      setFastModelName(preset.default_model);
    } else if (name === "custom") {
      setFastPreset(name);
    }
    setFastApiKey("");
  }

  function fastProviderPayload(enabled: boolean) {
    const preset = fastPresets().find((p) => p.name === fastPreset());
    const displayName =
      fastPreset() === "custom" ? "快速模型" : (preset?.display_name ?? fastPreset());
    return {
      enabled,
      name: fastPreset(),
      display_name: displayName,
      api_base_url: fastBaseUrl(),
      model_name: fastModelName(),
    };
  }

  async function handleTestFast() {
    if (!fastModelName().trim()) {
      setFastTestResult("❌ 请填写快速模型名称");
      return;
    }
    if (fastPreset() === "custom" && !fastBaseUrl().trim()) {
      setFastTestResult("❌ 请填写 API Base URL");
      return;
    }
    setFastTesting(true);
    setFastTestResult(null);
    try {
      const result = await testFastProvider({
        ...fastProviderPayload(true),
        api_key: await resolveFastApiKeyForRequest(),
      });
      setFastTestResult(`✅ ${result}`);
    } catch (e) {
      setFastTestResult(`❌ ${String(e)}`);
    }
    setFastTesting(false);
  }

  async function handleSaveFast() {
    if (!fastEnabled()) {
      setFastSaving(true);
      setFastTestResult(null);
      try {
        await setupFastProvider({ ...fastProviderPayload(false), api_key: undefined });
        setFastTestResult("✅ 已关闭快速模型（路由将使用主模型）");
      } catch (e) {
        setFastTestResult(`❌ 保存失败: ${String(e)}`);
      } finally {
        setFastSaving(false);
      }
      return;
    }
    if (!fastModelName().trim()) {
      setFastTestResult("❌ 请填写快速模型名称");
      return;
    }
    if (fastPreset() === "custom" && !fastBaseUrl().trim()) {
      setFastTestResult("❌ 请填写 API Base URL");
      return;
    }
    setFastSaving(true);
    setFastTestResult(null);
    try {
      await setupFastProvider({
        ...fastProviderPayload(true),
        api_key: fastApiKey().trim() || undefined,
      });
      if (fastApiKey().trim()) setFastHasSavedApiKey(true);
      setFastApiKey("");
      setFastTestResult("✅ 快速模型已保存");
      props.onSaved?.("快速模型已保存");
    } catch (e) {
      setFastTestResult(`❌ 保存失败: ${String(e)}`);
    } finally {
      setFastSaving(false);
    }
  }

  onMount(async () => {
    let presetList: ProviderPreset[] = [];
    let fastPresetList: ProviderPreset[] = [];
    try {
      presetList = await getProviderPresets();
      setPresets(presetList);
      fastPresetList = await getFastModelPresets();
      setFastPresets(fastPresetList);
      if (fastPresetList.length > 0) {
        selectFastPreset(fastPresetList[0].name);
      }
    } catch (e) {
      console.error("加载预设失败:", e);
    }

    try {
      const savedFast = await getFastProvider();
      if (savedFast) {
        setFastEnabled(savedFast.enabled);
        setFastPreset(savedFast.name);
        setFastBaseUrl(savedFast.api_base_url);
        setFastModelName(savedFast.model_name);
        setFastHasSavedApiKey(savedFast.has_api_key);
      }
    } catch (e) {
      console.error("加载快速模型失败:", e);
    }

    try {
      const saved = await getActiveProvider();
      if (saved) {
        applySavedProvider(saved, presetList);
      } else if (presetList.length > 0) {
        selectPreset(presetList[0].name);
        setHasSavedApiKey(false);
      }
    } catch (e) {
      console.error("加载已保存配置失败:", e);
      if (presetList.length > 0) {
        selectPreset(presetList[0].name);
      }
    }

    try {
      setMcpHealth(await getMcpHealth());
    } catch {
      setMcpHealth({});
    }

    try {
      const root = await getSkillsRoot();
      if (root) {
        setSkillsPath(root);
        const loaded = await listSkills();
        setSkills(loaded);
        setSkillsCount(loaded.length);
      }
    } catch (e) {
      console.error("加载技能路径失败:", e);
    }

    try {
      setDirsLoading(true);
      setAllowedDirs(await getAllowedFileDirs());
    } catch (e) {
      console.error("加载允许目录失败:", e);
      setDirsMessage("无法加载目录列表，请确认后端命令已就绪");
    } finally {
      setDirsLoading(false);
    }
  });

  function selectPreset(name: string) {
    const preset = presets().find((p) => p.name === name);
    if (preset) {
      setSelectedPreset(name);
      setBaseUrl(preset.api_base_url);
      setModelName(preset.default_model);
    } else if (name === "custom") {
      setSelectedPreset(name);
    }
    setApiKey("");
    setHasSavedApiKey(false);
  }

  async function handleTest() {
    setTesting(true);
    setTestResult(null);
    try {
      const result = await testProvider({
        name: selectedPreset(),
        display_name: selectedPreset(),
        api_base_url: baseUrl(),
        api_key: await resolveApiKeyForRequest(),
        model_name: modelName(),
      });
      setTestResult(`✅ 连接成功: ${result}`);
    } catch (e) {
      setTestResult(`❌ 连接失败: ${String(e)}`);
    }
    setTesting(false);
  }

  async function handleSave() {
    if (!modelName().trim()) {
      setTestResult("❌ 请填写模型名称");
      return;
    }
    if (selectedPreset() === "custom" && !baseUrl().trim()) {
      setTestResult("❌ 请填写 API Base URL");
      return;
    }

    setSaving(true);
    setTestResult(null);
    try {
      const preset = presets().find((p) => p.name === selectedPreset());
      const displayName =
        selectedPreset() === "custom" ? "自定义" : (preset?.display_name ?? selectedPreset());

      const resolvedApiKey = await resolveApiKeyForRequest();
      await setupProvider({
        name: selectedPreset(),
        display_name: displayName,
        api_base_url: baseUrl(),
        api_key: resolvedApiKey,
        model_name: modelName(),
      });
      setIsConfigured(true);
      setActiveProvider({
        name: selectedPreset(),
        display_name: displayName,
        api_base_url: baseUrl(),
        api_key: resolvedApiKey,
        model_name: modelName(),
      });
      setHasSavedApiKey(Boolean(resolvedApiKey));
      setTestResult("✅ 已保存并启用");
      props.onSaved?.("模型配置已保存");
      props.onClose();
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      setTestResult(`❌ 保存失败: ${message}`);
      console.error("保存配置失败:", e);
    } finally {
      setSaving(false);
    }
  }

  async function handleSetSkillsRoot() {
    if (!skillsPath().trim()) return;
    try {
      const count = await setSkillsRoot(skillsPath());
      setSkillsCount(count);
      const loaded = await listSkills();
      setSkills(loaded);
    } catch (e) {
      console.error("加载技能失败:", e);
    }
  }

  async function persistAllowedDirs(dirs: string[]) {
    setDirsSaving(true);
    setDirsMessage(null);
    try {
      await setAllowedFileDirs(dirs);
      setAllowedDirs(dirs);
      setDirsMessage("✅ 已保存");
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      setDirsMessage(`❌ 保存失败: ${message}`);
      console.error("保存允许目录失败:", e);
    } finally {
      setDirsSaving(false);
    }
  }

  async function handleAddAllowedDir() {
    try {
      const selected = await open({ multiple: false, directory: true });
      if (!selected || Array.isArray(selected)) return;
      const dirs = allowedDirs();
      if (dirs.includes(selected)) {
        setDirsMessage("该目录已在列表中");
        return;
      }
      await persistAllowedDirs([...dirs, selected]);
    } catch (e) {
      console.error("选择目录失败:", e);
    }
  }

  async function handleRemoveAllowedDir(path: string) {
    await persistAllowedDirs(allowedDirs().filter((d) => d !== path));
  }

  return (
    <div class="settings-overlay" onClick={props.onClose}>
      <div class="settings-panel" onClick={(e) => e.stopPropagation()}>
        <div class="settings-header">
          <h2>设置</h2>
          <button type="button" class="close-btn" onClick={props.onClose}>
            ×
          </button>
        </div>

        <div class="settings-tabs">
          <button
            type="button"
            class={`tab ${activeTab() === "provider" ? "active" : ""}`}
            onClick={() => setActiveTab("provider")}
          >
            LLM 模型
          </button>
          <button
            type="button"
            class={`tab ${activeTab() === "skills" ? "active" : ""}`}
            onClick={() => setActiveTab("skills")}
          >
            法律技能
          </button>
          <button
            type="button"
            class={`tab ${activeTab() === "files" ? "active" : ""}`}
            onClick={() => setActiveTab("files")}
          >
            文件访问
          </button>
          <button
            type="button"
            class={`tab ${activeTab() === "mcp" ? "active" : ""}`}
            onClick={() => setActiveTab("mcp")}
          >
            MCP
          </button>
          <button
            type="button"
            class={`tab ${activeTab() === "about" ? "active" : ""}`}
            onClick={() => setActiveTab("about")}
          >
            关于
          </button>
        </div>

        <div class="settings-content scroll">
          <Show when={activeTab() === "provider"}>
            <div class="form-group">
              <label>模型服务商</label>
              <select
                value={selectedPreset()}
                onChange={(e) => selectPreset(e.currentTarget.value)}
              >
                <For each={presets()}>
                  {(preset) => <option value={preset.name}>{preset.display_name}</option>}
                </For>
                <option value="custom">自定义 (OpenAI 兼容)</option>
              </select>
            </div>

            <Show when={selectedPreset() === "custom"}>
              <div class="form-group">
                <label>API Base URL</label>
                <input
                  type="text"
                  value={baseUrl()}
                  onInput={(e) => setBaseUrl(e.currentTarget.value)}
                  placeholder="https://your-api.com/v1"
                />
              </div>
            </Show>

            <div class="form-group">
              <label>API Key</label>
              <input
                type="password"
                value={apiKey()}
                onInput={(e) => setApiKey(e.currentTarget.value)}
                placeholder={
                  hasSavedApiKey() ? "已保存，留空则不修改" : "输入 API Key"
                }
              />
            </div>

            <div class="form-group">
              <label>模型名称</label>
              <input
                type="text"
                value={modelName()}
                onInput={(e) => setModelName(e.currentTarget.value)}
                placeholder="如: qwen-plus, deepseek-chat"
              />
            </div>

            <div class="form-actions">
              <button type="button" class="btn-secondary" onClick={handleTest} disabled={testing()}>
                {testing() ? "测试中..." : "测试连接"}
              </button>
              <button
                type="button"
                class="btn-primary"
                onClick={handleSave}
                disabled={saving() || testing()}
              >
                {saving() ? "保存中..." : "保存并启用"}
              </button>
            </div>

            <Show when={testResult()}>
              <div class="test-result">{testResult()}</div>
            </Show>

            <hr class="settings-divider" />

            <h3 class="settings-subheading">快速模型（路由 / 轻量任务）</h3>
            <p class="skill-desc">
              用于意图分类、技能选择等低成本操作。留空 API Key 时可与主模型共用同一服务商 Key（需在主模型中已保存）。
              推荐如 deepseek-chat、qwen-turbo 等 Flash 档模型。
            </p>

            <div class="form-group form-group-toggle">
              <span class="toggle-label">启用快速模型</span>
              <button
                type="button"
                role="switch"
                class={`toggle-switch ${fastEnabled() ? "on" : ""}`}
                aria-checked={fastEnabled()}
                onClick={() => setFastEnabled((v) => !v)}
              >
                <span class="toggle-knob" />
              </button>
            </div>

            <div class={`fast-model-fields ${fastEnabled() ? "" : "disabled"}`}>
              <div class="form-group">
                <label>快速模型服务商</label>
                <select
                  value={fastPreset()}
                  disabled={!fastEnabled()}
                  onChange={(e) => selectFastPreset(e.currentTarget.value)}
                >
                  <For each={fastPresets()}>
                    {(preset) => <option value={preset.name}>{preset.display_name}</option>}
                  </For>
                  <option value="custom">自定义 (OpenAI 兼容)</option>
                </select>
              </div>

              <Show when={fastPreset() === "custom"}>
                <div class="form-group">
                  <label>API Base URL</label>
                  <input
                    type="text"
                    value={fastBaseUrl()}
                    disabled={!fastEnabled()}
                    onInput={(e) => setFastBaseUrl(e.currentTarget.value)}
                    placeholder="https://api.deepseek.com/v1"
                  />
                </div>
              </Show>

              <div class="form-group">
                <label>API Key（可选，留空则复用主模型 Key）</label>
                <input
                  type="password"
                  value={fastApiKey()}
                  disabled={!fastEnabled()}
                  onInput={(e) => setFastApiKey(e.currentTarget.value)}
                  placeholder={
                    fastHasSavedApiKey() ? "已保存，留空则不修改" : "可与主模型相同"
                  }
                />
              </div>

              <div class="form-group">
                <label>模型名称</label>
                <input
                  type="text"
                  value={fastModelName()}
                  disabled={!fastEnabled()}
                  onInput={(e) => setFastModelName(e.currentTarget.value)}
                  placeholder="如: deepseek-chat, qwen-turbo"
                />
              </div>
            </div>

            <div class="form-actions">
              <button
                type="button"
                class="btn-secondary"
                onClick={() => void handleTestFast()}
                disabled={fastTesting() || fastSaving() || !fastEnabled()}
              >
                {fastTesting() ? "测试中..." : "测试快速模型"}
              </button>
              <button
                type="button"
                class="btn-primary"
                onClick={() => void handleSaveFast()}
                disabled={fastSaving() || fastTesting()}
              >
                {fastSaving() ? "保存中..." : fastEnabled() ? "保存快速模型" : "保存（关闭快速模型）"}
              </button>
            </div>

            <Show when={fastTestResult()}>
              <div class="test-result">{fastTestResult()}</div>
            </Show>
          </Show>

          <Show when={activeTab() === "skills"}>
            <div class="form-group">
              <label>ai-for-china-legal 项目路径</label>
              <input
                type="text"
                value={skillsPath()}
                onInput={(e) => setSkillsPath(e.currentTarget.value)}
                placeholder="如: C:\Users\...\ai-for-china-legal"
              />
            </div>
            <button type="button" class="btn-primary" onClick={handleSetSkillsRoot}>
              加载技能
            </button>
            <Show when={skillsCount() > 0}>
              <p class="skills-count">已加载 {skillsCount()} 个技能</p>
              <div class="skills-list scroll">
                <For each={skills()}>
                  {(skill) => (
                    <div class="skill-item">
                      <strong>{skill.name}</strong>
                      <span class="skill-plugin">({skill.plugin_name})</span>
                      <p class="skill-desc">{skill.description}</p>
                    </div>
                  )}
                </For>
              </div>
            </Show>
          </Show>

          <Show when={activeTab() === "files"}>
            <p class="skill-desc">
              配置 AI 可读取的本地目录。聊天中附加的文件或文件夹必须位于以下目录内。
            </p>
            <Show when={dirsLoading()}>
              <p class="skills-count">加载中…</p>
            </Show>
            <Show when={!dirsLoading() && allowedDirs().length === 0}>
              <p class="skills-count">尚未添加允许目录</p>
            </Show>
            <div class="allowed-dirs-list scroll">
              <For each={allowedDirs()}>
                {(dir) => (
                  <div class="allowed-dir-item">
                    <span class="allowed-dir-path" title={dir}>
                      {dir}
                    </span>
                    <button
                      type="button"
                      class="btn-icon-remove"
                      aria-label="移除目录"
                      disabled={dirsSaving()}
                      onClick={() => void handleRemoveAllowedDir(dir)}
                    >
                      ×
                    </button>
                  </div>
                )}
              </For>
            </div>
            <div class="form-actions">
              <button
                type="button"
                class="btn-primary"
                onClick={() => void handleAddAllowedDir()}
                disabled={dirsSaving()}
              >
                {dirsSaving() ? "保存中…" : "添加目录"}
              </button>
            </div>
            <Show when={dirsMessage()}>
              <div class="test-result">{dirsMessage()}</div>
            </Show>
          </Show>

          <Show when={activeTab() === "mcp"}>
            <p class="skills-count">法规数据库等 MCP 连接器状态</p>
            <div class="skills-list scroll">
              <For each={Object.entries(mcpHealth())}>
                {([name, ok]) => (
                  <div class="skill-item">
                    <strong>{name}</strong>
                    <span class={ok ? "mcp-ok" : "mcp-off"}>{ok ? "在线" : "离线"}</span>
                  </div>
                )}
              </For>
            </div>
            <Show when={Object.keys(mcpHealth()).length === 0}>
              <p class="skill-desc">未配置 MCP 服务器，或 LAW_DB_API_KEY 未设置</p>
            </Show>
          </Show>

          <Show when={activeTab() === "about"}>
            <div class="about-content">
              <h3>墨律 Inkstatute</h3>
              <p>版本 0.1.0</p>
              <p>面向中国大陆执业律师的 AI 法律文书桌面助手</p>
              <p class="disclaimer">
                声明：本工具所有输出均为供律师审查的草稿，非法律建议，非法律结论，不能替代执业律师。
              </p>
            </div>
          </Show>
        </div>
      </div>
    </div>
  );
}
