import React from 'react';
import { RecoilRoot, useSetRecoilState } from 'recoil';
import { dataService } from 'librechat-data-provider';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { MCPServer } from 'librechat-data-provider';
import { cardRunRequestFamily, cardSeedResultFamily } from '../store';
import ViewCard from '../ViewCard';

jest.mock('librechat-data-provider', () => {
  const actual = jest.requireActual('librechat-data-provider');
  return { ...actual, dataService: { ...actual.dataService, callMCPTool: jest.fn() } };
});

jest.mock('@librechat/client', () => {
  const actual = jest.requireActual('@librechat/client');
  return { ...actual, useToastContext: () => ({ showToast: jest.fn() }) };
});

jest.mock('../Chart', () => ({ __esModule: true, default: () => null }));

const view = {
  id: 'card-1',
  serverName: 'warehouse',
  toolName: 'query',
  argsText: '{"sql":"select 1"}',
  display: 'table' as const,
};
const servers = [['warehouse', { tools: [{ name: 'query', description: '' }] }]] as Array<
  [string, MCPServer]
>;

function RunRequester() {
  const request = useSetRecoilState(cardRunRequestFamily(view.id));
  return <button type="button" data-testid="request-run" onClick={() => request((n) => n + 1)} />;
}

function renderCard(seedResult?: string) {
  const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <RecoilRoot
        initializeState={({ set }) => {
          if (seedResult != null) {
            set(cardSeedResultFamily(view.id), seedResult);
          }
        }}
      >
        <ViewCard view={view} servers={servers} onChange={jest.fn()} onRemove={jest.fn()} />
        <RunRequester />
      </RecoilRoot>
    </QueryClientProvider>,
  );
}

describe('ViewCard run requests', () => {
  beforeEach(() => {
    jest.mocked(dataService.callMCPTool).mockResolvedValue({
      success: true,
      serverName: 'warehouse',
      toolName: 'query',
      result: '{"rows":[{"a":1}]}',
    });
  });

  it('does not run on mount, and runs once per request', async () => {
    renderCard();
    expect(dataService.callMCPTool).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId('request-run'));
    await waitFor(() => expect(dataService.callMCPTool).toHaveBeenCalledTimes(1));
    expect(dataService.callMCPTool).toHaveBeenCalledWith({
      serverName: 'warehouse',
      toolName: 'query',
      toolArguments: { sql: 'select 1' },
    });

    fireEvent.click(screen.getByTestId('request-run'));
    await waitFor(() => expect(dataService.callMCPTool).toHaveBeenCalledTimes(2));
  });

  it('shows the result the agent already fetched without re-running the query', async () => {
    renderCard('{"rows":[{"app":"fontmaker","installs":42}]}');
    expect(await screen.findByText('fontmaker')).toBeInTheDocument();
    expect(dataService.callMCPTool).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId('request-run'));
    await waitFor(() => expect(dataService.callMCPTool).toHaveBeenCalledTimes(1));
  });
});
