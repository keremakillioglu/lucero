import { useCallback, useMemo, useRef, useState } from 'react';
import { useRecoilCallback, useRecoilState, useRecoilValue } from 'recoil';
import { Plus, Save, Trash2, Sparkles, CopyPlus, LayoutDashboard } from 'lucide-react';
import { Button, Spinner, useToastContext } from '@librechat/client';
import { MCP_VIEWS_DEFAULT_PROMPT } from 'librechat-data-provider';
import type { MCPSuggestedView, MCPViewsSuggestParams } from 'librechat-data-provider';
import type { ViewConfig, ViewTurn } from './data';
import type { SuggestProgress } from './suggest';
import { useMCPToolsQuery } from '~/data-provider';
import useSuggestViews from './suggest';
import { createViewConfig, groupCardsByTurn } from './data';
import { useLocalize } from '~/hooks';
import {
  viewsState,
  viewTurnsState,
  autoRunViewIdsState,
  cardRunRequestFamily,
  cardSeedResultFamily,
  viewLoadGenerationState,
} from './store';
import useStarredCards from '~/components/Dashboard/starred';
import useSavedViews from './saved';
import useViewRoute from './route';
import SaveDialog from './SaveDialog';
import ViewCard from './ViewCard';
import Turn from './Turn';
import './views.css';

