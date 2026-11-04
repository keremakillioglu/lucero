import { useCallback, useMemo } from 'react';
import { useToastContext } from '@librechat/client';
import type { ViewConfig } from '~/components/Views/data';
import {
  useViewsDashboardQuery,
  useUpdateViewsDashboardMutation,
  useRefreshViewsDashboardMutation,
} from '~/data-provider';
import { useLocalize } from '~/hooks';

/** Starred view cards that make up the custom dashboard, with actions to change them */
export default function useStarredCards() {
  const localize = useLocalize();
  const { showToast } = useToastContext();
  const { data, isLoading } = useViewsDashboardQuery();
  const saveDashboard = useUpdateViewsDashboardMutation();
  const refreshDashboard = useRefreshViewsDashboardMutation();
  const cards = useMemo(() => data?.cards ?? [], [data]);
  const starredIds = useMemo(() => new Set(cards.map((card) => card.id)), [cards]);

  const save = useCallback(
    (next: ViewConfig[]) =>
      saveDashboard.mutate(
        { cards: next },
        {
          onError: () =>
            showToast({
              status: 'error',
              message: localize('com_ui_custom_dashboard_save_failed'),
            }),
        },
      ),
    [saveDashboard, showToast, localize],
  );

  /** Stars a copy of the card (detached from its view turn) or unstars it */
  const toggleStar = useCallback(
    (card: ViewConfig) => {
      if (starredIds.has(card.id)) {
        save(cards.filter((starred) => starred.id !== card.id));
        return;
      }
      const { turnId: _turnId, ...copy } = card;
      save([...cards, copy]);
    },
    [cards, starredIds, save],
  );

  const updateCard = useCallback(
    (updated: ViewConfig) => save(cards.map((card) => (card.id === updated.id ? updated : card))),
    [cards, save],
  );

  const removeCard = useCallback(
    (id: string) => save(cards.filter((card) => card.id !== id)),
    [cards, save],
  );

  /** Re-runs every card on the server; the stored results replace what the dashboard shows */
  const refresh = useCallback(
    () =>
      refreshDashboard.mutate(undefined, {
        onError: () =>
          showToast({
            status: 'error',
            message: localize('com_ui_custom_dashboard_refresh_failed'),
          }),
      }),
    [refreshDashboard, showToast, localize],
  );

  return {
    cards,
    snapshots: data?.snapshots,
    refreshedAt: data?.refreshedAt,
    starredIds,
    isLoading,
    isRefreshing: refreshDashboard.isLoading,
    refresh,
    toggleStar,
    updateCard,
    removeCard,
  };
}
