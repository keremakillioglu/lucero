import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { logger, createMethods, createModels } from '@librechat/data-schemas';
import type { Response } from 'express';
import type { ServerRequest } from '~/types';
import { createSavedViewsHandlers } from './saved';

logger.silent = true;

type MockRes = Response & { statusCode: number; body: unknown };

const userA = new mongoose.Types.ObjectId().toString();
const userB = new mongoose.Types.ObjectId().toString();
const card = {
  id: 'c1',
  serverName: 'warehouse',
  toolName: 'query',
  argsText: '{}',
  display: 'line',
};

let mongoServer: MongoMemoryServer;
let handlers: ReturnType<typeof createSavedViewsHandlers>;

type ReqOverrides = { params?: Record<string, string>; body?: Record<string, unknown> };

function mockReq(userId: string | undefined, overrides: ReqOverrides = {}): ServerRequest {
  return {
    user: userId ? { id: userId } : undefined,
    params: {},
    body: {},
    ...overrides,
  } as Partial<ServerRequest> as ServerRequest;
}

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

async function call(
  handler: (req: ServerRequest, res: Response) => Promise<Response>,
  req: ServerRequest,
): Promise<MockRes> {
  const res = mockRes();
  await handler(req, res);
  return res;
}

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri());
  createModels(mongoose);
  handlers = createSavedViewsHandlers(createMethods(mongoose));
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
});

beforeEach(async () => {
  await mongoose.models.SavedView.deleteMany({});
});

describe('saved views handlers', () => {
  it('rejects unauthenticated requests', async () => {
    expect((await call(handlers.listSavedViews, mockReq(undefined))).statusCode).toBe(401);
  });

  it('creates, lists, renames, replaces cards and deletes a view', async () => {
    const created = await call(
      handlers.createSavedView,
      mockReq(userA, { body: { name: ' Weekly UA ', cards: [card] } }),
    );
    expect(created.statusCode).toBe(201);
    const id = String((created.body as { _id: unknown })._id);

    const listed = await call(handlers.listSavedViews, mockReq(userA));
    expect((listed.body as Array<{ name: string }>).map((view) => view.name)).toEqual([
      'Weekly UA',
    ]);

    const renamed = await call(
      handlers.updateSavedView,
      mockReq(userA, { params: { id }, body: { name: 'Weekly UA v2' } }),
    );
    expect((renamed.body as { name: string; cards: unknown[] }).name).toBe('Weekly UA v2');
    expect((renamed.body as { cards: unknown[] }).cards).toHaveLength(1);

    const replaced = await call(
      handlers.updateSavedView,
      mockReq(userA, {
        params: { id },
        body: { cards: [card, { ...card, id: 'c2', display: 'bar' }] },
      }),
    );
    expect((replaced.body as { cards: unknown[] }).cards).toHaveLength(2);

    expect(
      (await call(handlers.deleteSavedView, mockReq(userA, { params: { id } }))).statusCode,
    ).toBe(200);
    expect((await call(handlers.listSavedViews, mockReq(userA))).body).toEqual([]);
  });

  it('keeps users isolated', async () => {
    const created = await call(
      handlers.createSavedView,
      mockReq(userA, { body: { name: 'Mine', cards: [] } }),
    );
    const id = String((created.body as { _id: unknown })._id);

    expect((await call(handlers.listSavedViews, mockReq(userB))).body).toEqual([]);
    const update = await call(
      handlers.updateSavedView,
      mockReq(userB, { params: { id }, body: { name: 'x' } }),
    );
    expect(update.statusCode).toBe(404);
    expect(
      (await call(handlers.deleteSavedView, mockReq(userB, { params: { id } }))).statusCode,
    ).toBe(404);
  });

  it.each([
    [{ name: '', cards: [] }, /name/],
    [{ name: 'x'.repeat(121), cards: [] }, /name/],
    [{ name: 'ok' }, /cards/],
    [{ name: 'ok', cards: [{ ...card, display: 'pie' }] }, /display/],
    [{ name: 'ok', cards: [{ ...card, serverName: 7 }] }, /serverName/],
  ])('rejects invalid input %#', async (body, message) => {
    const res = await call(handlers.createSavedView, mockReq(userA, { body }));
    expect(res.statusCode).toBe(400);
    expect((res.body as { message: string }).message).toMatch(message);
  });

  it('stores turns and links cards to them', async () => {
    const turn = {
      id: 't1',
      prompt: 'BabyLab overview',
      overview: 'Up 10%',
      createdAt: '2026-10-28T10:00:00Z',
    };
    const created = await call(
      handlers.createSavedView,
      mockReq(userA, {
        body: { name: 'Turns', cards: [{ ...card, turnId: 't1' }], turns: [turn] },
      }),
    );
    expect(created.statusCode).toBe(201);
    const body = created.body as { turns: unknown[]; cards: Array<{ turnId?: string }> };
    expect(body.turns).toEqual([turn]);
    expect(body.cards[0].turnId).toBe('t1');
  });

  it.each([
    [{ id: 't', createdAt: 'x' }],
    [{ id: 't', prompt: '', createdAt: 'x' }],
    [{ id: 't', prompt: 'p'.repeat(2001), createdAt: 'x' }],
  ])('rejects an invalid turn %#', async (turn) => {
    const res = await call(
      handlers.createSavedView,
      mockReq(userA, { body: { name: 'ok', cards: [], turns: [turn] } }),
    );
    expect(res.statusCode).toBe(400);
    expect((res.body as { message: string }).message).toMatch(/turns/);
  });

  it('saves and loads the starred-cards dashboard per user', async () => {
    expect((await call(handlers.getViewsDashboard, mockReq(userA))).body).toEqual({ cards: [] });

    const saved = await call(
      handlers.updateViewsDashboard,
      mockReq(userA, { body: { cards: [card, { ...card, id: 'c2' }] } }),
    );
    expect(saved.statusCode).toBe(200);
    expect((saved.body as { cards: unknown[] }).cards).toHaveLength(2);
    expect(
      ((await call(handlers.getViewsDashboard, mockReq(userA))).body as { cards: unknown[] }).cards,
    ).toHaveLength(2);
    expect((await call(handlers.getViewsDashboard, mockReq(userB))).body).toEqual({ cards: [] });
    expect((await call(handlers.listSavedViews, mockReq(userA))).body).toEqual([]);
  });

  it('validates dashboard cards', async () => {
    const res = await call(
      handlers.updateViewsDashboard,
      mockReq(userA, { body: { cards: [{ id: 'x' }] } }),
    );
    expect(res.statusCode).toBe(400);
    expect(
      (await call(handlers.updateViewsDashboard, mockReq(userA, { body: {} }))).statusCode,
    ).toBe(400);
  });

  it('requires a change on update', async () => {
    const res = await call(
      handlers.updateSavedView,
      mockReq(userA, { params: { id: 'x' }, body: {} }),
    );
    expect(res.statusCode).toBe(400);
  });
});
