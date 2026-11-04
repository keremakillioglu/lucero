import { useQuery } from '@tanstack/react-query';
import { dataService, QueryKeys } from 'librechat-data-provider';
import type { UseQueryOptions, QueryObserverResult } from '@tanstack/react-query';
import type { TSavedView, TViewsDashboard } from 'librechat-data-provider';

/** The current user's saved views, newest first */
export const useSavedViewsQuery = (
  config?: UseQueryOptions<TSavedView[]>,
): QueryObserverResult<TSavedView[]> =>
  useQuery<TSavedView[]>([QueryKeys.savedViews], () => dataService.getSavedViews(), {
    refetchOnWindowFocus: false,
    ...config,
  });

/** The user's custom dashboard (starred view cards) */
export const useViewsDashboardQuery = (
  config?: UseQueryOptions<TViewsDashboard>,
): QueryObserverResult<TViewsDashboard> =>
  useQuery<TViewsDashboard>([QueryKeys.viewsDashboard], () => dataService.getViewsDashboard(), {
    refetchOnWindowFocus: false,
    ...config,
  });
