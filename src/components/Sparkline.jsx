// Lightweight SVG charts (sparkline + bar + funnel) used across desktop
// modules. Pure presentational, no chart library dependency.

import React from 'react';

export function Sparkline({ values = [], width = 120, height = 36, stroke = 'var(--green)' }) {
  if (!values.length) return null;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;
  const step = width / (values.length - 1 || 1);
  const points = values.map((value, index) => {
    const x = index * step;
    const y = height - ((value - min) / range) * height;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });
  const lastPoint = points[points.length - 1].split(',').map(Number);
  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} aria-hidden="true">
      <polyline
        points={points.join(' ')}
        fill="none"
        stroke={stroke}
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <circle cx={lastPoint[0]} cy={lastPoint[1]} r={3} fill={stroke} />
    </svg>
  );
}

export function BarList({ items = [], max, accent = 'var(--green)' }) {
  const computedMax = max ?? Math.max(...items.map((i) => i.value), 1);
  return (
    <ul className="bar-list">
      {items.map((item) => (
        <li key={item.label}>
          <span className="bar-list-label">{item.label}</span>
          <span className="bar-list-track">
            <span
              className="bar-list-fill"
              style={{ width: `${(item.value / computedMax) * 100}%`, background: accent }}
            />
          </span>
          <span className="bar-list-value">{item.value}</span>
        </li>
      ))}
    </ul>
  );
}

export function PipelineFunnel({ stages = [] }) {
  const max = Math.max(...stages.map((s) => s.value), 1);
  return (
    <ol className="pipeline-funnel">
      {stages.map((stage, idx) => (
        <li key={stage.label} className={`pipeline-stage pipeline-stage-${stage.tone || 'neutral'}`}>
          <div className="pipeline-stage-label">
            <span className="pipeline-stage-index">{String(idx + 1).padStart(2, '0')}</span>
            <strong>{stage.label}</strong>
            <small>{stage.value} leads</small>
          </div>
          <div className="pipeline-stage-track">
            <span
              className="pipeline-stage-fill"
              style={{ width: `${(stage.value / max) * 100}%` }}
            />
          </div>
        </li>
      ))}
    </ol>
  );
}

export function Donut({ segments = [], size = 140, thickness = 18 }) {
  const total = segments.reduce((sum, seg) => sum + seg.value, 0) || 1;
  let offset = 0;
  const radius = (size - thickness) / 2;
  const circumference = 2 * Math.PI * radius;
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
      <g transform={`translate(${size / 2} ${size / 2}) rotate(-90)`}>
        <circle r={radius} fill="none" stroke="var(--line)" strokeWidth={thickness} />
        {segments.map((seg, idx) => {
          const length = (seg.value / total) * circumference;
          const dash = `${length} ${circumference - length}`;
          const node = (
            <circle
              key={seg.label}
              r={radius}
              fill="none"
              stroke={seg.color}
              strokeWidth={thickness}
              strokeDasharray={dash}
              strokeDashoffset={-offset}
            />
          );
          offset += length;
          return node;
        })}
      </g>
      <text
        x="50%"
        y="50%"
        textAnchor="middle"
        dominantBaseline="central"
        className="donut-center-label"
      >
        {total}
      </text>
    </svg>
  );
}
