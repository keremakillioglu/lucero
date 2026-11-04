import React from 'react';
import { RecoilRoot } from 'recoil';
import { dataService } from 'librechat-data-provider';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes, useNavigate } from 'react-router-dom';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { TSavedView, MCPServersResponse } from 'librechat-data-provider';
import ViewsPage from '../ViewsPage';

jest.mock('librechat-data-provider', () => {
  const actual = jest.requireActual('librechat-data-provider');
  return {
    ...actual,
    dataService: {
      ...actual.dataService,
      getMCPTools: jest.fn(),
      getSavedViews: jest.fn(),
      getViewsDashboard: jest.fn(),
      callMCPTool: jest.fn(),
    },
  };
});

jest.mock('@librechat/client', () => {
  const actual = jest.requireActual('@librechat/client');
  return { ...actual, useToastContext: () => ({ showToast: jest.fn() }) };
});

jest.mock('~/hooks/AuthContext', () => ({ useAuthContext: () => ({ token: 'test-token' }) }));

jest.mock('../Chart', () => ({ __esModule: true, default: () => null }));

/** Both views hold a card with this id, as "Save as" copies do */
const SHARED_CARD_ID = 'shared-card';

const savedView = (id: string, sql: string): TSavedView => ({
  _id: id,
  name: `View ${id}`,
  cards: [
    {
      id: SHARED_CARD_ID,
      serverName: 'warehouse',
      toolName: 'query',
      argsText: JSON.stringify({ sql }),
      display: 'table',
    },
  ],
  turns: [],
  createdAt: '1',
  updatedAt: '1',
});

const servers: MCPServersResponse = {
  servers: {
    warehouse: {
      name: 'warehouse',
      icon: '',
      authenticated: true,
      authConfig: [],
      tools: [{ name: 'query', pluginKey: 'query_mcp_warehouse', description: 'Run SQL' }],
    },
  },
};

const toolCall = (sql: string) => ({
  serverName: 'warehouse',
  toolName: 'query',
  toolArguments: { sql },
});

function Navigator() {
  const navigate = useNavigate();
  return <button type="button" data-testid="go-v2" onClick={() => navigate('/views/v2')} />;
}

function renderPage() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <RecoilRoot>
        <MemoryRouter initialEntries={['/views/v1']}>
          <Navigator />
          <Routes>
            {['/views', '/views/:viewId'].map((path) => (
              <Route key={path} path={path} element={<ViewsPage />} />
            ))}
          </Routes>
        </MemoryRouter>
      </RecoilRoot>
    </QueryClientProvider>,
  );
}

describe('ViewsPage switching between saved views', () => {
  beforeEach(() => {
    localStorage.clear();
    jest.mocked(dataService.getMCPTools).mockResolvedValue(servers);
    jest.mocked(dataService.getViewsDashboard).mockResolvedValue({ cards: [] });
    jest
      .mocked(dataService.getSavedViews)
      .mockResolvedValue([savedView('v1', 'select 1'), savedView('v2', 'select 2')]);
    jest.mocked(dataService.callMCPTool).mockResolvedValue({
      success: true,
      serverName: 'warehouse',
      toolName: 'query',
      result: '{"rows":[{"a":1}]}',
    });
  });

  it('re-runs the cards of the newly opened view even when both views share card ids', async () => {
    renderPage();

    await waitFor(() => expect(dataService.callMCPTool).toHaveBeenCalledWith(toolCall('select 1')));
    expect(screen.getByRole('heading', { level: 1 }).textContent).toContain('View v1');

    fireEvent.click(screen.getByTestId('go-v2'));

    await waitFor(() => expect(dataService.callMCPTool).toHaveBeenCalledWith(toolCall('select 2')));
    expect(screen.getByRole('heading', { level: 1 }).textContent).toContain('View v2');
    expect(dataService.callMCPTool).toHaveBeenCalledTimes(2);
  });
});
