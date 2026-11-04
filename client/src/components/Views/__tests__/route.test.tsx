import React from 'react';
import { RecoilRoot, useRecoilValue, useSetRecoilState } from 'recoil';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import type { TSavedView } from 'librechat-data-provider';
import { activeSavedViewIdState, loadedSavedViewIdState } from '../store';
import useViewRoute, { viewPath } from '../route';

const view = (id: string): TSavedView => ({
  _id: id,
  name: id,
  cards: [],
  turns: [],
  createdAt: '1',
  updatedAt: '1',
});

function Harness({ savedViews, loadView }: { savedViews: TSavedView[]; loadView: jest.Mock }) {
  const setActive = useSetRecoilState(activeSavedViewIdState);
  const setLoaded = useSetRecoilState(loadedSavedViewIdState);
  const activeId = useRecoilValue(activeSavedViewIdState);
  useViewRoute({
    savedViews,
    isLoading: false,
    loadView: (v) => {
      loadView(v);
      setActive(v._id);
      setLoaded(v._id);
    },
  });
  return (
    <>
      <output data-testid="path">{useLocation().pathname}</output>
      <output data-testid="active">{activeId ?? 'none'}</output>
      <button type="button" data-testid="select-v2" onClick={() => setActive('v2')} />
    </>
  );
}

function renderAt(
  path: string,
  savedViews: TSavedView[],
  loadView = jest.fn(),
  cachedActiveId?: string,
) {
  render(
    <RecoilRoot
      initializeState={({ set }) => {
        if (cachedActiveId) {
          set(activeSavedViewIdState, cachedActiveId);
        }
      }}
    >
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          {['/views', '/views/:viewId'].map((routePath) => (
            <Route
              key={routePath}
              path={routePath}
              element={<Harness savedViews={savedViews} loadView={loadView} />}
            />
          ))}
        </Routes>
      </MemoryRouter>
    </RecoilRoot>,
  );
  return loadView;
}

describe('useViewRoute', () => {
  beforeEach(() => localStorage.clear());

  it('builds view addresses', () => {
    expect(viewPath('abc')).toBe('/views/abc');
    expect(viewPath(null)).toBe('/views');
  });

  it('loads the view named in the address', async () => {
    const loadView = renderAt('/views/v1', [view('v1'), view('v2')]);
    await waitFor(() => expect(loadView).toHaveBeenCalledWith(view('v1')));
    expect(screen.getByTestId('active').textContent).toBe('v1');
  });

  it('reloads the server copy on a fresh page load even when the view is the cached active one', async () => {
    const loadView = renderAt('/views/v1', [view('v1')], jest.fn(), 'v1');
    await waitFor(() => expect(loadView).toHaveBeenCalledTimes(1));
    expect(loadView).toHaveBeenCalledWith(view('v1'));
  });

  it('falls back to /views for an unknown id', async () => {
    const loadView = renderAt('/views/gone', [view('v1')]);
    await waitFor(() => expect(screen.getByTestId('path').textContent).toBe('/views'));
    expect(loadView).not.toHaveBeenCalled();
  });

  it('moves the address to a view that becomes active, e.g. after saving', async () => {
    renderAt('/views', [view('v1'), view('v2')]);
    fireEvent.click(screen.getByTestId('select-v2'));
    await waitFor(() => expect(screen.getByTestId('path').textContent).toBe('/views/v2'));
  });
});
