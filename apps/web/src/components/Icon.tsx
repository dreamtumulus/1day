import type { SVGProps } from "react";

type P = SVGProps<SVGSVGElement>;

function base(props: P) {
  return {
    width: 20,
    height: 20,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 2,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    "aria-hidden": true,
    ...props,
  };
}

export function LogoMark({ size = 28 }: { size?: number }) {
  return (
    <svg aria-hidden width={size} height={size} viewBox="0 0 48 48" fill="none">
      <rect width="48" height="48" rx="12" fill="var(--primary)" />
      <path
        d="M14 15.5v17M14 32.5h7"
        stroke="var(--on-primary)"
        strokeWidth="4.5"
        strokeLinecap="round"
      />
      <circle
        cx="30"
        cy="24"
        r="7"
        stroke="var(--on-primary)"
        strokeWidth="4"
        fill="none"
      />
      <path
        d="M30 31v5.5M33.5 34h-3.5"
        stroke="var(--on-primary)"
        strokeWidth="3"
        strokeLinecap="round"
      />
    </svg>
  );
}

export function SunIcon(p: P) {
  return (
    <svg {...base(p)}>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M4.93 4.93l1.42 1.42M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.42-1.42M17.66 6.34l1.41-1.41" />
    </svg>
  );
}

export function MoonIcon(p: P) {
  return (
    <svg {...base(p)}>
      <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79Z" />
    </svg>
  );
}

export function GlobeIcon(p: P) {
  return (
    <svg {...base(p)}>
      <circle cx="12" cy="12" r="9" />
      <path d="M3 12h18" />
      <path d="M12 3c2.5 2.4 3.8 5.6 3.8 9s-1.3 6.6-3.8 9c-2.5-2.4-3.8-5.6-3.8-9S9.5 5.4 12 3Z" />
    </svg>
  );
}

export function MenuIcon(p: P) {
  return (
    <svg {...base(p)}>
      <path d="M4 7h16M4 12h16M4 17h16" />
    </svg>
  );
}

export function CloseIcon(p: P) {
  return (
    <svg {...base(p)}>
      <path d="M6 6l12 12M18 6 6 18" />
    </svg>
  );
}

export function CopyIcon(p: P) {
  return (
    <svg {...base(p)}>
      <rect x="9" y="9" width="12" height="12" rx="2" />
      <path d="M5 15V5a2 2 0 0 1 2-2h10" />
    </svg>
  );
}

export function CheckIcon(p: P) {
  return (
    <svg {...base(p)}>
      <path d="m4 12.5 5 5L20 6.5" />
    </svg>
  );
}

export function ShieldIcon(p: P) {
  return (
    <svg {...base(p)}>
      <path d="M12 3 5 6v5c0 4.4 3 8.2 7 10 4-1.8 7-5.6 7-10V6l-7-3Z" />
      <path d="m9 12 2 2 4-4" />
    </svg>
  );
}

export function LockIcon(p: P) {
  return (
    <svg {...base(p)}>
      <rect x="4" y="10" width="16" height="11" rx="2" />
      <path d="M8 10V7a4 4 0 0 1 8 0v3" />
    </svg>
  );
}

export function CubeIcon(p: P) {
  return (
    <svg {...base(p)}>
      <path d="m12 2 8.5 5v10L12 22l-8.5-5V7L12 2Z" />
      <path d="M12 22V12M3.5 7 12 12l8.5-5" />
    </svg>
  );
}

export function ArrowRightIcon(p: P) {
  return (
    <svg {...base(p)}>
      <path d="M4 12h16m-6-6 6 6-6 6" />
    </svg>
  );
}

export function KeyIcon(p: P) {
  return (
    <svg {...base(p)}>
      <circle cx="8" cy="15" r="4.5" />
      <path d="m11.5 11.5 8-8M15 5l3 3m-5.5.5 2.5 2.5" />
    </svg>
  );
}

