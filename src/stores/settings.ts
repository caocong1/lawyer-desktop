import { createSignal } from "solid-js";

export interface ProviderPreset {
  name: string;
  display_name: string;
  api_base_url: string;
  default_model: string;
}

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
  return {
    isConfigured,
    setIsConfigured,
    activeProvider,
    setActiveProvider,
    skillsRoot,
    setSkillsRoot,
  };
}
