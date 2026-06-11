import type { JSX } from "solid-js";

export type IconName =
  | "doc"
  | "search"
  | "bell"
  | "settings"
  | "check"
  | "attach"
  | "book"
  | "send"
  | "edit"
  | "diff"
  | "download"
  | "warn"
  | "arrow"
  | "plus"
  | "x"
  | "bold"
  | "italic"
  | "underline"
  | "list"
  | "heading"
  | "quote"
  | "scale"
  | "gavel"
  | "shield"
  | "file2"
  | "folder"
  | "handshake"
  | "target"
  | "locate"
  | "sparkle"
  | "clock"
  | "grid"
  | "chevR"
  | "refresh"
  | "copy"
  | "terminal"
  | "trash"
  | "yuan"
  | "home"
  | "briefcase"
  | "cart"
  | "eyeOff"
  | "users"
  | "up"
  | "lock"
  | "bolt"
  | "mail";

const path = (d: string) => <path d={d} />;

// Each entry is a factory: Solid JSX evaluates to real DOM nodes, so a shared
// node would be *moved* to the latest <Icon> instead of rendered in each one.
const icons: Record<IconName, () => JSX.Element> = {
  doc: () => (
    <g>
      <path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z" />
      <path d="M14 3v6h6" />
      <path d="M9 13h6M9 17h4" />
    </g>
  ),
  search: () => (
    <g>
      <circle cx="11" cy="11" r="7" />
      <path d="M21 21l-4.3-4.3" />
    </g>
  ),
  bell: () => (
    <g>
      <path d="M18 8a6 6 0 1 0-12 0c0 7-3 9-3 9h18s-3-2-3-9" />
      <path d="M13.7 21a2 2 0 0 1-3.4 0" />
    </g>
  ),
  settings: () => (
    <g>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 13a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-2.9 1.2V21a2 2 0 0 1-4 0v-.2A1.7 1.7 0 0 0 6 19.2l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1A1.7 1.7 0 0 0 4 13H3.8a2 2 0 0 1 0-4H4a1.7 1.7 0 0 0 1.2-2.9l-.1-.1A2 2 0 1 1 7.9 3.2l.1.1A1.7 1.7 0 0 0 11 4.8V4a2 2 0 0 1 4 0v.2a1.7 1.7 0 0 0 2.9 1.2l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1A1.7 1.7 0 0 0 19.2 11H21a2 2 0 0 1 0 4h-.2a1.7 1.7 0 0 0-1.4 1z" />
    </g>
  ),
  check: () => path("M4 12l5 5L20 6"),
  attach: () => path("M21 8l-9 9a4 4 0 0 1-6-6l9-9a3 3 0 0 1 4 4l-9 9a1.5 1.5 0 0 1-2-2l8-8"),
  book: () => (
    <g>
      <path d="M4 4h7a2 2 0 0 1 2 2v14a2 2 0 0 0-2-2H4z" />
      <path d="M20 4h-7a2 2 0 0 0-2 2v14a2 2 0 0 1 2-2h7z" />
    </g>
  ),
  send: () => path("M4 12l16-8-6 16-3-7z"),
  edit: () => (
    <g>
      <path d="M4 20h16" />
      <path d="M14 5l4 4-9 9H5v-4z" />
    </g>
  ),
  diff: () => (
    <g>
      <path d="M5 4v16M5 8h6M19 20V4M19 16h-6" />
    </g>
  ),
  download: () => (
    <g>
      <path d="M12 3v12M7 11l5 5 5-5M5 21h14" />
    </g>
  ),
  warn: () => (
    <g>
      <path d="M12 3l9 16H3z" />
      <path d="M12 10v4M12 17v.4" />
    </g>
  ),
  arrow: () => path("M5 12h14M13 6l6 6-6 6"),
  plus: () => path("M12 5v14M5 12h14"),
  x: () => path("M6 6l12 12M18 6L6 18"),
  bold: () => (
    <g>
      <path d="M7 5h6a3.5 3.5 0 0 1 0 7H7zM7 12h7a3.5 3.5 0 0 1 0 7H7z" />
    </g>
  ),
  italic: () => (
    <g>
      <path d="M19 5h-6M11 19H5M15 5l-4 14" />
    </g>
  ),
  underline: () => (
    <g>
      <path d="M7 4v7a5 5 0 0 0 10 0V4M5 21h14" />
    </g>
  ),
  list: () => (
    <g>
      <path d="M9 6h11M9 12h11M9 18h11M4 6h.01M4 12h.01M4 18h.01" />
    </g>
  ),
  heading: () => (
    <g>
      <path d="M6 4v16M18 4v16M6 12h12" />
    </g>
  ),
  quote: () => (
    <g>
      <path d="M7 7H4v6h3l-1 4M17 7h-3v6h3l-1 4" />
    </g>
  ),
  scale: () => (
    <g>
      <path d="M12 3v18M7 7h10M5 7l-2 6h4zM19 7l-2 6h4zM7 21h10" />
    </g>
  ),
  gavel: () => (
    <g>
      <path d="M14 4l6 6M9 9l6 6M5 19l6-6M11 5l5 5M2 22l5-2" />
    </g>
  ),
  shield: () => (
    <g>
      <path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z" />
      <path d="M9 12l2 2 4-4" />
    </g>
  ),
  file2: () => (
    <g>
      <path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z" />
      <path d="M14 3v6h6" />
    </g>
  ),
  folder: () => (
    <g>
      <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
    </g>
  ),
  handshake: () => (
    <g>
      <path d="M3 12l4-4 5 2 5-2 4 4M7 8v6a2 2 0 0 0 2 2l3-3 3 3a2 2 0 0 0 2-2V8" />
    </g>
  ),
  target: () => (
    <g>
      <circle cx="12" cy="12" r="8" />
      <circle cx="12" cy="12" r="3" />
    </g>
  ),
  locate: () => (
    <g>
      <circle cx="12" cy="12" r="3" />
      <path d="M12 2v3M12 19v3M2 12h3M19 12h3" />
    </g>
  ),
  sparkle: () => (
    <g>
      <path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z" />
    </g>
  ),
  clock: () => (
    <g>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 2" />
    </g>
  ),
  grid: () => (
    <g>
      <rect x="3" y="3" width="7" height="7" />
      <rect x="14" y="3" width="7" height="7" />
      <rect x="3" y="14" width="7" height="7" />
      <rect x="14" y="14" width="7" height="7" />
    </g>
  ),
  chevR: () => path("M9 6l6 6-6 6"),
  refresh: () => (
    <g>
      <path d="M3 12a9 9 0 0 1 15-6.7L21 8M21 3v5h-5" />
      <path d="M21 12a9 9 0 0 1-15 6.7L3 16M3 21v-5h5" />
    </g>
  ),
  copy: () => (
    <g>
      <rect x="9" y="9" width="11" height="11" rx="2" />
      <path d="M5 15V5a2 2 0 0 1 2-2h10" />
    </g>
  ),
  terminal: () => (
    <g>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M7 9l3 3-3 3M12 15h5" />
    </g>
  ),
  trash: () => (
    <g>
      <path d="M3 6h18" />
      <path d="M8 6V4h8v2" />
      <path d="M6 6l1 15h10l1-15" />
      <path d="M10 11v6M14 11v6" />
    </g>
  ),
  yuan: () => (
    <g>
      <circle cx="12" cy="12" r="9" />
      <path d="M9 7l3 4.2L15 7M12 11.2V17M9.4 13h5.2M9.4 15.4h5.2" />
    </g>
  ),
  home: () => (
    <g>
      <path d="M3 11.2L12 4l9 7.2" />
      <path d="M5.5 9.8V20h13V9.8" />
      <path d="M10 20v-5.4h4V20" />
    </g>
  ),
  briefcase: () => (
    <g>
      <rect x="3" y="8" width="18" height="12" rx="2" />
      <path d="M9 8V6a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2" />
      <path d="M3 13h18" />
    </g>
  ),
  cart: () => (
    <g>
      <circle cx="9.5" cy="20" r="1.2" />
      <circle cx="17" cy="20" r="1.2" />
      <path d="M3 4h2.4l2.4 11.6h10L20.4 8H6.6" />
    </g>
  ),
  eyeOff: () => (
    <g>
      <path d="M3 3l18 18" />
      <path d="M6.5 6.6A12.6 12.6 0 0 0 2 12c1.2 2.6 5 7 10 7 1.7 0 3.2-.5 4.5-1.2M10.4 5.2c.5-.1 1-.2 1.6-.2 5 0 8.8 4.4 10 7a13.3 13.3 0 0 1-2.6 3.7" />
      <path d="M9.9 9.9a3 3 0 0 0 4.2 4.2" />
    </g>
  ),
  users: () => (
    <g>
      <circle cx="9" cy="8" r="3.4" />
      <path d="M3 20c0-3.1 2.7-5 6-5s6 1.9 6 5" />
      <path d="M16 4.8a3.4 3.4 0 0 1 0 6.4M17.6 15.4c2 .8 3.4 2.3 3.4 4.6" />
    </g>
  ),
  up: () => path("M12 19V5M5 12l7-7 7 7"),
  lock: () => (
    <g>
      <rect x="5" y="11" width="14" height="9" rx="2" />
      <path d="M8 11V8a4 4 0 0 1 8 0v3" />
      <path d="M12 14.6v2.2" />
    </g>
  ),
  bolt: () => path("M13 2L4.5 13.5h6L9.5 22 19 10h-6z"),
  mail: () => (
    <g>
      <rect x="3" y="5" width="18" height="14" rx="2" />
      <path d="M3 7.5l9 6 9-6" />
    </g>
  ),
};

export function Icon(props: {
  name: IconName;
  class?: string;
  style?: JSX.CSSProperties;
}) {
  return (
    <svg
      viewBox="0 0 24 24"
      class={props.class ?? "icon"}
      style={props.style}
      fill="none"
      stroke="currentColor"
      stroke-linecap="round"
      stroke-linejoin="round"
      stroke-width="1.6"
    >
      {icons[props.name]()}
    </svg>
  );
}

export { icons as Icons };
