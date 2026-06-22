import { describe, expect, test } from "bun:test";
import {
  buildDownloadCatalog,
  detectDownloadTarget,
  resolveAppArtifactPath,
} from "./app-release";

describe("app release downloads", () => {
  test("maps Tauri updater platforms into public download options", () => {
    const catalog = buildDownloadCatalog(
      {
        version: "0.1.0",
        pub_date: "2026-06-15T10:00:00Z",
        notes: "Initial release",
        platforms: {
          "windows-x86_64": {
            url: "墨律_0.1.0_x64-setup.exe",
            signature: "win-signature",
          },
          "darwin-aarch64": {
            url: "https://download.example/Inkstatute_0.1.0_aarch64.dmg",
            signature: "mac-signature",
          },
          "linux-x86_64": {
            url: "/api/app/download/inkstatute_0.1.0_amd64.AppImage",
          },
        },
      },
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
    );

    expect(catalog.configured).toBe(true);
    expect(catalog.version).toBe("0.1.0");
    expect(catalog.detectedTarget).toBe("windows");
    expect(catalog.primary?.target).toBe("windows");
    expect(catalog.primary?.label).toBe("下载 Windows 版");
    expect(catalog.options.map((option) => option.target)).toEqual([
      "windows",
      "macos",
      "linux",
    ]);
    expect(catalog.options[0]?.url).toBe(
      "/api/app/download/%E5%A2%A8%E5%BE%8B_0.1.0_x64-setup.exe",
    );
    expect(catalog.options[1]?.url).toBe("https://download.example/Inkstatute_0.1.0_aarch64.dmg");
    expect(catalog.options[2]?.url).toBe("/api/app/download/inkstatute_0.1.0_amd64.AppImage");
  });

  test("detects visitor target from user agent", () => {
    expect(detectDownloadTarget("Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0)")).toBe("macos");
    expect(detectDownloadTarget("Mozilla/5.0 (X11; Linux x86_64)")).toBe("linux");
    expect(detectDownloadTarget("Mozilla/5.0 (Windows NT 10.0; Win64; x64)")).toBe("windows");
    expect(detectDownloadTarget("")).toBe("windows");
  });

  test("keeps artifact paths inside the app data directory", () => {
    const root = "C:\\sync\\data\\app";

    expect(resolveAppArtifactPath(root, "墨律_0.1.0_x64-setup.exe")).toBe(
      "C:\\sync\\data\\app\\墨律_0.1.0_x64-setup.exe",
    );
    expect(() => resolveAppArtifactPath(root, "..\\secret.txt")).toThrow("invalid app artifact path");
    expect(() => resolveAppArtifactPath(root, "nested/file.exe")).toThrow("invalid app artifact path");
  });
});