export function WalletIcon(p: P) {
  return (
    <svg {...base(p)}>
      <path d="M3 7a2 2 0 0 1 2-2h13a1 1 0 0 1 1 1v2" />
      <path d="M3 7v11a2 2 0 0 0 2 2h15a1 1 0 0 0 1-1v-8a1 1 0 0 0-1-1H5a2 2 0 0 1-2-3Z" />
      <circle cx="16.5" cy="14.5" r="1.2" fill="currentColor" stroke="none" />
    </svg>
  );
}

export function ChartIcon(p: P) {
  return (
    <svg {...base(p)}>
      <path d="M4 20V4m0 16h16" />
      <path d="m7 14 4-4 3 3 5-6" />
    </svg>
  );
}

export function ChevronDownIcon(p: P) {
  return (
    <svg {...base(p)}>
      <path d="m6 9 6 6 6-6" />
    </svg>
  );
}

export function SearchIcon(p: P) {
  return (
    <svg {...base(p)}>
      <circle cx="11" cy="11" r="7" />
      <path d="m20 20-3.5-3.5" />
    </svg>
  );
}

export function ScaleIcon(p: P) {
  return (
    <svg {...base(p)}>
      <path d="M12 3v18M8 21h8M12 6l6 2m-6-2-6 2" />
      <path d="m6 8-2.5 5a2.9 2.9 0 0 0 5 0L6 8ZM18 8l-2.5 5a2.9 2.9 0 0 0 5 0L18 8Z" />
    </svg>
  );
}

export function SwapIcon(p: P) {
  return (
    <svg {...base(p)}>
      <path d="M7 4 3 8l4 4M3 8h14M17 12l4 4-4 4M21 16H7" />
    </svg>
  );
}

export function VerifiedIcon(p: P) {
  return (
    <svg {...base(p)}>
      <path d="m12 2 2.4 2.4 3.3-.5 1 3.2 3.1 1.2-1.2 3.1 1.2 3.1-3.1 1.2-1 3.2-3.3-.5L12 22l-2.4-2.4-3.3.5-1-3.2-3.1-1.2 1.2-3.1-1.2-3.1 3.1-1.2 1-3.2 3.3.5L12 2Z" />
      <path d="m9 12 2 2 4-4" />
    </svg>
  );
}

export function PlugIcon(p: P) {
  return (
    <svg {...base(p)}>
      <path d="M9 2v6m6-6v6M6 8h12v4a6 6 0 0 1-6 6 6 6 0 0 1-6-6V8ZM12 18v4" />
    </svg>
  );
}

export function RefreshIcon(p: P) {
  return (
    <svg {...base(p)}>
      <path d="M21 12a9 9 0 1 1-2.6-6.3M21 3v6h-6" />
    </svg>
  );
}

export function RocketIcon(p: P) {
  return (
    <svg {...base(p)}>
      <path d="M5 15c-1.5 1.2-2 5-2 5s3.8-.5 5-2M14 4c3-2 7-2 7-2s0 4-2 7l-7 7-5-5 7-7Z" />
      <circle cx="15" cy="9" r="2" />
    </svg>
  );
}

export function TerminalIcon(p: P) {
  return (
    <svg {...base(p)}>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="m7 9 3 3-3 3M13 15h4" />
    </svg>
  );
}

export function SparkleIcon(p: P) {
  return (
    <svg {...base(p)}>
      <path d="M12 3c.6 3.8 2.4 5.6 6 6-3.6.4-5.4 2.2-6 6-.6-3.8-2.4-5.6-6-6 3.6-.4 5.4-2.2 6-6Z" />
      <path d="M19 15c.3 1.7 1.2 2.7 3 3-1.8.3-2.7 1.3-3 3-.3-1.7-1.2-2.7-3-3 1.8-.3 2.7-1.3 3-3Z" />
    </svg>
  );
}

export function HeadsetIcon(p: P) {
  return (
    <svg {...base(p)}>
      <path d="M4 13a8 8 0 0 1 16 0" />
      <rect x="2" y="13" width="5" height="7" rx="2" />
      <rect x="17" y="13" width="5" height="7" rx="2" />
      <path d="M20 19a3 3 0 0 1-3 3h-3" />
    </svg>
  );
}

