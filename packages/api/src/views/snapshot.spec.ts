import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import {
  logger,
  createMethods,
  createModels,
  MAX_SNAPSHOT_RESULT_LENGTH,
} from '@librechat/data-schemas';
import type { MCPViewCard, MCPToolCallParams } from 'librechat-data-provider';
import type { Response } from 'express';
import type { ServerRequest } from '~/types';
import {
  createDashboardRefreshHandler,
  createDashboardSnapshots,
  parseCardArguments,
} from './snapshot';

logger.silent = true;

type MockRes = Response & { statusCode: number; body: unknown };

const userId = new mongoose.Types.ObjectId().toString();

const card = (id: string, overrides: Partial<MCPViewCard> = {}): MCPViewCard => ({
  id,
  serverName: 'warehouse',
  toolName: 'query',
  argsText: JSON.stringify({ sql: `select '${id}'` }),
  display: 'table',
  ...overrides,
});

/** Resolves each call with its SQL after a tick, so concurrent runs overlap like real tool calls */
const echoSql = async (call: MCPToolCallParams): Promise<string> => {
  await new Promise((resolve) => setImmediate(resolve));
  return `result for ${String(call.toolArguments?.sql)}`;
};

function mockRes(): MockRes {
  const res = { statusCode: 200, body: undefined } as MockRes;
  res.status = ((code: number) => {
    res.statusCode = code;
    return res;
  }) as MockRes['status'];
  res.json = ((data: unknown) => {
    res.body = data;
    return res;
  }) as MockRes['json'];
  return res;
}

let mongoServer: MongoMemoryServer;
let methods: ReturnType<typeof createMethods>;

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri());
  createModels(mongoose);
  methods = createMethods(mongoose);
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
});

beforeEach(async () => {
  await mongoose.models.SavedView.deleteMany({});
});

const snapshotsFor = () => createDashboardSnapshots(methods);

describe('parseCardArguments', () => {
  it('parses an object, and falls back to no arguments for blank, invalid or non-object text', () => {
    expect(parseCardArguments('{"sql":"select 1"}')).toEqual({ sql: 'select 1' });
    expect(parseCardArguments('   ')).toEqual({});
    expect(parseCardArguments('{not json')).toEqual({});
    expect(parseCardArguments('[1,2]')).toEqual({});
  });
});

describe('createDashboardSnapshots', () => {
  it('stores one snapshot per card with the tool result and a refresh time', async () => {
    await methods.saveViewsDashboard(userId, [card('a'), card('b')]);
    const runCard = jest.fn(echoSql);

    const before = Date.now();
    const dashboard = await snapshotsFor().refresh(userId, runCard);

    expect(runCard).toHaveBeenCalledTimes(2);
    expect(runCard).toHaveBeenCalledWith({
      serverName: 'warehouse',
      toolName: 'query',
      toolArguments: { sql: "select 'a'" },
    });
    expect(dashboard.snapshots?.a.result).toBe("result for select 'a'");
    expect(dashboard.snapshots?.b.result).toBe("result for select 'b'");
    expect(Date.parse(dashboard.snapshots?.a.fetchedAt ?? '')).toBeGreaterThanOrEqual(before);
    expect(Date.parse(dashboard.refreshedAt ?? '')).toBeGreaterThanOrEqual(before);

    const stored = await methods.getViewsDashboard(userId);
    expect(stored.snapshots).toEqual(dashboard.snapshots);
    expect(stored.refreshedAt).toBe(dashboard.refreshedAt);
  });

  it('keeps the previous snapshot of a card whose tool call fails', async () => {
    await methods.saveViewsDashboard(userId, [card('ok'), card('flaky')]);
    const snapshots = snapshotsFor();
    await snapshots.refresh(userId, echoSql);
    const first = await methods.getViewsDashboard(userId);

    const dashboard = await snapshots.refresh(userId, async (call) => {
      if (String(call.toolArguments?.sql).includes('flaky')) {
        throw new Error('warehouse unavailable');
      }
      return 'fresh';
    });

    expect(dashboard.snapshots?.ok.result).toBe('fresh');
    expect(dashboard.snapshots?.flaky).toEqual(first.snapshots?.flaky);
  });

  it('skips cards without a tool and results too large to store', async () => {
    await methods.saveViewsDashboard(userId, [
      card('empty', { toolName: '' }),
      card('huge'),
      card('fine'),
    ]);
    const runCard = jest.fn(async (call: MCPToolCallParams) =>
      String(call.toolArguments?.sql).includes('huge')
        ? 'x'.repeat(MAX_SNAPSHOT_RESULT_LENGTH + 1)
        : 'ok',
    );

    const dashboard = await snapshotsFor().refresh(userId, runCard);

    expect(runCard).toHaveBeenCalledTimes(2);
    expect(Object.keys(dashboard.snapshots ?? {})).toEqual(['fine']);
  });

  it('drops snapshots of cards no longer on the dashboard', async () => {
    await methods.saveViewsDashboard(userId, [card('a'), card('b')]);
    const snapshots = snapshotsFor();
    await snapshots.refresh(userId, echoSql);

    await methods.saveViewsDashboard(userId, [card('b')]);
    const dashboard = await snapshots.refresh(userId, echoSql);

    expect(Object.keys(dashboard.snapshots ?? {})).toEqual(['b']);
  });

  it('shares one run between concurrent refreshes of the same user', async () => {
    await methods.saveViewsDashboard(userId, [card('a'), card('b'), card('c')]);
    const runCard = jest.fn(echoSql);
    const snapshots = snapshotsFor();

    const [first, second] = await Promise.all([
      snapshots.refresh(userId, runCard),
      snapshots.refresh(userId, runCard),
    ]);

    expect(runCard).toHaveBeenCalledTimes(3);
    expect(second).toEqual(first);

    await snapshots.refresh(userId, runCard);
    expect(runCard).toHaveBeenCalledTimes(6);
  });

  it('returns the dashboard untouched when there is nothing to refresh', async () => {
    const runCard = jest.fn(echoSql);

    expect(await snapshotsFor().refresh(userId, runCard)).toEqual({ cards: [] });
    expect(runCard).not.toHaveBeenCalled();
  });
});

describe('createDashboardRefreshHandler', () => {
  const handlerFor = (runCard: (call: MCPToolCallParams) => Promise<string>) =>
    createDashboardRefreshHandler({
      refresh: snapshotsFor().refresh,
      runCardFor: () => runCard,
    });

  const request = (user?: { id: string }) => ({ user }) as Partial<ServerRequest> as ServerRequest;

  it('rejects anonymous requests', async () => {
    const res = mockRes();
    await handlerFor(echoSql)(request(), res);
    expect(res.statusCode).toBe(401);
  });

  it('responds with the refreshed dashboard', async () => {
    await methods.saveViewsDashboard(userId, [card('a')]);
    const res = mockRes();

    await handlerFor(echoSql)(request({ id: userId }), res);

    expect(res.statusCode).toBe(200);
    const body = res.body as { snapshots?: Record<string, { result: string }> };
    expect(body.snapshots?.a.result).toBe("result for select 'a'");
  });

  it('reports a failure to store the refresh', async () => {
    await methods.saveViewsDashboard(userId, [card('a')]);
    const res = mockRes();
    const handler = createDashboardRefreshHandler({
      refresh: createDashboardSnapshots({
        ...methods,
        saveViewsDashboardSnapshots: async () => {
          throw new Error('db down');
        },
      }).refresh,
      runCardFor: () => echoSql,
    });

    await handler(request({ id: userId }), res);

    expect(res.statusCode).toBe(500);
  });
});
