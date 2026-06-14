import { createSignal, onMount, Show } from "solid-js";
import { checkForAppUpdate, installAppUpdate } from "../../services/api";

export function AppUpdateBanner() {
  const [update, setUpdate] = createSignal<{ version: string; body?: string } | null>(null);
  const [installing, setInstalling] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);

  onMount(() => {
    void (async () => {
      try {
        const info = await checkForAppUpdate();
        if (info?.available && info.version) {
          setUpdate({ version: info.version, body: info.body ?? undefined });
        }
      } catch (e) {
        console.debug("App update check skipped:", e);
      }
    })();
  });

  const install = async () => {
    setInstalling(true);
    setError(null);
    try {
      await installAppUpdate();
    } catch (e) {
      setError(String(e));
    } finally {
      setInstalling(false);
    }
  };

  return (
    <Show when={update()}>
      {(u) => (
        <div class="app-update-banner" role="status">
          <span>
            发现新版本 {u().version}
            {u().body ? ` — ${u().body}` : ""}
          </span>
          <button type="button" disabled={installing()} onClick={() => void install()}>
            {installing() ? "下载中…" : "下载并安装"}
          </button>
          <Show when={error()}>
            {(err) => <span class="app-update-error">{err()}</span>}
          </Show>
        </div>
      )}
    </Show>
  );
}