export function BookIcon(p: P) {
  return (
    <svg {...base(p)}>
      <path d="M12 6.5C10.3 5.2 7.9 4.6 4 4.6v13.6c3.9 0 6.3.6 8 1.9 1.7-1.3 4.1-1.9 8-1.9V4.6c-3.9 0-6.3.6-8 1.9Z" />
      <path d="M12 6.5v13.6" />
    </svg>
  );
}

export function BellIcon(p: P) {
  return (
    <svg {...base(p)}>
      <path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9" />
      <path d="M10 21h4" />
    </svg>
  );
}

export function GridIcon(p: P) {
  return (
    <svg {...base(p)}>
      <rect x="4" y="4" width="4.5" height="4.5" rx="1" />
      <rect x="15" y="4" width="4.5" height="4.5" rx="1" />
      <rect x="4" y="15" width="4.5" height="4.5" rx="1" />
      <rect x="15" y="15" width="4.5" height="4.5" rx="1" />
    </svg>
  );
}

export function XLogoIcon(p: P) {
  return (
    <svg viewBox="0 0 24 24" width={18} height={18} fill="currentColor" aria-hidden {...p}>
      <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231 5.451-6.231Zm-1.161 17.52h1.833L7.084 4.126H5.117L17.083 19.77Z" />
    </svg>
  );
}

/* ---- Vendor glyphs (simple colored marks, approximating brand icons) ---- */

export function VendorGlyph({ vendor, size = 16 }: { vendor: string; size?: number }) {
  const s = { width: size, height: size, viewBox: "0 0 16 16", "aria-hidden": true };
  switch (vendor) {
    case "anthropic":
      return (
        <svg {...s}>
          <path
            d="M8 1.5 14.5 14h-2.6L8 5.4 4.1 14H1.5L8 1.5Z"
            fill="#d97757"
          />
        </svg>
      );
    case "openai":
      return (
        <svg {...s} fill="none" stroke="currentColor" strokeWidth="1.6">
          <circle cx="8" cy="8" r="6" />
          <path d="M8 2v12M2 8h12M4 4l8 8M12 4l-8 8" strokeWidth="1" />
        </svg>
      );
    case "moonshot":
      return (
        <svg {...s}>
          <path d="M3 1.5v13M3 8l7-6.5M4.5 9 12 14.5" stroke="currentColor" strokeWidth="2.4" fill="none" strokeLinecap="round" />
        </svg>
      );
    case "zhipu":
      return (
        <svg {...s}>
          <rect x="2" y="2" width="12" height="12" rx="3" fill="#315efb" />
          <path d="M5 8h6M8 5v6" stroke="#fff" strokeWidth="1.8" strokeLinecap="round" />
        </svg>
      );
    case "xai":
      return (
        <svg {...s}>
          <path d="M2.5 2.5 8 8l5.5-5.5M13.5 13.5 8 8l-5.5 5.5" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />
        </svg>
      );
    case "volcengine":
      return (
        <svg {...s}>
          <path d="M2 3.5 8 13.5 14 3.5" stroke="#1664ff" strokeWidth="2.4" fill="none" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      );
    case "minimax":
      return (
        <svg {...s}>
          <path d="M2 13.5V2.5l6 7 6-7v11" stroke="#e93d82" strokeWidth="2.2" fill="none" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      );
    case "opencode":
      return (
        <svg {...s} fill="none" stroke="#f5c97b" strokeWidth="2" strokeLinecap="round">
          <path d="m5.5 4.5-3 3.5 3 3.5M10.5 4.5l3 3.5-3 3.5" />
        </svg>
      );
    default:
      return (
        <svg {...s}>
          <circle cx="8" cy="8" r="5.5" fill="none" stroke="currentColor" strokeWidth="1.8" />
        </svg>
      );
  }
}
