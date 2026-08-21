import { useMemo, useState, useEffect } from 'react';
import { Plus, Sparkles, LayoutDashboard } from 'lucide-react';
import { Button, Spinner, useToastContext } from '@librechat/client';
import type { MCPViewsSuggestParams } from 'librechat-data-provider';
import type { ViewConfig } from './data';
import { useMCPToolsQuery, useSuggestMCPViewsMutation } from '~/data-provider';
import { useLocalize } from '~/hooks';
import ViewCard from './ViewCard';
import './views.css';

const STORAGE_KEY = 'mcp-views:v1';

function loadViews(): ViewConfig[] {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (!stored) {
      return [];
    }
    const parsed: unknown = JSON.parse(stored);
    return Array.isArray(parsed) ? (parsed as ViewConfig[]) : [];
  } catch {
    return [];
  }
}

export default function ViewsPage() {
  const localize = useLocalize();
  const { showToast } = useToastContext();
  const { data } = useMCPToolsQuery();
  const [views, setViews] = useState<ViewConfig[]>(loadViews);
  const [suggestPrompt, setSuggestPrompt] = useState('');
  const [suggestNotes, setSuggestNotes] = useState('');
  const [autoRunIds, setAutoRunIds] = useState<Set<string>>(new Set());

  const servers = useMemo(
    () => Object.entries(data?.servers ?? {}).filter(([, server]) => server.tools.length > 0),
    [data],
  );

  const suggestViews = useSuggestMCPViewsMutation({
    onSuccess: (response) => {
      const suggested: ViewConfig[] = response.views.map((view) => ({
        id: crypto.randomUUID(),
        serverName: view.serverName,
        toolName: view.toolName,
        argsText: JSON.stringify(view.arguments ?? {}),
        display: view.display,
        title: view.title,
      }));
      setSuggestNotes(response.notes ?? '');
      setAutoRunIds(new Set(suggested.map((view) => view.id)));
      setViews((current) => [...current, ...suggested]);
    },
    onError: (error) => showToast({ status: 'error', message: error.message }),
  });

  const handleSuggest = () => {
    const catalog: MCPViewsSuggestParams['servers'] = Object.fromEntries(
      servers.map(([serverName, server]) => [
        serverName,
        {
          tools: server.tools.map((tool) => ({ name: tool.name, description: tool.description })),
        },
      ]),
    );
    suggestViews.mutate({ prompt: suggestPrompt.trim() || undefined, servers: catalog });
  };

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(views));
    } catch {
      // localStorage may be unavailable; views simply won't persist
    }
  }, [views]);

  const addView = () => {
    const [serverName, server] = servers[0] ?? ['', undefined];
    setViews((current) => [
      ...current,
      {
        id: crypto.randomUUID(),
        serverName,
        toolName: server?.tools[0]?.name ?? '',
        argsText: '{}',
        display: 'auto',
      },
    ]);
  };

  const updateView = (updated: ViewConfig) =>
    setViews((current) => current.map((view) => (view.id === updated.id ? updated : view)));

  const removeView = (id: string) =>
    setViews((current) => current.filter((view) => view.id !== id));

  return (
    <div className="flex h-full w-full flex-col overflow-y-auto bg-presentation">
      <div className="mx-auto w-full max-w-6xl px-4 py-6">
        <div className="mb-6 flex items-center justify-between gap-4">
          <div>
            <h1 className="flex items-center gap-2 text-xl font-semibold text-text-primary">
              <LayoutDashboard className="size-5" aria-hidden="true" />
              {localize('com_ui_mcp_views')}
            </h1>
            <p className="mt-1 text-sm text-text-secondary">
              {localize('com_ui_mcp_views_description')}
            </p>
          </div>
          <Button
            variant="submit"
            size="sm"
            className="h-9 shrink-0 gap-1.5"
            onClick={addView}
            disabled={servers.length === 0}
            aria-label={localize('com_ui_mcp_views_add')}
          >
            <Plus className="size-4" aria-hidden="true" />
            {localize('com_ui_mcp_views_add')}
          </Button>
        </div>
        <div className="mb-4 flex items-center gap-2">
          <input
            type="text"
            value={suggestPrompt}
            onChange={(event) => setSuggestPrompt(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !suggestViews.isLoading && servers.length > 0) {
                handleSuggest();
              }
            }}
            placeholder={localize('com_ui_mcp_views_suggest_placeholder')}
            aria-label={localize('com_ui_mcp_views_suggest')}
            className="h-9 flex-1 rounded-lg border border-border-light bg-surface-primary px-3 text-sm text-text-primary focus:outline-none focus:ring-2 focus:ring-ring-primary"
          />
          <Button
            size="sm"
            variant="outline"
            className="h-9 shrink-0 gap-1.5"
            onClick={handleSuggest}
            disabled={servers.length === 0 || suggestViews.isLoading}
            aria-label={localize('com_ui_mcp_views_suggest')}
          >
            {suggestViews.isLoading ? (
              <Spinner className="size-4" />
            ) : (
              <Sparkles className="size-4" aria-hidden="true" />
            )}
            {suggestViews.isLoading
              ? localize('com_ui_mcp_views_suggesting')
              : localize('com_ui_mcp_views_suggest')}
          </Button>
        </div>
        {suggestNotes !== '' && (
          <p className="mb-4 rounded-lg border border-border-light bg-surface-secondary p-3 text-sm text-text-secondary">
            {suggestNotes}
          </p>
        )}
        {servers.length === 0 && (
          <p className="py-8 text-center text-sm text-text-secondary">
            {localize('com_ui_mcp_views_empty')}
          </p>
        )}
        {servers.length > 0 && views.length === 0 && (
          <p className="py-8 text-center text-sm text-text-secondary">
            {localize('com_ui_mcp_views_no_views')}
          </p>
        )}
        <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
          {views.map((view) => (
            <ViewCard
              key={view.id}
              view={view}
              servers={servers}
              onChange={updateView}
              onRemove={removeView}
              autoRun={autoRunIds.has(view.id)}
            />
          ))}
        </div>
      </div>
    </div>
  );
}
