import { Component, createSignal, onMount, For, Show } from "solid-js";
import {
  getProviderPresets,
  setupProvider,
  testProvider,
  setSkillsRoot,
  listSkills,
} from "../../services/api";
import type { ProviderPreset, SkillMetadata } from "../../services/api";
import { useSettings } from "../../stores/settings";
import "./SettingsPanel.css";

interface SettingsPanelProps {
  onClose: () => void;
}

const SettingsPanel: Component<SettingsPanelProps> = (props) => {
  const [activeTab, setActiveTab] = createSignal<"provider" | "skills" | "about">("provider");
  const [presets, setPresets] = createSignal<ProviderPreset[]>([]);
  const [selectedPreset, setSelectedPreset] = createSignal<string>("qwen");
  const [apiKey, setApiKey] = createSignal("");
  const [baseUrl, setBaseUrl] = createSignal("");
  const [modelName, setModelName] = createSignal("");
  const [testResult, setTestResult] = createSignal<string | null>(null);
  const [testing, setTesting] = createSignal(false);
  const [skillsPath, setSkillsPath] = createSignal("");
  const [skills, setSkills] = createSignal<SkillMetadata[]>([]);
  const [skillsCount, setSkillsCount] = createSignal(0);

  const { setIsConfigured, setActiveProvider } = useSettings();

  onMount(async () => {
    try {
      const p = await getProviderPresets();
      setPresets(p);
      if (p.length > 0) {
        selectPreset(p[0].name);
      }
    } catch (e) {
      console.error("Failed to load presets:", e);
    }
  });

  function selectPreset(name: string) {
    const preset = presets().find((p) => p.name === name);
    if (preset) {
      setSelectedPreset(name);
      setBaseUrl(preset.api_base_url);
      setModelName(preset.default_model);
    }
  }

  async function handleTest() {
    setTesting(true);
    setTestResult(null);
    try {
      const result = await testProvider({
        name: selectedPreset(),
        display_name: selectedPreset(),
        api_base_url: baseUrl(),
        api_key: apiKey() || undefined,
        model_name: modelName(),
      });
      setTestResult(`✅ 连接成功: ${result}`);
    } catch (e: any) {
      setTestResult(`❌ 连接失败: ${e}`);
    }
    setTesting(false);
  }

  async function handleSave() {
    try {
      await setupProvider({
        name: selectedPreset(),
        display_name: selectedPreset(),
        api_base_url: baseUrl(),
        api_key: apiKey() || undefined,
        model_name: modelName(),
      });
      setIsConfigured(true);
      setActiveProvider({
        name: selectedPreset(),
        display_name: selectedPreset(),
        api_base_url: baseUrl(),
        api_key: apiKey() || undefined,
        model_name: modelName(),
      });
    } catch (e) {
      console.error("Failed to save provider:", e);
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
      console.error("Failed to set skills root:", e);
    }
  }

  return (
    <div class="settings-overlay" onClick={props.onClose}>
      <div class="settings-panel" onClick={(e) => e.stopPropagation()}>
        <div class="settings-header">
          <h2>设置</h2>
          <button class="close-btn" onClick={props.onClose}>
            ×
          </button>
        </div>

        <div class="settings-tabs">
          <button
            class={`tab ${activeTab() === "provider" ? "active" : ""}`}
            onClick={() => setActiveTab("provider")}
          >
            LLM 模型
          </button>
          <button
            class={`tab ${activeTab() === "skills" ? "active" : ""}`}
            onClick={() => setActiveTab("skills")}
          >
            法律技能
          </button>
          <button
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
                  {(preset) => (
                    <option value={preset.name}>{preset.display_name}</option>
                  )}
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
                placeholder="输入 API Key"
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
              <button class="btn-secondary" onClick={handleTest} disabled={testing()}>
                {testing() ? "测试中..." : "测试连接"}
              </button>
              <button class="btn-primary" onClick={handleSave}>
                保存并启用
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
            <button class="btn-primary" onClick={handleSetSkillsRoot}>
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

          <Show when={activeTab() === "about"}>
            <div class="about-content">
              <h3>律师助手 (Lawyer Desktop)</h3>
              <p>版本 0.1.0</p>
              <p>面向中国大陆执业律师的 AI 桌面助手</p>
              <p class="disclaimer">
                声明：本工具所有输出均为供律师审查的草稿，非法律建议，非法律结论，不能替代执业律师。
              </p>
            </div>
          </Show>
        </div>
      </div>
    </div>
  );
};

export default SettingsPanel;
