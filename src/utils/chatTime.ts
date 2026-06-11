const TIME_GAP_MS = 5 * 60 * 1000;

function toDate(ms: number): Date {
  return new Date(ms);
}

function sameLocalDate(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

export function parseTimeMs(value?: string | number | null): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string" || !value) return undefined;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : undefined;
}

export function shouldShowTimeDivider(
  previousMs: number | undefined,
  currentMs: number | undefined,
): boolean {
  if (!currentMs) return false;
  if (!previousMs) return true;
  const prev = toDate(previousMs);
  const current = toDate(currentMs);
  if (!sameLocalDate(prev, current)) return true;
  return currentMs - previousMs >= TIME_GAP_MS;
}

export function formatTimeDivider(ms: number): string {
  const date = toDate(ms);
  const now = new Date();
  const time = new Intl.DateTimeFormat("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date);
  if (sameLocalDate(date, now)) return time;
  return `${new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
  }).format(date)} ${time}`;
}

export function formatFullTime(ms: number): string {
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(toDate(ms));
}
