import React from 'react';
import { RecoilRoot, useRecoilValue } from 'recoil';
import { dataService } from 'librechat-data-provider';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen, waitFor } from '@testing-library/react';
import type { TSavedView, TSavedViewInput } from 'librechat-data-provider';
import { activeSavedViewIdState, viewLoadGenerationState } from '../store';
import useSavedViews from '../saved';

jest.mock('librechat-data-provider', () => {
  const actual = jest.requireActual('librechat-data-provider');
  return {
    ...actual,
    dataService: {
      ...actual.dataService,
      getSavedViews: jest.fn(),
      createSavedView: jest.fn(),
      updateSavedView: jest.fn(),
    },
  };
});

jest.mock('@librechat/client', () => {
  const actual = jest.requireActual('@librechat/client');
  return { ...actual, useToastContext: () => ({ showToast: jest.fn() }) };
});

const card = {
  id: 'c1',
  serverName: 'warehouse',
  toolName: 'query',
  argsText: '{}',
  display: 'line' as const,
};
const turn = { id: 't1', prompt: 'p', createdAt: '2026-10-28T10:00:00Z' };

let actions: ReturnType<typeof useSavedViews>;

function Harness() {
  actions = useSavedViews();
  return (
    <>
      <output data-testid="active">{useRecoilValue(activeSavedViewIdState) ?? 'none'}</output>
      <output data-testid="generation">{useRecoilValue(viewLoadGenerationState)}</output>
      <output data-testid="path">{useLocation().pathname}</output>
    </>
  );
}

function renderHarness() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <RecoilRoot>
        <MemoryRouter initialEntries={['/views/v1']}>
          <Harness />
        </MemoryRouter>
      </RecoilRoot>
    </QueryClientProvider>,
  );
}

const savedView = (id: string): TSavedView => ({
  _id: id,
  name: id,
  cards: [card],
  turns: [turn],
  createdAt: '1',
  updatedAt: '1',
});

describe('useSavedViews', () => {
  beforeEach(() => {
    localStorage.clear();
    jest.mocked(dataService.getSavedViews).mockResolvedValue([]);
    jest.mocked(dataService.createSavedView).mockImplementation(
      async (input: TSavedViewInput): Promise<TSavedView> => ({
        _id: 'new-view',
        ...input,
        turns: input.turns ?? [],
        createdAt: '1',
        updatedAt: '1',
      }),
    );
    jest.mocked(dataService.updateSavedView).mockImplementation(async ({ id, ...rest }) => ({
      _id: id,
      name: 'x',
      cards: rest.cards ?? [],
      turns: rest.turns ?? [],
      createdAt: '1',
      updatedAt: '2',
    }));
  });

  it('creates a view named after the prompt, then updates that same view', async () => {
    renderHarness();
    const longPrompt = `Show   BabyLab ${'revenue '.repeat(20)}`;

    await act(() => actions.autoSave([card], [turn], longPrompt));
    const created = jest.mocked(dataService.createSavedView).mock.calls[0][0];
    expect(created.name.length).toBeLessThanOrEqual(60);
    expect(created.name.startsWith('Show BabyLab revenue')).toBe(true);
    expect(created.name.endsWith('…')).toBe(true);
    expect(created.turns).toEqual([turn]);
    await waitFor(() => expect(screen.getByTestId('active').textContent).toBe('new-view'));

    await act(() => actions.autoSave([card, card], [turn, turn], 'second prompt'));
    expect(dataService.createSavedView).toHaveBeenCalledTimes(1);
    expect(dataService.updateSavedView).toHaveBeenCalledWith({
      id: 'new-view',
      cards: [card, card],
      turns: [turn, turn],
    });
  });

  it('moves the address to the copy created by saveAsNew', async () => {
    renderHarness();

    await act(() => actions.saveAsNew('Copy'));

    expect(screen.getByTestId('active').textContent).toBe('new-view');
    expect(screen.getByTestId('path').textContent).toBe('/views/new-view');
  });

  it('bumps the load generation on every load so cards remount even with shared ids', async () => {
    renderHarness();
    expect(screen.getByTestId('generation').textContent).toBe('0');

    act(() => actions.loadView(savedView('v1')));
    expect(screen.getByTestId('generation').textContent).toBe('1');

    act(() => actions.loadView(savedView('v2')));
    expect(screen.getByTestId('generation').textContent).toBe('2');

    act(() => actions.startNewView());
    expect(screen.getByTestId('generation').textContent).toBe('3');
  });
});
