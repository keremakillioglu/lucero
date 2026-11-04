/**
 * Exercises `ConnectionsRepository.get` against a real Streamable HTTP MCP server with the real
 * connection factory and MCPConnection, reproducing the burst a Views page with many cards
 * sends when no app-level connection exists yet.
 */
import type { TestServer } from './helpers/mcpTestServer';
import type * as t from '~/mcp/types';
import { ConnectionsRepository } from '~/mcp/ConnectionsRepository';
import { startMCPServer } from './helpers/mcpTestServer';
import { MCPConnection } from '~/mcp/connection';

jest.mock('@librechat/data-schemas', () => {
  const actual = jest.requireActual('@librechat/data-schemas');
  return {
    ...actual,
    logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
  };
});

const mockServerConfigs: Record<string, t.ParsedServerConfig> = {};

jest.mock('~/mcp/registry/MCPServersRegistry', () => ({
  MCPServersRegistry: {
    getInstance: () => ({
      getServerConfig: async (serverName: string) => mockServerConfigs[serverName],
      resolveAllowlists: async () => ({
        allowedDomains: null,
        allowedAddresses: null,
        useSSRFProtection: false,
      }),
    }),
  },
}));

const BURST_SIZE = 18;

type BreakerState = { cycleCount: number; cooldownUntil: number };
const breakerFor = (serverName: string): BreakerState | undefined =>
  MCPConnection['circuitBreakers'].get(serverName);

describe('ConnectionsRepository against a real MCP server', () => {
  let server: TestServer;
  let repository: ConnectionsRepository;

  beforeAll(async () => {
    server = await startMCPServer();
    mockServerConfigs.warehouse = {
      type: 'streamable-http',
      url: server.url,
      initTimeout: 5000,
    } as t.ParsedServerConfig;
    repository = new ConnectionsRepository(undefined);
  });

  afterAll(async () => {
    await Promise.all(repository.disconnectAll());
    await server.close();
    MCPConnection['circuitBreakers'].clear();
  });

  it('serves a burst of concurrent callers from one connection without tripping the breaker', async () => {
    const connections = await Promise.all(
      Array.from({ length: BURST_SIZE }, () => repository.get('warehouse')),
    );

    const [connection] = connections;
    expect(connection).toBeInstanceOf(MCPConnection);
    expect(new Set(connections).size).toBe(1);
    expect(repository.getConnectionCount()).toBe(1);
    expect(await connection?.isConnected()).toBe(true);

    const breaker = breakerFor('warehouse');
    expect(breaker?.cooldownUntil ?? 0).toBe(0);
    expect(breaker?.cycleCount ?? 0).toBeLessThanOrEqual(1);

    const tools = await connection?.fetchTools();
    expect(tools?.map((tool) => tool.name)).toEqual(['echo']);
  });

  it('reuses the established connection for later callers', async () => {
    const [established] = await Promise.all([
      repository.get('warehouse'),
      repository.get('warehouse'),
    ]);

    expect(established).toBe(await repository.get('warehouse'));
    expect(repository.getConnectionCount()).toBe(1);
  });
});
