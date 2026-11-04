import { useMemo } from 'react';
import { PieChart, RefreshCw } from 'lucide-react';
import { Button, Spinner } from '@librechat/client';
import { formatDateTime } from '~/components/Views/data';
import ViewCard from '~/components/Views/ViewCard';
import { useMCPToolsQuery } from '~/data-provider';
import { useLocalize } from '~/hooks';
import useStarredCards from './starred';
import '~/components/Views/views.css';

/**
 * Starred view cards. Each card shows the result stored by the last sign-in or manual refresh;
 * a card without a stored result runs live instead.
 */
export default function DashboardPage() {
  const localize = useLocalize();
  const { data } = useMCPToolsQuery();
  const {
    cards,
    snapshots,
    refreshedAt,
    isLoading,
    isRefreshing,
    refresh,
    toggleStar,
    updateCard,
    removeCard,
  } = useStarredCards();

  const servers = useMemo(
    () => Object.entries(data?.servers ?? {}).filter(([, server]) => server.tools.length > 0),
    [data],
  );

  return (
    <div className="flex h-full w-full flex-col overflow-y-auto bg-presentation">
      <div className="mx-auto w-full max-w-6xl px-4 py-6">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h1 className="flex items-center gap-2 text-xl font-semibold text-text-primary">
              <PieChart className="size-5" aria-hidden="true" />
              {localize('com_ui_custom_dashboard')}
            </h1>
            <p className="mt-1 text-sm text-text-secondary">
              {localize('com_ui_custom_dashboard_description')}
            </p>
            {refreshedAt != null && (
              <p className="mt-1 text-xs text-text-secondary">
                {localize('com_ui_custom_dashboard_as_of', { 0: formatDateTime(refreshedAt) })}
              </p>
            )}
          </div>
          {cards.length > 0 && (
            <Button
              variant="outline"
              size="sm"
              className="h-9 shrink-0 gap-1.5"
              onClick={refresh}
              disabled={isRefreshing}
              aria-label={localize('com_ui_custom_dashboard_refresh')}
            >
              {isRefreshing ? (
                <Spinner className="size-4" />
              ) : (
                <RefreshCw className="size-4" aria-hidden="true" />
              )}
              {localize(
                isRefreshing
                  ? 'com_ui_custom_dashboard_refreshing'
                  : 'com_ui_custom_dashboard_refresh',
              )}
            </Button>
          )}
        </div>
        {isLoading && (
          <div className="flex justify-center py-8">
            <Spinner className="size-5" />
          </div>
        )}
        {!isLoading && cards.length === 0 && (
          <p className="py-8 text-center text-sm text-text-secondary">
            {localize('com_ui_custom_dashboard_empty')}
          </p>
        )}
        <div className="mt-6 grid grid-cols-1 gap-4 xl:grid-cols-2">
          {cards.map((card) => {
            const snapshot = snapshots?.[card.id];
            return (
              <ViewCard
                key={`${card.id}:${snapshot?.fetchedAt ?? 'live'}`}
                view={card}
                servers={servers}
                onChange={updateCard}
                onRemove={removeCard}
                initialResult={snapshot?.result}
                autoRun={snapshot == null}
                starred={true}
                onToggleStar={toggleStar}
              />
            );
          })}
        </div>
      </div>
    </div>
  );
}
