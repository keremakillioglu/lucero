import { useMemo } from 'react';
import { useRecoilState } from 'recoil';
import { useNavigate } from 'react-router-dom';
import { Button, TooltipAnchor } from '@librechat/client';
import { Plus, Braces, Table2, Trash2, BarChart3, LineChart, LayoutDashboard } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { ViewConfig } from './data';
import { createViewConfig, focusViewCard, viewLabel } from './data';
import { useMCPToolsQuery } from '~/data-provider';
import { useLocalize } from '~/hooks';
import { viewsState } from './store';

const DISPLAY_ICONS: Record<ViewConfig['display'], LucideIcon> = {
  auto: LayoutDashboard,
  line: LineChart,
  bar: BarChart3,
  table: Table2,
  json: Braces,
};

export default function ViewsSidePanel() {
  const localize = useLocalize();
  const navigate = useNavigate();
  const { data } = useMCPToolsQuery();
  const [views, setViews] = useRecoilState(viewsState);

  const servers = useMemo(
    () => Object.entries(data?.servers ?? {}).filter(([, server]) => server.tools.length > 0),
    [data],
  );

  const openView = (id: string) => {
    navigate('/views');
    focusViewCard(id);
  };

  const addView = () => {
    const view = createViewConfig(servers);
    setViews((current) => [...current, view]);
    openView(view.id);
  };

  const removeView = (id: string) =>
    setViews((current) => current.filter((view) => view.id !== id));

  return (
    <div className="flex h-auto w-full flex-col px-3 pb-3 pt-2">
      <div role="region" aria-label={localize('com_ui_mcp_views')} className="space-y-3">
        <Button
          size="sm"
          variant="outline"
          className="h-9 w-full gap-2 rounded-lg border-border-light font-medium"
          onClick={addView}
          disabled={servers.length === 0}
          aria-label={localize('com_ui_mcp_views_add')}
        >
          <Plus className="size-4" aria-hidden="true" />
          {localize('com_ui_mcp_views_add')}
        </Button>

        {views.length === 0 ? (
          <p className="px-1 py-2 text-xs text-text-secondary">
            {localize('com_ui_mcp_views_no_views')}
          </p>
        ) : (
          <div role="list" aria-label={localize('com_ui_mcp_views')} className="space-y-1">
            {views.map((view) => {
              const Icon = DISPLAY_ICONS[view.display] ?? LayoutDashboard;
              return (
                <div
                  key={view.id}
                  role="listitem"
                  className="group flex items-center gap-1 rounded-lg hover:bg-surface-secondary"
                >
                  <button
                    type="button"
                    onClick={() => openView(view.id)}
                    className="flex min-w-0 flex-1 items-center gap-2 rounded-lg px-2 py-2 text-left"
                  >
                    <Icon className="size-4 shrink-0 text-text-secondary" aria-hidden="true" />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm text-text-primary">
                        {viewLabel(view)}
                      </span>
                      <span className="block truncate text-xs text-text-secondary">
                        {view.serverName} · {view.toolName}
                      </span>
                    </span>
                  </button>
                  <TooltipAnchor
                    description={localize('com_ui_mcp_views_remove')}
                    side="bottom"
                    render={
                      <Button
                        variant="ghost"
                        size="icon"
                        className="size-8 shrink-0 text-text-secondary opacity-0 hover:text-red-500 focus-visible:opacity-100 group-hover:opacity-100"
                        onClick={() => removeView(view.id)}
                        aria-label={localize('com_ui_mcp_views_remove')}
                      >
                        <Trash2 className="size-4" aria-hidden="true" />
                      </Button>
                    }
                  />
                </div>
              );
            })}
          </div>
        )}

        <div>
          <h3 className="px-1 pb-1 text-xs font-medium uppercase text-text-secondary">
            {localize('com_ui_mcp_views_sources')}
          </h3>
          <div
            role="list"
            aria-label={localize('com_ui_mcp_views_sources')}
            className="space-y-0.5"
          >
            {servers.map(([serverName, server]) => (
              <div
                key={serverName}
                role="listitem"
                className="flex items-center justify-between rounded-lg px-2 py-1.5"
              >
                <span className="truncate text-sm text-text-primary">{serverName}</span>
                <span className="shrink-0 text-xs text-text-secondary">
                  {localize('com_ui_mcp_views_tool_count', { 0: String(server.tools.length) })}
                </span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
