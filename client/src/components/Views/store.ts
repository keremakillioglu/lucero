import { atom, atomFamily } from 'recoil';
import type { ViewConfig, ViewTurn } from './data';
import { atomWithLocalStorage } from '~/store/utils';

export const viewsState = atomWithLocalStorage<ViewConfig[]>('mcp-views:v1', []);

/** AI Suggest turns on the current view, newest first */
export const viewTurnsState = atomWithLocalStorage<ViewTurn[]>('mcp-views:turns:v1', []);

/** Id of the saved view currently loaded on the page; null for an unsaved view */
export const activeSavedViewIdState = atomWithLocalStorage<string | null>('mcp-views:active', null);

/** Per-card counter: each increment asks that card to run its tool call again */
export const cardRunRequestFamily = atomFamily<number, string>({
  key: 'mcpViewsCardRunRequest',
  default: 0,
});

/**
 * Id of the saved view whose server copy is on the page in this browser session. Not persisted,
 * so every page load reads the view from the server instead of trusting cached cards.
 */
export const loadedSavedViewIdState = atom<string | null>({
  key: 'mcpViewsLoadedSavedViewId',
  default: null,
});

/**
 * Bumped whenever a saved view is loaded or the page is cleared. Part of each card's React key, so
 * cards remount and re-run even when two saved views share card ids (e.g. a "Save as" copy).
 */
export const viewLoadGenerationState = atom<number>({
  key: 'mcpViewsLoadGeneration',
  default: 0,
});

/** Result the agent already fetched for a card during generation, shown instead of re-running */
export const cardSeedResultFamily = atomFamily<string | null, string>({
  key: 'mcpViewsCardSeedResult',
  default: null,
});

/** Card ids that should run as soon as they mount (after a suggestion or a load) */
export const autoRunViewIdsState = atom<string[]>({
  key: 'mcpViewsAutoRunIds',
  default: [],
});
