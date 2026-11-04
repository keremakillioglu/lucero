import { useMemo, useState, useEffect, useCallback, useRef } from 'react';
import { useRecoilValue } from 'recoil';
import { Play, Star, Trash2 } from 'lucide-react';
import { cn, Button, Spinner, Dropdown, TooltipAnchor, useToastContext } from '@librechat/client';
import type { MCPServer } from 'librechat-data-provider';
import type { ViewConfig, ViewDisplay, TableData } from './data';
import { extractDatasets, buildTable, isTimeLike, MAX_SERIES } from './data';
import { useCallMCPToolMutation } from '~/data-provider';
import { cardRunRequestFamily, cardSeedResultFamily } from './store';
import { useLocalize } from '~/hooks';
import Chart from './Chart';

type ViewCardProps = {
  view: ViewConfig;
  servers: Array<[string, MCPServer]>;
  onChange: (view: ViewConfig) => void;
  onRemove: (id: string) => void;
  autoRun?: boolean;
  /** A stored result to show on mount instead of running the tool */
  initialResult?: string;
  /** Whether the card is on the custom dashboard; the star renders only with `onToggleStar` */
  starred?: boolean;
  onToggleStar?: (view: ViewConfig) => void;
};

type ModeKey =
  | 'com_ui_mcp_views_line'
  | 'com_ui_mcp_views_bar'
  | 'com_ui_mcp_views_table'
  | 'com_ui_mcp_views_json';

const DISPLAY_MODES: Array<{ mode: ViewDisplay; labelKey: ModeKey }> = [
  { mode: 'line', labelKey: 'com_ui_mcp_views_line' },
  { mode: 'bar', labelKey: 'com_ui_mcp_views_bar' },
  { mode: 'table', labelKey: 'com_ui_mcp_views_table' },
  { mode: 'json', labelKey: 'com_ui_mcp_views_json' },
];

