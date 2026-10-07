// Agent Performance — ranked per-agent metrics derived from real
// visit/viewing records. No manual counters: the backend aggregates
// `visits` + `visit_viewings` for the chosen window. Demo mode keeps its
// existing Reports screen and never calls this endpoint.

import React, { useEffect, useState } from 'react';
import { Trophy } from 'lucide-react';
import { useStore } from '../state/store.jsx';
import { agentPerformanceApi } from '../services/agentPerformanceApi.js';
import { isApiRepositoryActive } from '../services/index.js';
import {
  Badge,
  Button,
  EmptyState,
  Field,
  LoadingState,
  Panel,
  Select,
  TextInput,
} from '../components/ui.jsx';

const PRESETS = [
  ['weekly', 'Last 7 days'],
  ['monthly', 'Last 30 days'],
  ['yearly', 'Last 12 months'],
  ['custom', 'Custom range'],
];
const localDay = (value = new Date()) => {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '' : date.toISOString().slice(0, 10);
};
const errorText = (error) => error?.message || 'The request could not be completed.';
const permit = (user) => Boolean(user?.permissionMatrix?.reports?.view && user.permissionMatrix.reports.view !== 'none');

export function AgentPerformance() {
  const { currentUser } = useStore();
  const live = isApiRepositoryActive();
  const [preset, setPreset] = useState('monthly');
  const [from, setFrom] = useState(() => localDay(Date.now() - 30 * 86_400_000));
  const [to, setTo] = useState(() => localDay());
  const [applied, setApplied] = useState({ preset: 'monthly' });
  const [result, setResult] = useState({ status: 'idle', items: [], range: null, error: null });

  useEffect(() => {
    if (!live || !permit(currentUser)) return undefined;
    const controller = new AbortController();
    setResult({ status: 'loading', items: [], range: null, error: null });
    const query = { ...applied };
    if (applied.preset === 'custom') { query.from = from; query.to = to; }
    agentPerformanceApi.get(query, controller.signal)
      .then((body) => { if (!controller.signal.aborted) setResult({ status: 'ready', items: body.items || [], range: body.range || null, error: null }); })
      .catch((error) => { if (!controller.signal.aborted) setResult({ status: 'error', items: [], range: null, error }); });
    return () => controller.abort();
  }, [live, currentUser, applied]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!live) return null;
  if (!permit(currentUser)) {
    return (
      <Panel title="Agent Performance" subtitle="Ranked site-visit output per executive" icon={Trophy}>
        <EmptyState title="Restricted" description="Your role does not have access to reports." />
      </Panel>
    );
  }

  const apply = (event) => {
    event.preventDefault();
    setApplied(preset === 'custom' ? { preset, from, to } : { preset });
  };

  return (
    <Panel
      title="Agent Performance"
      subtitle="Derived from visit and viewing records — no manual counters"
      icon={Trophy}
      action={result.status === 'ready' && result.range
        ? <small>{new Date(result.range.from).toLocaleDateString()} – {new Date(result.range.to).toLocaleDateString()}</small>
        : null}
    >
      <form className="filter-bar" onSubmit={apply}>
        <Field label="Range">
          <Select value={preset} onChange={(event) => setPreset(event.target.value)}>
            {PRESETS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </Select>
        </Field>
        {preset === 'custom' && (
          <>
            <Field label="From"><TextInput type="date" value={from} onChange={(event) => setFrom(event.target.value)} required /></Field>
            <Field label="To"><TextInput type="date" value={to} onChange={(event) => setTo(event.target.value)} required /></Field>
          </>
        )}
        <Button variant="primary" type="submit">Apply</Button>
      </form>

      {result.status === 'loading' && <LoadingState label="Loading agent performance" />}
      {result.status === 'error' && (
        <div role="alert"><p>{errorText(result.error)}</p><Button variant="secondary" size="sm" onClick={() => setApplied({ ...applied })}>Retry</Button></div>
      )}
      {result.status === 'ready' && result.items.length === 0 && (
        <EmptyState title="No visits in this window" description="No scheduled visits fall inside the selected range." />
      )}
      {result.status === 'ready' && result.items.length > 0 && (
        <div className="agent-perf-scroll">
          <table className="agent-perf-table">
            <thead>
              <tr>
                <th scope="col">#</th>
                <th scope="col">Agent</th>
                <th scope="col">Site visits</th>
                <th scope="col">Clients assisted</th>
                <th scope="col">Properties shown</th>
                <th scope="col">Completed</th>
                <th scope="col">Cancelled / no-show</th>
              </tr>
            </thead>
            <tbody>
              {result.items.map((row, index) => (
                <tr key={row.agentId}>
                  <td>{index + 1}</td>
                  <td><strong>{row.agentName}</strong></td>
                  <td>{row.siteVisits}</td>
                  <td>{row.clientsAssisted}</td>
                  <td>{row.propertiesShown}</td>
                  <td><Badge tone="success" size="sm">{row.completedVisits}</Badge></td>
                  <td><Badge tone={row.cancelledNoShows > 0 ? 'warning' : 'neutral'} size="sm">{row.cancelledNoShows}</Badge></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Panel>
  );
}
