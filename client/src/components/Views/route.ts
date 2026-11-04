import { useEffect } from 'react';
import { useRecoilState, useRecoilValue } from 'recoil';
import { useNavigate, useParams } from 'react-router-dom';
import type { TSavedView } from 'librechat-data-provider';
import { activeSavedViewIdState, loadedSavedViewIdState } from './store';

/** The page address of a saved view, or of an unsaved view when `id` is empty */
export const viewPath = (id?: string | null): string =>
  id ? `/views/${encodeURIComponent(id)}` : '/views';

type ViewRouteParams = {
  savedViews: TSavedView[];
  isLoading: boolean;
  loadView: (view: TSavedView) => void;
};

/**
 * Keeps `/views/:viewId` and the loaded view in sync. The address wins: it loads the server copy
 * of the view it names (once per page load, so charts always re-run), or falls back to `/views`
 * when that view no longer exists. Without an id in the address, a known active view (e.g. one
 * just created) is reflected into it.
 */
export default function useViewRoute({ savedViews, isLoading, loadView }: ViewRouteParams) {
  const { viewId } = useParams();
  const navigate = useNavigate();
  const [activeId, setActiveId] = useRecoilState(activeSavedViewIdState);
  const loadedId = useRecoilValue(loadedSavedViewIdState);

  useEffect(() => {
    if (isLoading) {
      return;
    }
    if (viewId) {
      const view = savedViews.find((saved) => saved._id === viewId);
      if (!view) {
        if (activeId === viewId) {
          setActiveId(null);
        }
        navigate(viewPath(null), { replace: true });
        return;
      }
      if (view._id !== loadedId) {
        loadView(view);
      }
      return;
    }
    if (!activeId) {
      return;
    }
    if (savedViews.some((saved) => saved._id === activeId)) {
      navigate(viewPath(activeId), { replace: true });
      return;
    }
    setActiveId(null);
  }, [viewId, activeId, loadedId, isLoading, savedViews, loadView, navigate, setActiveId]);
}
