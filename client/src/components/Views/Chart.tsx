import { useMemo, useRef, useState, useLayoutEffect } from 'react';
import type { DataRow } from './data';
import { toNumber, formatCompact } from './data';

const SERIES_VARS = [
  'var(--viz-series-1)',
  'var(--viz-series-2)',
  'var(--viz-series-3)',
  'var(--viz-series-4)',
  'var(--viz-series-5)',
  'var(--viz-series-6)',
  'var(--viz-series-7)',
  'var(--viz-series-8)',
];

const MARGIN = { top: 12, right: 16, bottom: 26, left: 52 };
const HEIGHT = 280;
const Y_TICKS = 4;
const MAX_X_LABELS = 6;
const BAR_CAP_RADIUS = 4;

type ChartProps = {
  rows: DataRow[];
  xKey: string;
  yKeys: string[];
  kind: 'line' | 'bar';
};

type HoverState = {
  index: number;
  px: number;
  py: number;
};

function useContainerWidth(): [React.RefObject<HTMLDivElement>, number] {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);

  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) {
      return;
    }
    const observer = new ResizeObserver((entries) => {
      setWidth(entries[0]?.contentRect.width ?? 0);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  return [ref, width];
}

function niceCeil(value: number): number {
  if (value <= 0) {
    return 1;
  }
  const magnitude = Math.pow(10, Math.floor(Math.log10(value)));
  const normalized = value / magnitude;
  const steps = [1, 2, 5, 10];
  const nice = steps.find((step) => normalized <= step) ?? 10;
  return nice * magnitude;
}

/** Rounded-top bar path anchored to the baseline */
function barPath(x: number, y: number, width: number, height: number): string {
  const radius = Math.min(BAR_CAP_RADIUS, width / 2, height);
  const bottom = y + height;
  return [
    `M${x},${bottom}`,
    `V${y + radius}`,
    `Q${x},${y} ${x + radius},${y}`,
    `H${x + width - radius}`,
    `Q${x + width},${y} ${x + width},${y + radius}`,
    `V${bottom}`,
    'Z',
  ].join(' ');
}

const truncate = (value: string, max = 12): string =>
  value.length > max ? `${value.slice(0, max - 1)}…` : value;

export default function Chart({ rows, xKey, yKeys, kind }: ChartProps) {
  const [containerRef, width] = useContainerWidth();
  const [hover, setHover] = useState<HoverState | null>(null);

  const plot = useMemo(() => {
    const xValues = rows.map((row) => String(row[xKey] ?? ''));
    const series = yKeys.map((key) => rows.map((row) => toNumber(row[key])));
    const allValues = series.flat().filter((value): value is number => value != null);
    const dataMin = allValues.length ? Math.min(...allValues) : 0;
    const dataMax = allValues.length ? Math.max(...allValues) : 1;
    const yMin = Math.min(0, dataMin);
    const yMax = niceCeil(dataMax <= yMin ? yMin + 1 : dataMax);
    return { xValues, series, yMin, yMax };
  }, [rows, xKey, yKeys]);

  if (width < 80 || rows.length === 0 || yKeys.length === 0) {
    return <div ref={containerRef} className="h-[280px] w-full" />;
  }

  const innerWidth = width - MARGIN.left - MARGIN.right;
  const innerHeight = HEIGHT - MARGIN.top - MARGIN.bottom;
  const { xValues, series, yMin, yMax } = plot;
  const count = xValues.length;

  const xPos = (index: number): number =>
    kind === 'bar'
      ? MARGIN.left + (innerWidth / count) * (index + 0.5)
      : MARGIN.left + (count === 1 ? innerWidth / 2 : (innerWidth / (count - 1)) * index);
  const yPos = (value: number): number =>
    MARGIN.top + innerHeight - ((value - yMin) / (yMax - yMin)) * innerHeight;

  const yTicks = Array.from(
    { length: Y_TICKS + 1 },
    (_, i) => yMin + ((yMax - yMin) / Y_TICKS) * i,
  );
  const labelStep = Math.max(1, Math.ceil(count / MAX_X_LABELS));
  const slotWidth = innerWidth / count;
  const barWidth = Math.max(2, Math.min(40, slotWidth - 2));
  const baseline = yPos(Math.max(yMin, 0));

  const handleMove = (event: React.PointerEvent<SVGSVGElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const pointerX = event.clientX - rect.left;
    const relative = (pointerX - MARGIN.left) / innerWidth;
    const index = Math.max(0, Math.min(count - 1, Math.round(relative * (count - 1))));
    const barIndex = Math.max(0, Math.min(count - 1, Math.floor(relative * count)));
    const activeIndex = kind === 'bar' ? barIndex : index;
    setHover({ index: activeIndex, px: xPos(activeIndex), py: event.clientY - rect.top });
  };

  return (
    <div ref={containerRef} className="relative w-full">
      {yKeys.length > 1 && (
        <div className="mb-1 flex flex-wrap gap-x-4 gap-y-1 px-1">
          {yKeys.map((key, seriesIndex) => (
            <span key={key} className="flex items-center gap-1.5 text-xs text-text-secondary">
              <span
                className="size-2.5 rounded-full"
                style={{ backgroundColor: SERIES_VARS[seriesIndex] }}
                aria-hidden="true"
              />
              {key}
            </span>
          ))}
        </div>
      )}
      <svg
        width={width}
        height={HEIGHT}
        role="img"
        aria-label={`${kind} chart of ${yKeys.join(', ')} by ${xKey}`}
        onPointerMove={handleMove}
        onPointerLeave={() => setHover(null)}
      >
        {yTicks.map((tick) => (
          <g key={tick}>
            <line
              x1={MARGIN.left}
              x2={width - MARGIN.right}
              y1={yPos(tick)}
              y2={yPos(tick)}
              stroke="var(--viz-grid)"
            />
            <text
              x={MARGIN.left - 8}
              y={yPos(tick) + 3}
              textAnchor="end"
              className="fill-text-secondary text-[10px]"
            >
              {formatCompact(tick)}
            </text>
          </g>
        ))}
        <line
          x1={MARGIN.left}
          x2={width - MARGIN.right}
          y1={baseline}
          y2={baseline}
          stroke="var(--viz-axis)"
        />
        {xValues.map((label, index) =>
          index % labelStep === 0 ? (
            <text
              key={`${label}-${index}`}
              x={xPos(index)}
              y={HEIGHT - 8}
              textAnchor="middle"
              className="fill-text-secondary text-[10px]"
            >
              {truncate(label)}
            </text>
          ) : null,
        )}
        {kind === 'bar'
          ? series[0].map((value, index) => {
              if (value == null) {
                return null;
              }
              const top = Math.min(yPos(value), baseline);
              const height = Math.abs(baseline - yPos(value));
              return (
                <path
                  key={index}
                  d={barPath(xPos(index) - barWidth / 2, top, barWidth, Math.max(height, 1))}
                  fill={SERIES_VARS[0]}
                  opacity={hover != null && hover.index !== index ? 0.55 : 1}
                />
              );
            })
          : series.map((values, seriesIndex) => {
              const points = values
                .map((value, index) => (value == null ? null : `${xPos(index)},${yPos(value)}`))
                .filter(Boolean)
                .join(' ');
              return (
                <polyline
                  key={yKeys[seriesIndex]}
                  points={points}
                  fill="none"
                  stroke={SERIES_VARS[seriesIndex]}
                  strokeWidth={2}
                  strokeLinejoin="round"
                  strokeLinecap="round"
                />
              );
            })}
        {hover != null && kind === 'line' && (
          <g>
            <line
              x1={hover.px}
              x2={hover.px}
              y1={MARGIN.top}
              y2={MARGIN.top + innerHeight}
              stroke="var(--viz-axis)"
              strokeDasharray="3 3"
            />
            {series.map((values, seriesIndex) => {
              const value = values[hover.index];
              if (value == null) {
                return null;
              }
              return (
                <circle
                  key={yKeys[seriesIndex]}
                  cx={hover.px}
                  cy={yPos(value)}
                  r={4}
                  fill={SERIES_VARS[seriesIndex]}
                  stroke="var(--surface-primary, #fff)"
                  strokeWidth={2}
                  className="stroke-surface-primary"
                />
              );
            })}
          </g>
        )}
      </svg>
      {hover != null && (
        <div
          className="pointer-events-none absolute z-10 rounded-lg border border-border-light bg-surface-primary px-2.5 py-1.5 text-xs shadow-md"
          style={{
            left: Math.min(hover.px + 10, width - 140),
            top: Math.max(hover.py - 10, 0),
          }}
        >
          <div className="mb-0.5 font-medium text-text-primary">{xValues[hover.index]}</div>
          {yKeys.map((key, seriesIndex) => {
            const value = series[seriesIndex][hover.index];
            return (
              <div key={key} className="flex items-center gap-1.5 text-text-secondary">
                <span
                  className="size-2 rounded-full"
                  style={{ backgroundColor: SERIES_VARS[seriesIndex] }}
                  aria-hidden="true"
                />
                <span>{key}:</span>
                <span className="font-medium text-text-primary">
                  {value == null ? '—' : formatCompact(value)}
                </span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
