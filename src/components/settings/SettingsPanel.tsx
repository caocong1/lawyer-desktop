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
  getLawLibraryStatus,
  reindexLawLibrary,
  setSyncSettings,
  getSyncStatus,
  flushFeedbackOutbox,
  testSyncConnection,
} from "../../services/api";
import type {
  LawLibraryStatus,
  LlmProvider,
  McpServerHealth,
  ProviderPreset,
  SkillMetadata,
  SyncSettings,
} from "../../services/api";
import { useSettings } from "../../stores/settings";
import "./SettingsPanel.css";

export interface SettingsPanelProps {
  onClose: () => void;
  onSaved?: (message: string) => void;
}

export function SettingsPanel(props: SettingsPanelProps) {
  const [activeTab, setActiveTab] = createSignal<
    "provider" | "skills" | "sync" | "files" | "mcp" | "about"
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
  const [mcpHealth, setMcpHealth] = createSignal<McpServerHealth[]>([]);
  const [mcpChecking, setMcpChecking] = createSignal(false);
  const [lawLibrary, setLawLibrary] = createSignal<LawLibraryStatus | null>(null);
  const [lawLibraryMessage, setLawLibraryMessage] = createSignal<string | null>(null);
  const [reindexing, setReindexing] = createSignal(false);
  const [allowedDirs, setAllowedDirs] = createSignal<string[]>([]);
  const [dirsLoading, setDirsLoading] = createSignal(false);
  const [dirsSaving, setDirsSaving] = createSignal(false);
  const [dirsMessage, setDirsMessage] = createSignal<string | null>(null);
  const [syncSettings, setSyncSettingsState] = createSignal<SyncSettings | null>(null);
  const [syncBaseUrl, setSyncBaseUrl] = createSignal("");
  const [syncApiKey, setSyncApiKey] = createSignal("");
  const [syncUploadEnabled, setSyncUploadEnabled] = createSignal(true);
  const [syncUploadFull, setSyncUploadFull] = createSignal(false);
  const [syncSkillsChannel, setSyncSkillsChannel] = createSignal("stable");
  const [syncAppChannel, setSyncAppChannel] = createSignal("stable");
  const [syncPending, setSyncPending] = createSignal(0);
  const [syncSaving, setSyncSaving] = createSignal(false);
  const [syncMessage, setSyncMessage] = createSignal<string | null>(null);

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

    await refreshDataSources();

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

    void refreshSyncStatus();
  });

  async function refreshDataSources() {
    setMcpChecking(true);
    try {
      setMcpHealth(await getMcpHealth());
    } catch {
      setMcpHealth([]);
    } finally {
      setMcpChecking(false);
    }
    try {
      setLawLibrary(await getLawLibraryStatus());
      setLawLibraryMessage(null);
    } catch (e) {
      setLawLibrary(null);
      setLawLibraryMessage(String(e));
    }
  }

  async function runReindex() {
    setReindexing(true);
    try {
      const stats = await reindexLawLibrary();
      setLawLibraryMessage(`重新索引完成：${stats.file_count} 个文件 / ${stats.chunk_count} 个条文块`);
      setLawLibrary(await getLawLibraryStatus());
    } catch (e) {
      setLawLibraryMessage(`重新索引失败：${String(e)}`);
    } finally {
      setReindexing(false);
    }
  }

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

  async function refreshSyncStatus() {
    try {
      const status = await getSyncStatus();
      setSyncSettingsState(status.settings);
      setSyncPending(status.pending_outbox);
      setSyncBaseUrl(status.settings.sync_base_url ?? "");
      setSyncUploadEnabled(status.settings.feedback_upload_enabled);
      setSyncUploadFull(status.settings.upload_full_answer);
      setSyncSkillsChannel(status.settings.skills_channel);
      setSyncAppChannel(status.settings.app_update_channel);
    } catch (e) {
      console.error("加载同步设置失败:", e);
    }
  }

  async function handleSaveSync() {
    setSyncSaving(true);
    setSyncMessage(null);
    try {
      await setSyncSettings({
        sync_base_url: syncBaseUrl().trim() || null,
        sync_api_key: syncApiKey().trim() || null,
        feedback_upload_enabled: syncUploadEnabled(),
        upload_full_answer: syncUploadFull(),
        skills_channel: syncSkillsChannel(),
        app_update_channel: syncAppChannel(),
      });
      setSyncApiKey("");
      await refreshSyncStatus();
      setSyncMessage("✅ 同步设置已保存");
      props.onSaved?.("同步设置已保存");
    } catch (e) {
      setSyncMessage(`❌ 保存失败: ${String(e)}`);
    } finally {
      setSyncSaving(false);
    }
  }

  async function handleTestSync() {
    setSyncMessage(null);
    try {
      await testSyncConnection();
      setSyncMessage("✅ 同步服务连接正常");
    } catch (e) {
      setSyncMessage(`❌ 连接失败: ${String(e)}`);
    }
  }

  async function handleFlushOutbox() {
    setSyncMessage(null);
    try {
      const n = await flushFeedbackOutbox();
      await refreshSyncStatus();
      setSyncMessage(n > 0 ? `✅ 已上报 ${n} 条反馈` : "暂无待同步反馈");
    } catch (e) {
      setSyncMessage(`❌ 同步失败: ${String(e)}`);
    }
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
            class={`tab ${activeTab() === "sync" ? "active" : ""}`}
            onClick={() => {
              setActiveTab("sync");
              void refreshSyncStatus();
            }}
          >
            同步
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
            数据源
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
              <p class="skills-count">
                已加载 {skillsCount()} 个技能
                <Show when={syncSettings()?.skills_version}>
                  {" "}
                  · 包版本 {syncSettings()?.skills_version}
                </Show>
              </p>
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

          <Show when={activeTab() === "sync"}>
            <p class="skill-desc">
              反馈将先入本地队列，联网后自动上报同步服务。默认仅上传回答摘要，不上传案情全文。
            </p>
            <div class="form-group">
              <label>同步服务地址</label>
              <input
                type="text"
                value={syncBaseUrl()}
                onInput={(e) => setSyncBaseUrl(e.currentTarget.value)}
                placeholder="http://127.0.0.1:8787"
              />
            </div>
            <div class="form-group">
              <label>API Key（可选）</label>
              <input
                type="password"
                value={syncApiKey()}
                onInput={(e) => setSyncApiKey(e.currentTarget.value)}
                placeholder={syncSettings()?.has_api_key ? "已保存，留空则不修改" : "Bearer token"}
              />
            </div>
            <div class="form-group">
              <label>
                <input
                  type="checkbox"
                  checked={syncUploadEnabled()}
                  onChange={(e) => setSyncUploadEnabled(e.currentTarget.checked)}
                />
                启用反馈上报
              </label>
            </div>
            <div class="form-group">
              <label>
                <input
                  type="checkbox"
                  checked={syncUploadFull()}
                  onChange={(e) => setSyncUploadFull(e.currentTarget.checked)}
                />
                上传 AI 回答全文（含案情，需律所授权）
              </label>
            </div>
            <div class="form-group">
              <label>Skills 更新通道</label>
              <select
                value={syncSkillsChannel()}
                onChange={(e) => setSyncSkillsChannel(e.currentTarget.value)}
              >
                <option value="stable">stable</option>
                <option value="beta">beta</option>
              </select>
            </div>
            <Show when={syncSettings()?.device_id}>
              <p class="skill-desc">设备 ID：{syncSettings()?.device_id}</p>
            </Show>
            <p class="skills-count">待同步反馈：{syncPending()} 条</p>
            <div class="form-actions">
              <button type="button" class="btn-primary" disabled={syncSaving()} onClick={() => void handleSaveSync()}>
                {syncSaving() ? "保存中…" : "保存同步设置"}
              </button>
              <button type="button" class="btn-secondary" onClick={() => void handleTestSync()}>
                测试连接
              </button>
              <button type="button" class="btn-secondary" onClick={() => void handleFlushOutbox()}>
                立即同步反馈
              </button>
            </div>
            <Show when={syncMessage()}>
              <div class="test-result">{syncMessage()}</div>
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
            <div class="ds-section-head">
              <p class="skills-count">在线检索连接器（MCP）</p>
              <button
                type="button"
                class="ds-refresh"
                disabled={mcpChecking()}
                onClick={() => void refreshDataSources()}
              >
                {mcpChecking() ? "检测中…" : "重新检测"}
              </button>
            </div>
            <div class="skills-list scroll">
              <For each={mcpHealth()}>
                {(server) => (
                  <div class="skill-item">
                    <strong>{server.name}</strong>
                    <span class="ds-tools">{server.online ? `${server.tool_count} 个工具` : ""}</span>
                    <span class={server.online ? "mcp-ok" : "mcp-off"}>
                      {server.online ? "在线" : "离线"}
                    </span>
                    <Show when={!server.online && server.error}>
                      <span class="ds-error" title={server.error ?? ""}>
                        {server.error}
                      </span>
                    </Show>
                  </div>
                )}
              </For>
            </div>
            <Show when={mcpHealth().length === 0}>
              <p class="skill-desc">未配置 MCP 服务器（.mcp.json），在线法规/案例检索不可用；本地法规库仍可用。</p>
            </Show>

            <div class="ds-section-head ds-lib-head">
              <p class="skills-count">本地法规库（离线核验基准）</p>
              <button
                type="button"
                class="ds-refresh"
                disabled={reindexing()}
                onClick={() => void runReindex()}
              >
                {reindexing() ? "索引中…" : "重新索引"}
              </button>
            </div>
            <Show
              when={lawLibrary()}
              fallback={<p class="skill-desc">{lawLibraryMessage() ?? "法规库尚未初始化"}</p>}
            >
              {(lib) => (
                <>
                  <p class="skill-desc">
                    已收录 {lib().law_count} 部法规 / {lib().article_count} 条；索引状态：
                    {lib().index_status?.status ?? "未知"}（{lib().index_status?.chunk_count ?? 0} 块）
                    <br />
                    {lib().root_path}
                  </p>
                  <div class="skills-list scroll ds-lib-list">
                    <For each={lib().laws}>
                      {(law) => (
                        <div class="skill-item">
                          <strong>{law.name}</strong>
                          <span class="ds-tools">
                            {law.article_count ?? "?"} 条 · {law.status ?? "时效未知"} ·{" "}
                            {law.text_verification ?? "待核验"}
                          </span>
                        </div>
                      )}
                    </For>
                  </div>
                </>
              )}
            </Show>
            <Show when={lawLibraryMessage() && lawLibrary()}>
              <p class="test-result">{lawLibraryMessage()}</p>
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
