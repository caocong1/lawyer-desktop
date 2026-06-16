import { basename, isAbsolute, relative, resolve } from "node:path";

export type DownloadTarget = "windows" | "macos" | "linux";

export interface AppPlatformRelease {
  url?: string;
  signature?: string;
  checksum?: string;
  sha256?: string;
  size?: number;
}

export interface AppReleaseManifest {
  version?: string;
  notes?: string;
  pub_date?: string;
  channel?: string;
  platforms?: Record<string, AppPlatformRelease>;
}

export interface DownloadOption {
  target: DownloadTarget;
  arch: string;
  platformKey: string;
  label: string;
  url: string;
  signature?: string;
  checksum?: string;
  size?: number;
  recommended: boolean;
}

export interface DownloadCatalog {
  configured: boolean;
  version: string | null;
  notes: string | null;
  pubDate: string | null;
  channel: string;
  detectedTarget: DownloadTarget;
  primary: DownloadOption | null;
  options: DownloadOption[];
}

const TARGET_LABEL: Record<DownloadTarget, string> = {
  windows: "Windows",
  macos: "macOS",
  linux: "Linux",
};

const TARGET_ORDER: DownloadTarget[] = ["windows", "macos", "linux"];

export function detectDownloadTarget(userAgent: string | null | undefined): DownloadTarget {
  const ua = (userAgent ?? "").toLowerCase();
  if (ua.includes("macintosh") || ua.includes("mac os") || ua.includes("darwin")) {
    return "macos";
  }
  if (ua.includes("linux") || ua.includes("x11")) {
    return "linux";
  }
  return "windows";
}

function targetFromPlatformKey(key: string): DownloadTarget | null {
  const lower = key.toLowerCase();
  if (lower.includes("windows") || lower.includes("win32") || lower.includes("msvc")) {
    return "windows";
  }
  if (lower.includes("darwin") || lower.includes("macos") || lower.includes("apple")) {
    return "macos";
  }
  if (lower.includes("linux") || lower.includes("appimage") || lower.includes("deb")) {
    return "linux";
  }
  return null;
}

function archFromPlatformKey(key: string): string {
  const lower = key.toLowerCase();
  if (lower.includes("aarch64") || lower.includes("arm64")) return "arm64";
  if (lower.includes("i686") || lower.includes("x86")) return "x64";
  return "universal";
}

function normalizeDownloadUrl(url: string): string {
  if (/^https?:\/\//i.test(url) || url.startsWith("/")) return url;
  return `/api/app/download/${encodeURIComponent(url)}`;
}

function compareOptions(a: DownloadOption, b: DownloadOption): number {
  const targetDelta = TARGET_ORDER.indexOf(a.target) - TARGET_ORDER.indexOf(b.target);
  if (targetDelta !== 0) return targetDelta;
  return a.platformKey.localeCompare(b.platformKey);
}

export function buildDownloadCatalog(
  manifest: AppReleaseManifest | null | undefined,
  userAgent: string | null | undefined,
): DownloadCatalog {
  const detectedTarget = detectDownloadTarget(userAgent);
  const base: DownloadCatalog = {
    configured: false,
    version: null,
    notes: null,
    pubDate: null,
    channel: "stable",
    detectedTarget,
    primary: null,
    options: [],
  };

  if (!manifest) return base;

  const options = Object.entries(manifest.platforms ?? {})
    .map(([platformKey, release]) => {
      const target = targetFromPlatformKey(platformKey);
      if (!target || !release?.url) return null;
      const arch = archFromPlatformKey(platformKey);
      return {
        target,
        arch,
        platformKey,
        label: `下载 ${TARGET_LABEL[target]} 版`,
        url: normalizeDownloadUrl(release.url),
        signature: release.signature,
        checksum: release.checksum ?? release.sha256,
        size: release.size,
        recommended: false,
      } satisfies DownloadOption;
    })
    .filter((option): option is DownloadOption => option !== null)
    .sort(compareOptions);

  const primaryIndex = Math.max(
    0,
    options.findIndex((option) => option.target === detectedTarget),
  );
  const primary = options[primaryIndex] ?? null;
  if (primary) primary.recommended = true;

  return {
    configured: options.length > 0,
    version: manifest.version ?? null,
    notes: manifest.notes ?? null,
    pubDate: manifest.pub_date ?? null,
    channel: manifest.channel ?? "stable",
    detectedTarget,
    primary,
    options,
  };
}

export function resolveAppArtifactPath(appDir: string, fileName: string): string {
  const decoded = decodeURIComponent(fileName);
  if (!decoded || decoded !== basename(decoded)) {
    throw new Error("invalid app artifact path");
  }

  const root = resolve(appDir);
  const filePath = resolve(root, decoded);
  const rel = relative(root, filePath);
  if (rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error("invalid app artifact path");
  }
  return filePath;
}
