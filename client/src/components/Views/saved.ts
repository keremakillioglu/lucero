import { useCallback, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { useRecoilCallback, useRecoilState, useSetRecoilState } from 'recoil';
import { useToastContext } from '@librechat/client';
import type { TSavedView } from 'librechat-data-provider';
import type { ViewConfig, ViewTurn } from './data';
import {
  useSavedViewsQuery,
  useCreateSavedViewMutation,
  useDeleteSavedViewMutation,
  useUpdateSavedViewMutation,
} from '~/data-provider';
import {
  viewsState,
  viewTurnsState,
  autoRunViewIdsState,
  activeSavedViewIdState,
  loadedSavedViewIdState,
  viewLoadGenerationState,
} from './store';
import { useLocalize } from '~/hooks';
import { sameCards, sameTurns } from './data';
import { viewPath } from './route';

const AUTO_NAME_LENGTH = 60;

/** Names an auto-saved view after the prompt that created it */
const nameFromPrompt = (prompt: string): string => {
  const flat = prompt.replace(/\s+/g, ' ').trim();
  return flat.length > AUTO_NAME_LENGTH ? `${flat.slice(0, AUTO_NAME_LENGTH - 1)}…` : flat;
};

/** Saved-view state and actions shared by the Views page and its sidebar panel */
export default function useSavedViews() {
  const localize = useLocalize();
  const navigate = useNavigate();
  const { showToast } = useToastContext();
  const [cards, setCards] = useRecoilState(viewsState);
  const [turns, setTurns] = useRecoilState(viewTurnsState);
  const [activeId, setActiveId] = useRecoilState(activeSavedViewIdState);
  const setAutoRunIds = useSetRecoilState(autoRunViewIdsState);
  const setLoadedId = useSetRecoilState(loadedSavedViewIdState);
  const setLoadGeneration = useSetRecoilState(viewLoadGenerationState);
  const { data: savedViews = [], isLoading } = useSavedViewsQuery();
  const createView = useCreateSavedViewMutation();
  const updateView = useUpdateSavedViewMutation();
  const deleteView = useDeleteSavedViewMutation();

  const activeView = useMemo(
    () => savedViews.find((view) => view._id === activeId) ?? null,
    [savedViews, activeId],
  );
  const hasUnsavedChanges = activeView
    ? !sameCards(cards, activeView.cards) || !sameTurns(turns, activeView.turns ?? [])
    : cards.length > 0 || turns.length > 0;

  const fail = useCallback(
    (key: 'com_ui_mcp_views_save_failed' | 'com_ui_mcp_views_delete_failed') =>
      showToast({ status: 'error', message: localize(key) }),
    [showToast, localize],
  );

  const bumpLoadGeneration = useCallback(
    () => setLoadGeneration((generation) => generation + 1),
    [setLoadGeneration],
  );

  /** Replaces the page with a saved view's server copy and remounts every card so it re-runs */
  const loadView = useCallback(
    (view: TSavedView) => {
      setCards(view.cards);
      setTurns(view.turns ?? []);
      setActiveId(view._id);
      setLoadedId(view._id);
      setAutoRunIds(view.cards.map((card) => card.id));
      bumpLoadGeneration();
    },
    [setCards, setTurns, setActiveId, setLoadedId, setAutoRunIds, bumpLoadGeneration],
  );

  const startNewView = useCallback(() => {
    setCards([]);
    setTurns([]);
    setActiveId(null);
    setLoadedId(null);
    setAutoRunIds([]);
    bumpLoadGeneration();
  }, [setCards, setTurns, setActiveId, setLoadedId, setAutoRunIds, bumpLoadGeneration]);

  /** Saves the page as a new view and moves the address to it, so the route keeps the copy loaded */
  const saveAsNew = useCallback(
    async (name: string): Promise<boolean> => {
      try {
        const created = await createView.mutateAsync({ name, cards, turns });
        setActiveId(created._id);
        setLoadedId(created._id);
        navigate(viewPath(created._id));
        showToast({ status: 'success', message: localize('com_ui_mcp_views_saved') });
        return true;
      } catch {
        fail('com_ui_mcp_views_save_failed');
        return false;
      }
    },
    [createView, cards, turns, setActiveId, setLoadedId, navigate, showToast, localize, fail],
  );

  const saveActive = useCallback(async () => {
    if (!activeView) {
      return;
    }
    try {
      await updateView.mutateAsync({ id: activeView._id, cards, turns });
      showToast({ status: 'success', message: localize('com_ui_mcp_views_saved') });
    } catch {
      fail('com_ui_mcp_views_save_failed');
    }
  }, [activeView, updateView, cards, turns, showToast, localize, fail]);

  /**
   * Persists the view right after a generation: updates the loaded view, or creates one named
   * after the prompt. Reads the active view at call time so a result arriving late still lands
   * on the right view.
   */
  const autoSave = useRecoilCallback(
    ({ snapshot }) =>
      async (nextCards: ViewConfig[], nextTurns: ViewTurn[], prompt: string) => {
        const currentId = snapshot.getLoadable(activeSavedViewIdState).getValue();
        try {
          if (currentId) {
            await updateView.mutateAsync({ id: currentId, cards: nextCards, turns: nextTurns });
            return;
          }
          const created = await createView.mutateAsync({
            name: nameFromPrompt(prompt),
            cards: nextCards,
            turns: nextTurns,
          });
          setActiveId(created._id);
          setLoadedId(created._id);
        } catch {
          fail('com_ui_mcp_views_save_failed');
        }
      },
    [updateView, createView, setActiveId, setLoadedId, fail],
  );

  /** Renames a saved view; a blank or unchanged name is ignored */
  const renameView = useCallback(
    async (id: string, name: string) => {
      const trimmed = name.trim();
      const current = savedViews.find((view) => view._id === id);
      if (!trimmed || !current || current.name === trimmed) {
        return;
      }
      try {
        await updateView.mutateAsync({ id, name: trimmed });
      } catch {
        fail('com_ui_mcp_views_save_failed');
      }
    },
    [savedViews, updateView, fail],
  );

  const removeView = useCallback(
    async (id: string) => {
      try {
        await deleteView.mutateAsync(id);
        if (id === activeId) {
          setActiveId(null);
        }
      } catch {
        fail('com_ui_mcp_views_delete_failed');
      }
    },
    [deleteView, activeId, setActiveId, fail],
  );

  return {
    savedViews,
    isLoading,
    activeView,
    hasUnsavedChanges,
    isSaving: createView.isLoading || updateView.isLoading,
    loadView,
    startNewView,
    saveAsNew,
    saveActive,
    autoSave,
    renameView,
    removeView,
  };
}
