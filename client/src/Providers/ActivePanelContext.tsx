import { createContext, useContext, useEffect, useMemo, ReactNode } from 'react';
import { atom, useAtom } from 'jotai';
import type { ComponentType } from 'react';

export const DEFAULT_PANEL = 'conversations';

/**
 * Held in memory for the life of the document rather than in Web Storage, so every entry
 * (a new visit, a reload, a tab opened from the app or duplicated) starts on chat history,
 * while the sidebar remounting its provider at the mobile breakpoint keeps the selection.
 */
export const activePanelAtom = atom<string>(DEFAULT_PANEL);

interface ActivePanelContextType {
  active: string;
  setActive: (id: string) => void;
}

const ActivePanelContext = createContext<ActivePanelContextType | undefined>(undefined);

export function ActivePanelProvider({ children }: { children: ReactNode }) {
  const [active, setActive] = useAtom(activePanelAtom);

  useEffect(() => {
    const onPageShow = (event: PageTransitionEvent) => {
      if (event.persisted) {
        setActive(DEFAULT_PANEL);
      }
    };
    window.addEventListener('pageshow', onPageShow);
    return () => window.removeEventListener('pageshow', onPageShow);
  }, [setActive]);

  const value = useMemo(() => ({ active, setActive }), [active, setActive]);

  return <ActivePanelContext.Provider value={value}>{children}</ActivePanelContext.Provider>;
}

export function useActivePanel() {
  const context = useContext(ActivePanelContext);
  if (context === undefined) {
    throw new Error('useActivePanel must be used within an ActivePanelProvider');
  }
  return context;
}

/**
 * Returns `active` when it matches a link that opens a panel, otherwise the first link's id.
 * A link with a click handler and no panel component (a page shortcut or an action) is never
 * the active panel, so selecting it keeps the previous panel in place.
 */
export function resolveActivePanel(
  active: string,
  links: { id: string; Component?: ComponentType; onClick?: unknown }[],
): string {
  const opensPanel = (link: { Component?: ComponentType; onClick?: unknown }) =>
    link.Component != null || link.onClick == null;
  if (links.length > 0 && links.some((l) => l.id === active && opensPanel(l))) {
    return active;
  }
  return links[0]?.id ?? active;
}
