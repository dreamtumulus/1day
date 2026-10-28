import { useState } from "react";

// Dependency-free SVG charts for the console (bar series over days).

export interface BarDatum {
  label: string; // x label, e.g. "2026-10-15"
  value: number;
}

export function BarChart({
  data,
  height = 180,
  format = (v: number) => String(v),
  color = "var(--primary)",
}: {
  data: BarDatum[];
  height?: number;
  format?: (v: number) => string;
  color?: string;
}) {
  const [hover, setHover] = useState<number | null>(null);
  const max = Math.max(0, ...data.map((d) => d.value));
  const n = Math.max(1, data.length);
  const W = 100;
  const gap = n > 20 ? 0.6 : 1.4;
  const bw = W / n - gap;
  const shown = hover !== null ? data[hover] : null;
  const total = data.reduce((s, d) => s + d.value, 0);

  return (
    <div className="w-full">
      <div className="mb-2 flex h-5 items-baseline justify-between gap-2 text-[12.5px]">
        <span className="font-mono text-on-surface-faint">{shown ? shown.label : `Σ ${format(total)}`}</span>
        <span className="font-mono font-semibold tabular-nums text-on-surface">{shown ? format(shown.value) : `max ${format(max)}`}</span>
      </div>
      <svg
        viewBox={`0 0 ${W} ${height}`}
        preserveAspectRatio="none"
        className="block w-full"
        style={{ height }}
        onMouseLeave={() => setHover(null)}
      >
        {[0.25, 0.5, 0.75].map((f) => (
          <line
            key={f}
            x1={0}
            x2={W}
            y1={height * f}
            y2={height * f}
            stroke="var(--outline-variant)"
            strokeWidth={0.4}
            vectorEffect="non-scaling-stroke"
            strokeDasharray="3 3"
          />
        ))}
        {data.map((d, i) => {
          const h = max > 0 ? Math.max(d.value > 0 ? 2 : 0, (d.value / max) * (height - 6)) : 0;
          const x = i * (W / n) + gap / 2;
          return (
            <g key={d.label} onMouseEnter={() => setHover(i)}>
              <rect x={x - gap / 2} y={0} width={W / n} height={height} fill="transparent" />
              <rect
                x={x}
                y={height - h}
                width={Math.max(bw, 0.4)}
                height={h}
                rx={0.6}
                fill={color}
                opacity={hover === null || hover === i ? 0.9 : 0.35}
              />
            </g>
          );
        })}
        <line x1={0} x2={W} y1={height - 0.5} y2={height - 0.5} stroke="var(--outline)" strokeWidth={0.6} vectorEffect="non-scaling-stroke" />
      </svg>
      <div className="mt-1.5 flex justify-between font-mono text-[11px] text-on-surface-faint">
        <span>{data[0]?.label.slice(5) ?? ""}</span>
        <span>{data[data.length - 1]?.label.slice(5) ?? ""}</span>
      </div>
    </div>
  );
}

/** Horizontal share bars (top-N lists). */
export function ShareBars({
  items,
  format,
}: {
  items: Array<{ label: string; value: number; sub?: string }>;
  format: (v: number) => string;
}) {
  const max = Math.max(0, ...items.map((i) => i.value));
  return (
    <ul className="space-y-3">
      {items.map((it) => (
        <li key={it.label}>
          <div className="mb-1 flex items-baseline justify-between gap-3 text-[13px]">
            <span className="min-w-0 truncate font-mono text-on-surface" title={it.label}>
              {it.label}
            </span>
            <span className="shrink-0 font-mono tabular-nums text-on-surface-variant">
              {format(it.value)}
              {it.sub && <span className="ml-2 text-on-surface-faint">{it.sub}</span>}
            </span>
          </div>
          <div className="h-1.5 overflow-hidden rounded-pill" style={{ background: "var(--surface-variant)" }}>
            <div
              className="h-full rounded-pill"
              style={{ width: `${max > 0 ? (it.value / max) * 100 : 0}%`, background: "var(--primary)" }}
            />
          </div>
        </li>
      ))}
    </ul>
  );
}
