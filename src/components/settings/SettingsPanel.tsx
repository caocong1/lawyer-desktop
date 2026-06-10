import { createSignal, onMount, For, Show } from "solid-js";
import {
  getProviderPresets,
  getActiveProvider,
  setupProvider,
  testProvider,
  getSkillsRoot,
  setSkillsRoot,
  listSkills,
  getMcpHealth,
} from "../../services/api";
import type { LlmProvider, ProviderPreset, SkillMetadata } from "../../services/api";
import { useSettings } from "../../stores/settings";
import "./SettingsPanel.css";

export interface SettingsPanelProps {
  onClose: () => void;
  onSaved?: (message: string) => void;
}

export function SettingsPanel(props: SettingsPanelProps) {
  const [activeTab, setActiveTab] = createSignal<"provider" | "skills" | "mcp" | "about">("provider");
  const [presets, setPresets] = createSignal<ProviderPreset[]>([]);
  const [selectedPreset, setSelectedPreset] = createSignal<string>("qwen");
  const [apiKey, setApiKey] = createSignal("");
  const [baseUrl, setBaseUrl] = createSignal("");
  const [modelName, setModelName] = createSignal("");
  const [testResult, setTestResult] = createSignal<string | null>(null);
  const [testing, setTesting] = createSignal(false);
  const [saving, setSaving] = createSignal(false);
  const [hasSavedApiKey, setHasSavedApiKey] = createSignal(false);
  const [skillsPath, setSkillsPath] = createSignal("");
  const [skills, setSkills] = createSignal<SkillMetadata[]>([]);
  const [skillsCount, setSkillsCount] = createSignal(0);
  const [mcpHealth, setMcpHealth] = createSignal<Record<string, boolean>>({});

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

  onMount(async () => {
    let presetList: ProviderPreset[] = [];
    try {
      presetList = await getProviderPresets();
      setPresets(presetList);
    } catch (e) {
      console.error("加载预设失败:", e);
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

        <div class="settings-content">
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
              <div class="skills-list">
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

          <Show when={activeTab() === "mcp"}>
            <p class="skills-count">法规数据库等 MCP 连接器状态</p>
            <div class="skills-list">
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
