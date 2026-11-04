import React from 'react';
import { RecoilRoot } from 'recoil';
import { MemoryRouter } from 'react-router-dom';
import { dataService } from 'librechat-data-provider';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { MCPServer, TViewsDashboard } from 'librechat-data-provider';
import ViewCard from '~/components/Views/ViewCard';
import DashboardPage from '../DashboardPage';
import useStarredCards from '../starred';

jest.mock('librechat-data-provider', () => {
  const actual = jest.requireActual('librechat-data-provider');
  return {
    ...actual,
    dataService: {
      ...actual.dataService,
      getViewsDashboard: jest.fn(),
      updateViewsDashboard: jest.fn(),
      refreshViewsDashboard: jest.fn(),
      callMCPTool: jest.fn(),
      getMCPTools: jest.fn(),
    },
  };
});

jest.mock('@librechat/client', () => {
  const actual = jest.requireActual('@librechat/client');
  return { ...actual, useToastContext: () => ({ showToast: jest.fn() }) };
});

jest.mock('~/components/Views/Chart', () => ({ __esModule: true, default: () => null }));

const card = (id: string) => ({
  id,
  serverName: 'warehouse',
  toolName: 'query',
  argsText: '{}',
  display: 'table' as const,
});
const snapshot = (value: number, fetchedAt: string) => ({
  result: `{"rows":[{"a":${value}}]}`,
  fetchedAt,
});
const servers = [['warehouse', { tools: [{ name: 'query', description: '' }] }]] as Array<
  [string, MCPServer]
>;

function wrap(ui: React.ReactElement) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <RecoilRoot>
        <MemoryRouter>{ui}</MemoryRouter>
      </RecoilRoot>
    </QueryClientProvider>,
  );
}

function StarHarness() {
  const { starredIds, toggleStar } = useStarredCards();
  const view = { ...card('v1'), turnId: 't1' };
  return (
    <ViewCard
      view={view}
      servers={servers}
      onChange={jest.fn()}
      onRemove={jest.fn()}
      starred={starredIds.has(view.id)}
      onToggleStar={toggleStar}
    />
  );
}

beforeEach(() => {
  jest.mocked(dataService.getViewsDashboard).mockResolvedValue({ cards: [] });
  jest
    .mocked(dataService.updateViewsDashboard)
    .mockImplementation(async (dashboard: TViewsDashboard) => dashboard);
  jest.mocked(dataService.callMCPTool).mockResolvedValue({
    success: true,
    serverName: 'warehouse',
    toolName: 'query',
    result: '{"rows":[{"a":1}]}',
  });
});

describe('starring view cards', () => {
  it('stars a detached copy, fills the star, and unstars it again', async () => {
    wrap(<StarHarness />);
    const star = await screen.findByRole('button', { name: 'Add to dashboard' });
    expect(star).toHaveAttribute('aria-pressed', 'false');

    fireEvent.click(star);
    await waitFor(() =>
      expect(dataService.updateViewsDashboard).toHaveBeenCalledWith({ cards: [card('v1')] }),
    );
    const filled = await screen.findByRole('button', { name: 'Remove from dashboard' });
    expect(filled).toHaveAttribute('aria-pressed', 'true');

    fireEvent.click(filled);
    await waitFor(() =>
      expect(dataService.updateViewsDashboard).toHaveBeenLastCalledWith({ cards: [] }),
    );
  });
});

describe('DashboardPage', () => {
  it('shows an empty state when nothing is starred', async () => {
    wrap(<DashboardPage />);
    expect(
      await screen.findByText('No charts yet. Star a chart in Views to add it here.'),
    ).toBeInTheDocument();
  });

  it('runs every chart live on load when nothing is stored for it', async () => {
    jest.mocked(dataService.getViewsDashboard).mockResolvedValue({ cards: [card('a'), card('b')] });
    wrap(<DashboardPage />);
    await waitFor(() => expect(dataService.callMCPTool).toHaveBeenCalledTimes(2));
  });

  it('shows stored results without re-running, and runs cards without one live', async () => {
    jest.mocked(dataService.getViewsDashboard).mockResolvedValue({
      cards: [card('stored'), card('live')],
      snapshots: { stored: snapshot(42, '2026-11-01T10:00:00Z') },
      refreshedAt: '2026-11-01T10:00:00Z',
    });
    wrap(<DashboardPage />);

    expect(await screen.findByText('42')).toBeInTheDocument();
    expect(screen.getByText(/^Data as of /)).toBeInTheDocument();
    await waitFor(() => expect(dataService.callMCPTool).toHaveBeenCalledTimes(1));
  });

  it('re-runs every card on the server when Refresh is pressed and shows the new results', async () => {
    jest.mocked(dataService.getViewsDashboard).mockResolvedValue({
      cards: [card('a')],
      snapshots: { a: snapshot(1, '2026-11-01T10:00:00Z') },
      refreshedAt: '2026-11-01T10:00:00Z',
    });
    jest.mocked(dataService.refreshViewsDashboard).mockResolvedValue({
      cards: [card('a')],
      snapshots: { a: snapshot(2, '2026-11-01T11:00:00Z') },
      refreshedAt: '2026-11-01T11:00:00Z',
    });
    wrap(<DashboardPage />);
    expect(await screen.findByText('1')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));

    expect(await screen.findByText('2')).toBeInTheDocument();
    expect(screen.queryByText('1')).not.toBeInTheDocument();
    expect(dataService.refreshViewsDashboard).toHaveBeenCalledTimes(1);
    expect(dataService.callMCPTool).not.toHaveBeenCalled();
  });
});