function ResultTable({ table }: { table: TableData }) {
  return (
    <div className="max-h-72 overflow-auto rounded-lg border border-border-light">
      <table className="w-full text-xs">
        <thead className="sticky top-0 bg-surface-secondary">
          <tr>
            {table.columns.map((column) => (
              <th key={column} className="px-2 py-1.5 text-left font-medium text-text-secondary">
                {column}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {table.rows.map((row, rowIndex) => (
            <tr key={rowIndex} className="border-t border-border-light">
              {table.columns.map((column) => (
                <td key={column} className="whitespace-nowrap px-2 py-1 text-text-primary">
                  {row[column] == null ? '' : String(row[column])}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default function ViewCard({
  view,
  servers,
  onChange,
  onRemove,
  autoRun,
  initialResult,
  starred = false,
  onToggleStar,
}: ViewCardProps) {
  const localize = useLocalize();
  const { showToast } = useToastContext();
  const seedResult = useRecoilValue(cardSeedResultFamily(view.id));
  const [result, setResult] = useState<string | null>(initialResult ?? seedResult);
  const [error, setError] = useState<string | null>(null);

  const callTool = useCallMCPToolMutation({
    onSuccess: (data) => {
      setError(null);
      setResult(data.result);
    },
    onError: (mutationError) => setError(mutationError.message),
  });

  const server = servers.find(([name]) => name === view.serverName);
  const tools = server?.[1].tools ?? [];

  const datasets = useMemo(() => (result == null ? [] : extractDatasets(result)), [result]);
  const dataset =
    datasets.find((candidate) => candidate.path === view.datasetPath) ?? datasets[0] ?? null;
  const table = useMemo(
    () => (dataset == null ? null : buildTable(dataset.rows, view.xKey, view.yKeys)),
    [dataset, view.xKey, view.yKeys],
  );

  const resolveAutoDisplay = (): ViewDisplay => {
    if (table == null) {
      return 'json';
    }
    return isTimeLike(table.rows, table.xKey) ? 'line' : 'bar';
  };
  const display = view.display === 'auto' ? resolveAutoDisplay() : view.display;

  const canChart = table != null && table.xKey != null && table.yKeys.length > 0;
  const isModeDisabled = (mode: ViewDisplay): boolean => {
    if (mode === 'json') {
      return false;
    }
    if (mode === 'table') {
      return table == null;
    }
    return !canChart;
  };

  const toggleSeries = (column: string) => {
    if (table == null) {
      return;
    }
    const current = table.yKeys;
    const next = current.includes(column)
      ? current.filter((key) => key !== column)
      : [...current, column].slice(0, MAX_SERIES);
    onChange({ ...view, yKeys: next });
  };

  const handleRun = useCallback(() => {
    let toolArguments: Record<string, unknown>;
    try {
      toolArguments = view.argsText.trim() ? JSON.parse(view.argsText) : {};
    } catch {
      showToast({ status: 'error', message: localize('com_ui_mcp_views_arguments_invalid') });
      return;
    }
    setResult(null);
    setError(null);
    callTool.mutate({ serverName: view.serverName, toolName: view.toolName, toolArguments });
  }, [view.argsText, view.serverName, view.toolName, callTool, showToast, localize]);

  const runRequest = useRecoilValue(cardRunRequestFamily(view.id));
  const handledRunRequestRef = useRef(runRequest);
  useEffect(() => {
    if (runRequest === handledRunRequestRef.current) {
      return;
    }
    handledRunRequestRef.current = runRequest;
    if (view.toolName) {
      handleRun();
    }
  }, [runRequest, view.toolName, handleRun]);

  const autoRanRef = useRef(false);
  useEffect(() => {
    if (autoRun === true && !autoRanRef.current && view.toolName) {
      autoRanRef.current = true;
      handleRun();
    }
  }, [autoRun, view.toolName, handleRun]);

  return (
    <div
      id={`view-card-${view.id}`}
      className="viz-root flex flex-col gap-3 rounded-xl border border-border-light bg-surface-primary p-4"
    >
      {view.title != null && view.title !== '' && (
        <h2 className="text-sm font-semibold text-text-primary">{view.title}</h2>
      )}
      <div className="flex items-center gap-2">
        <Dropdown
          value={view.serverName}
          onChange={(serverName) =>
            onChange({
              ...view,
              serverName,
              toolName: servers.find(([name]) => name === serverName)?.[1].tools[0]?.name ?? '',
              datasetPath: undefined,
              xKey: undefined,
              yKeys: undefined,
            })
          }
          options={servers.map(([name]) => name)}
          ariaLabel={localize('com_ui_mcp_servers')}
          testId={`view-source-${view.id}`}
          className="min-w-0 flex-1"
        />
        <Dropdown
          value={view.toolName}
          onChange={(toolName) =>
            onChange({
              ...view,
              toolName,
              datasetPath: undefined,
              xKey: undefined,
              yKeys: undefined,
            })
          }
          options={tools.map((tool) => ({ value: tool.name, label: tool.name }))}
          searchable={tools.length > 8}
          ariaLabel={localize('com_ui_mcp_views_select_tool')}
          testId={`view-tool-${view.id}`}
          className="min-w-0 flex-1"
        />
        <Button
          variant="submit"
          size="sm"
          className="h-9 shrink-0 gap-1.5"
          onClick={handleRun}
          disabled={!view.toolName || callTool.isLoading}
          aria-label={localize('com_ui_mcp_views_run')}
        >
          {callTool.isLoading ? (
            <Spinner className="size-4" />
          ) : (
            <Play className="size-4" aria-hidden="true" />
          )}
          {localize('com_ui_mcp_views_run')}
        </Button>
        {onToggleStar != null && (
          <TooltipAnchor
            description={localize(starred ? 'com_ui_mcp_views_unstar' : 'com_ui_mcp_views_star')}
            side="bottom"
            render={
              <Button
                variant="ghost"
                size="icon"
                className="size-9 shrink-0 text-text-secondary hover:bg-surface-secondary hover:text-yellow-500"
                onClick={() => onToggleStar(view)}
                aria-pressed={starred}
                aria-label={localize(starred ? 'com_ui_mcp_views_unstar' : 'com_ui_mcp_views_star')}
              >
                <Star
                  className={cn('size-4', starred && 'fill-yellow-500 text-yellow-500')}
                  aria-hidden="true"
                />
              </Button>
            }
          />
        )}
        <TooltipAnchor
          description={localize('com_ui_mcp_views_remove')}
          side="bottom"
          render={
            <Button
              variant="ghost"
              size="icon"
              className="size-9 shrink-0 text-text-secondary hover:bg-surface-secondary hover:text-red-500"
              onClick={() => onRemove(view.id)}
              aria-label={localize('com_ui_mcp_views_remove')}
            >
              <Trash2 className="size-4" aria-hidden="true" />
            </Button>
          }
        />
      </div>
      {error != null && (
        <p className="whitespace-pre-wrap break-words text-xs text-red-500">{error}</p>
      )}
      {result != null && (
        <>
          <div className="flex flex-wrap items-center gap-2">
            <div className="flex gap-1" role="tablist" aria-label={localize('com_ui_mcp_views')}>
              {DISPLAY_MODES.map(({ mode, labelKey }) => {
                const disabled = isModeDisabled(mode);
                return (
                  <button
                    key={mode}
                    type="button"
                    role="tab"
                    aria-selected={display === mode}
                    disabled={disabled}
                    onClick={() => onChange({ ...view, display: mode })}
                    className={cn(
                      'rounded-md px-2.5 py-1 text-xs font-medium transition-colors',
                      display === mode
                        ? 'bg-surface-tertiary text-text-primary'
                        : 'text-text-secondary hover:bg-surface-secondary',
                      disabled && 'cursor-not-allowed opacity-40',
                    )}
                  >
                    {localize(labelKey)}
                  </button>
                );
              })}
            </div>
          </div>
          {datasets.length > 1 && (
            <div className="flex items-center gap-2">
              <span className="text-xs font-medium text-text-secondary">
                {localize('com_ui_mcp_views_dataset')}
              </span>
              <Dropdown
                value={dataset?.path ?? ''}
                onChange={(datasetPath) =>
                  onChange({ ...view, datasetPath, xKey: undefined, yKeys: undefined })
                }
                options={datasets.map((candidate) => ({
                  value: candidate.path,
                  label: `${candidate.path} (${candidate.rows.length})`,
                }))}
                ariaLabel={localize('com_ui_mcp_views_dataset')}
                testId={`view-dataset-${view.id}`}
                className="min-w-0 flex-1"
              />
            </div>
          )}
          {table != null && (display === 'line' || display === 'bar') && (
            <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
              <div className="flex items-center gap-2">
                <span className="text-xs font-medium text-text-secondary">
                  {localize('com_ui_mcp_views_x_axis')}
                </span>
                <Dropdown
                  value={table.xKey ?? ''}
                  onChange={(xKey) => onChange({ ...view, xKey })}
                  options={table.columns}
                  ariaLabel={localize('com_ui_mcp_views_x_axis')}
                  testId={`view-x-${view.id}`}
                />
              </div>
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="text-xs font-medium text-text-secondary">
                  {localize('com_ui_mcp_views_series')}
                </span>
                {table.numericColumns.map((column) => {
                  const selected = table.yKeys.includes(column);
                  return (
                    <button
                      key={column}
                      type="button"
                      aria-pressed={selected}
                      onClick={() => toggleSeries(column)}
                      className={cn(
                        'rounded-full border px-2 py-0.5 text-xs transition-colors',
                        selected
                          ? 'border-transparent bg-surface-tertiary font-medium text-text-primary'
                          : 'border-border-light text-text-secondary hover:bg-surface-secondary',
                      )}
                    >
                      {column}
                    </button>
                  );
                })}
              </div>
            </div>
          )}
          {(display === 'line' || display === 'bar') && canChart && table && (
            <Chart
              rows={table.rows}
              xKey={table.xKey as string}
              yKeys={table.yKeys}
              kind={display}
            />
          )}
          {(display === 'line' || display === 'bar') && !canChart && (
            <p className="text-xs text-text-secondary">{localize('com_ui_mcp_views_no_table')}</p>
          )}
          {display === 'table' &&
            (table != null ? (
              <ResultTable table={table} />
            ) : (
              <p className="text-xs text-text-secondary">{localize('com_ui_mcp_views_no_table')}</p>
            ))}
          {display === 'json' && (
            <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-words rounded-lg border border-border-light bg-surface-secondary p-3 font-mono text-xs text-text-primary">
              {result}
            </pre>
          )}
        </>
      )}
    </div>
  );
}