export default function ViewsPage() {
  const localize = useLocalize();
  const { showToast } = useToastContext();
  const { data } = useMCPToolsQuery();
  const [views, setViews] = useRecoilState(viewsState);
  const turns = useRecoilValue(viewTurnsState);
  const [suggestPrompt, setSuggestPrompt] = useState('');
  /** The prompt of the in-flight suggestion, captured at submit time */
  const pendingPromptRef = useRef('');
  const autoRunIds = useRecoilValue(autoRunViewIdsState);
  const loadGeneration = useRecoilValue(viewLoadGenerationState);
  const [saveDialogOpen, setSaveDialogOpen] = useState(false);
  const saved = useSavedViews();
  useViewRoute(saved);
  const starred = useStarredCards();

  const servers = useMemo(
    () => Object.entries(data?.servers ?? {}).filter(([, server]) => server.tools.length > 0),
    [data],
  );

  /** Appends the generated turn on top, using the latest state, then saves the view */
  const onResult = useRecoilCallback(
    ({ snapshot, set }) =>
      (suggestedViews: MCPSuggestedView[], notes?: string) => {
        const turn: ViewTurn = {
          id: crypto.randomUUID(),
          prompt: pendingPromptRef.current || MCP_VIEWS_DEFAULT_PROMPT,
          createdAt: new Date().toISOString(),
          ...(notes ? { overview: notes } : {}),
        };
        const suggested: ViewConfig[] = [];
        const needsRun: string[] = [];
        for (const view of suggestedViews) {
          const id = crypto.randomUUID();
          suggested.push({
            id,
            serverName: view.serverName,
            toolName: view.toolName,
            argsText: JSON.stringify(view.arguments ?? {}),
            display: view.display,
            title: view.title,
            turnId: turn.id,
          });
          if (view.result == null) {
            needsRun.push(id);
          } else {
            set(cardSeedResultFamily(id), view.result);
          }
        }
        const nextCards = [...suggested, ...snapshot.getLoadable(viewsState).getValue()];
        const nextTurns = [turn, ...snapshot.getLoadable(viewTurnsState).getValue()];
        set(viewsState, nextCards);
        set(viewTurnsState, nextTurns);
        set(autoRunViewIdsState, needsRun);
        setSuggestPrompt('');
        saved.autoSave(nextCards, nextTurns, turn.prompt);
      },
    [saved.autoSave],
  );

  const onError = useCallback(
    (message?: string) =>
      showToast({
        status: 'error',
        message: message ?? localize('com_ui_mcp_views_suggest_failed'),
      }),
    [showToast, localize],
  );

  const suggestViews = useSuggestViews({ onResult, onError });

  const describeProgress = (progress: SuggestProgress): string =>
    progress.type === 'thinking'
      ? localize('com_ui_mcp_views_progress_thinking', { 0: String(progress.turn) })
      : localize('com_ui_mcp_views_progress_tool', {
          0: progress.serverName,
          1: progress.toolName,
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
    pendingPromptRef.current = suggestPrompt.trim();
    suggestViews.suggest({ prompt: pendingPromptRef.current || undefined, servers: catalog });
  };

  const addView = () => {
    const view = createViewConfig(servers);
    setViews((current) => [...current, view]);
  };

  const updateView = (updated: ViewConfig) =>
    setViews((current) => current.map((view) => (view.id === updated.id ? updated : view)));

  const removeView = (id: string) =>
    setViews((current) => current.filter((view) => view.id !== id));

  const clearViews = () => saved.startNewView();

  const groups = useMemo(() => groupCardsByTurn(views, turns), [views, turns]);

  const runCards = useRecoilCallback(
    ({ set }) =>
      (cards: ViewConfig[]) => {
        for (const card of cards) {
          set(cardRunRequestFamily(card.id), (count) => count + 1);
        }
      },
    [],
  );

  const renderCard = (view: ViewConfig) => (
    <ViewCard
      key={`${loadGeneration}:${view.id}`}
      view={view}
      servers={servers}
      onChange={updateView}
      onRemove={removeView}
      autoRun={autoRunIds.includes(view.id)}
      starred={starred.starredIds.has(view.id)}
      onToggleStar={starred.toggleStar}
    />
  );

  const handleSave = () => {
    if (saved.activeView) {
      saved.saveActive();
      return;
    }
    setSaveDialogOpen(true);
  };

  return (
    <div className="flex h-full w-full flex-col overflow-y-auto bg-presentation">
      <div className="mx-auto w-full max-w-6xl px-4 py-6">
        <div className="mb-6 flex items-center justify-between gap-4">
          <div>
            <h1 className="flex items-center gap-2 text-xl font-semibold text-text-primary">
              <LayoutDashboard className="size-5" aria-hidden="true" />
              {saved.activeView?.name ?? localize('com_ui_mcp_views')}
              {saved.hasUnsavedChanges && (views.length > 0 || turns.length > 0) && (
                <span className="text-xs font-normal text-text-secondary">
                  {localize('com_ui_mcp_views_unsaved')}
                </span>
              )}
            </h1>
            <p className="mt-1 text-sm text-text-secondary">
              {localize('com_ui_mcp_views_description')}
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {(views.length > 0 || turns.length > 0) && (
              <Button
                variant="outline"
                size="sm"
                className="h-9 gap-1.5"
                onClick={handleSave}
                disabled={saved.isSaving || (saved.activeView != null && !saved.hasUnsavedChanges)}
                aria-label={localize('com_ui_save')}
              >
                <Save className="size-4" aria-hidden="true" />
                {localize('com_ui_save')}
              </Button>
            )}
            {views.length > 0 && saved.activeView != null && (
              <Button
                variant="outline"
                size="sm"
                className="h-9 gap-1.5"
                onClick={() => setSaveDialogOpen(true)}
                aria-label={localize('com_ui_mcp_views_save_as')}
              >
                <CopyPlus className="size-4" aria-hidden="true" />
                {localize('com_ui_mcp_views_save_as')}
              </Button>
            )}
            {views.length > 0 && (
              <Button
                variant="outline"
                size="sm"
                className="h-9 gap-1.5"
                onClick={clearViews}
                aria-label={localize('com_ui_clear_all')}
              >
                <Trash2 className="size-4" aria-hidden="true" />
                {localize('com_ui_clear_all')}
              </Button>
            )}
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
        {suggestViews.progress != null && (
          <p
            role="status"
            aria-live="polite"
            className="mb-4 flex items-center gap-2 text-sm text-text-secondary"
          >
            <Spinner className="size-3.5" />
            {describeProgress(suggestViews.progress)}
          </p>
        )}
        {servers.length === 0 && (
          <p className="py-8 text-center text-sm text-text-secondary">
            {localize('com_ui_mcp_views_empty')}
          </p>
        )}
        {servers.length > 0 && views.length === 0 && turns.length === 0 && (
          <p className="py-8 text-center text-sm text-text-secondary">
            {localize('com_ui_mcp_views_no_views')}
          </p>
        )}
        <div className="space-y-8">
          {groups.manual.length > 0 && (
            <section aria-label={localize('com_ui_mcp_views_manual')} className="space-y-3">
              <h2 className="text-sm font-medium text-text-secondary">
                {localize('com_ui_mcp_views_manual')}
              </h2>
              <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
                {groups.manual.map(renderCard)}
              </div>
            </section>
          )}
          {turns.map((turn) => {
            const turnCards = groups.byTurn.get(turn.id) ?? [];
            return (
              <Turn
                key={turn.id}
                turn={turn}
                onRunAll={turnCards.length > 0 ? () => runCards(turnCards) : undefined}
              >
                {turnCards.map(renderCard)}
              </Turn>
            );
          })}
        </div>
      </div>
      <SaveDialog
        open={saveDialogOpen}
        isSaving={saved.isSaving}
        onOpenChange={setSaveDialogOpen}
        onSave={saved.saveAsNew}
      />
    </div>
  );
}
