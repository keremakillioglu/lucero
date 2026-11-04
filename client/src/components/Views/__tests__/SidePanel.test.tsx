import React from 'react';
import { RecoilRoot, useRecoilValue } from 'recoil';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { dataService } from 'librechat-data-provider';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import type { TSavedView } from 'librechat-data-provider';
import { activeSavedViewIdState, viewsState } from '../store';
import { groupCardsByTurn, sameCards, sameTurns } from '../data';
import SidePanel from '../SidePanel';

jest.mock('librechat-data-provider', () => {
  const actual = jest.requireActual('librechat-data-provider');
  return {
    ...actual,
    dataService: {
      ...actual.dataService,
      getSavedViews: jest.fn(),
      deleteSavedView: jest.fn(),
      updateSavedView: jest.fn(),
    },
  };
});

jest.mock('@librechat/client', () => {
  const actual = jest.requireActual('@librechat/client');
  return { ...actual, useToastContext: () => ({ showToast: jest.fn() }) };
});

const card = (id: string) => ({
  id,
  serverName: 'warehouse',
  toolName: 'query',
  argsText: '{}',
  display: 'line' as const,
});

const savedViews: TSavedView[] = [
  {
    _id: 'v1',
    name: 'Weekly UA',
    cards: [card('a'), card('b')],
    turns: [],
    createdAt: '1',
    updatedAt: '2',
  },
  { _id: 'v2', name: 'BabyLab', cards: [card('c')], turns: [], createdAt: '1', updatedAt: '1' },
];

function PageProbe() {
  const cards = useRecoilValue(viewsState);
  const activeId = useRecoilValue(activeSavedViewIdState);
  const { pathname } = useLocation();
  return (
    <>
      <output data-testid="probe">{`${activeId ?? 'none'}:${cards.map((c) => c.id).join(',')}`}</output>
      <output data-testid="path">{pathname}</output>
    </>
  );
}

function renderPanel() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <RecoilRoot>
        <MemoryRouter>
          <SidePanel />
          <PageProbe />
        </MemoryRouter>
      </RecoilRoot>
    </QueryClientProvider>,
  );
}

describe('Views SidePanel', () => {
  beforeEach(() => {
    localStorage.clear();
    jest.mocked(dataService.getSavedViews).mockResolvedValue(savedViews);
    jest.mocked(dataService.deleteSavedView).mockResolvedValue({ deleted: true });
    jest.mocked(dataService.updateSavedView).mockImplementation(async ({ id, name }) => ({
      ...savedViews.find((view) => view._id === id)!,
      name: name ?? '',
      updatedAt: '3',
    }));
  });

  it('lists saved views and opens one at its own address', async () => {
    renderPanel();
    fireEvent.click(await screen.findByText('Weekly UA'));
    expect(screen.getByTestId('path').textContent).toBe('/views/v1');
  });

  it('starts a new unsaved view', async () => {
    renderPanel();
    fireEvent.click(await screen.findByText('BabyLab'));
    fireEvent.click(screen.getByRole('button', { name: 'New view' }));
    expect(screen.getByTestId('probe').textContent).toBe('none:');
    expect(screen.getByTestId('path').textContent).toBe('/views');
  });

  it('renames a view inline on Enter', async () => {
    renderPanel();
    await screen.findByText('BabyLab');
    fireEvent.click(screen.getByRole('button', { name: 'Rename BabyLab' }));
    const input = screen.getByRole('textbox', { name: 'View name' });
    expect(input).toHaveValue('BabyLab');

    fireEvent.change(input, { target: { value: '  BabyLab growth  ' } });
    fireEvent.submit(input);
    await waitFor(() =>
      expect(dataService.updateSavedView).toHaveBeenCalledWith({
        id: 'v2',
        name: 'BabyLab growth',
      }),
    );
    expect(await screen.findByText('BabyLab growth')).toBeInTheDocument();
  });

  it('cancels a rename on Escape and ignores blank names', async () => {
    renderPanel();
    await screen.findByText('BabyLab');
    fireEvent.click(screen.getByRole('button', { name: 'Rename BabyLab' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'View name' }), {
      target: { value: 'Nope' },
    });
    fireEvent.keyDown(screen.getByRole('textbox', { name: 'View name' }), { key: 'Escape' });
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    expect(screen.getByText('BabyLab')).toBeInTheDocument();

    fireEvent.doubleClick(screen.getByText('BabyLab'));
    const input = screen.getByRole('textbox', { name: 'View name' });
    fireEvent.change(input, { target: { value: '   ' } });
    fireEvent.submit(input);
    expect(dataService.updateSavedView).not.toHaveBeenCalled();
  });

  it('deletes only after confirming', async () => {
    renderPanel();
    await screen.findByText('BabyLab');
    fireEvent.click(screen.getByRole('button', { name: 'Delete BabyLab' }));
    expect(dataService.deleteSavedView).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Confirm delete BabyLab' }));
    await waitFor(() => expect(screen.queryByText('BabyLab')).not.toBeInTheDocument());
    expect(dataService.deleteSavedView).toHaveBeenCalledWith('v2');
  });
});

describe('sameCards', () => {
  it('compares cards by content and order, ignoring key order and absent fields', () => {
    const reordered = {
      display: 'line' as const,
      argsText: '{}',
      toolName: 'query',
      serverName: 'warehouse',
      id: 'a',
    };
    expect(sameCards([card('a')], [reordered])).toBe(true);
    expect(sameCards([card('a'), card('b')], [card('b'), card('a')])).toBe(false);
    expect(sameCards([card('a')], [{ ...card('a'), title: 'x' }])).toBe(false);
  });
});

describe('turn helpers', () => {
  const turn = (id: string) => ({ id, prompt: `prompt ${id}`, createdAt: '2026-10-28T10:00:00Z' });

  it('groups cards by turn in one pass, treating unknown turns as manual', () => {
    const cards = [
      { ...card('a'), turnId: 't2' },
      card('m'),
      { ...card('b'), turnId: 't1' },
      { ...card('c'), turnId: 't2' },
      { ...card('x'), turnId: 'gone' },
    ];
    const groups = groupCardsByTurn(cards, [turn('t2'), turn('t1')]);
    expect(groups.manual.map((c) => c.id)).toEqual(['m', 'x']);
    expect(groups.byTurn.get('t2')?.map((c) => c.id)).toEqual(['a', 'c']);
    expect(groups.byTurn.get('t1')?.map((c) => c.id)).toEqual(['b']);
  });

  it('compares turns by content and order', () => {
    expect(sameTurns([turn('t1')], [{ ...turn('t1') }])).toBe(true);
    expect(sameTurns([turn('t1')], [{ ...turn('t1'), overview: 'new' }])).toBe(false);
    expect(sameTurns([turn('t1'), turn('t2')], [turn('t2'), turn('t1')])).toBe(false);
  });
});
