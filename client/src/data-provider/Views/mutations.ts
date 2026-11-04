import { dataService, QueryKeys } from 'librechat-data-provider';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { UseMutationResult } from '@tanstack/react-query';
import type {
  TSavedView,
  TViewsDashboard,
  TSavedViewInput,
  TSavedViewUpdate,
} from 'librechat-data-provider';

const newestFirst = (views: TSavedView[]): TSavedView[] =>
  [...views].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));

export const useCreateSavedViewMutation = (): UseMutationResult<
  TSavedView,
  Error,
  TSavedViewInput
> => {
  const queryClient = useQueryClient();
  return useMutation((input: TSavedViewInput) => dataService.createSavedView(input), {
    onSuccess: (created) =>
      queryClient.setQueryData<TSavedView[]>([QueryKeys.savedViews], (views = []) => [
        created,
        ...views,
      ]),
  });
};

export const useUpdateSavedViewMutation = (): UseMutationResult<
  TSavedView,
  Error,
  TSavedViewUpdate
> => {
  const queryClient = useQueryClient();
  return useMutation((update: TSavedViewUpdate) => dataService.updateSavedView(update), {
    onSuccess: (updated) =>
      queryClient.setQueryData<TSavedView[]>([QueryKeys.savedViews], (views = []) =>
        newestFirst(views.map((view) => (view._id === updated._id ? updated : view))),
      ),
  });
};

export const useDeleteSavedViewMutation = (): UseMutationResult<
  { deleted: boolean },
  Error,
  string
> => {
  const queryClient = useQueryClient();
  return useMutation((id: string) => dataService.deleteSavedView(id), {
    onSuccess: (_result, id) =>
      queryClient.setQueryData<TSavedView[]>([QueryKeys.savedViews], (views = []) =>
        views.filter((view) => view._id !== id),
      ),
  });
};

/** Saves the dashboard optimistically so the star fills immediately, rolling back on failure */
export const useUpdateViewsDashboardMutation = (): UseMutationResult<
  TViewsDashboard,
  Error,
  TViewsDashboard,
  { previous?: TViewsDashboard }
> => {
  const queryClient = useQueryClient();
  return useMutation((dashboard: TViewsDashboard) => dataService.updateViewsDashboard(dashboard), {
    onMutate: async (dashboard) => {
      await queryClient.cancelQueries([QueryKeys.viewsDashboard]);
      const previous = queryClient.getQueryData<TViewsDashboard>([QueryKeys.viewsDashboard]);
      queryClient.setQueryData([QueryKeys.viewsDashboard], { ...previous, ...dashboard });
      return { previous };
    },
    onError: (_error, _dashboard, context) =>
      queryClient.setQueryData([QueryKeys.viewsDashboard], context?.previous),
    onSuccess: (saved) => queryClient.setQueryData([QueryKeys.viewsDashboard], saved),
  });
};

/** Re-runs every dashboard card on the server and stores the results */
export const useRefreshViewsDashboardMutation = (): UseMutationResult<
  TViewsDashboard,
  Error,
  void
> => {
  const queryClient = useQueryClient();
  return useMutation(() => dataService.refreshViewsDashboard(), {
    onSuccess: (refreshed) => queryClient.setQueryData([QueryKeys.viewsDashboard], refreshed),
  });
};
