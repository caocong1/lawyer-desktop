import { createSignal } from "solid-js";
import { getActiveProvider } from "../services/api";

export interface ProviderConfig {
  name: string;
  display_name: string;
  api_base_url: string;
  api_key?: string;
  model_name: string;
}

const [isConfigured, setIsConfigured] = createSignal(false);
const [activeProvider, setActiveProvider] = createSignal<ProviderConfig | null>(null);
const [skillsRoot, setSkillsRoot] = createSignal<string | null>(null);

export function useSettings() {
  async function restoreProvider() {
    try {
      const provider = await getActiveProvider();
      if (provider) {
        setActiveProvider(provider);
        setIsConfigured(true);
      }
    } catch (e) {
      console.error("恢复提供者配置失败:", e);
    }
  }

  return {
    isConfigured,
    setIsConfigured,
    activeProvider,
    setActiveProvider,
    skillsRoot,
    setSkillsRoot,
    restoreProvider,
  };
}
