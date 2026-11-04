import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import type { MCPViewCard } from 'librechat-data-provider';
import { createSavedViewMethods, MAX_SAVED_VIEWS } from './savedView';
import { MAX_SAVED_VIEW_CARDS } from '~/schema/savedView';
import { logger, createModels } from '..';

logger.silent = true;

let SavedView: mongoose.Model<unknown>;
let methods: ReturnType<typeof createSavedViewMethods>;
let mongoServer: MongoMemoryServer;

const userA = new mongoose.Types.ObjectId().toString();
const userB = new mongoose.Types.ObjectId().toString();

const card = (id: string, overrides: Partial<MCPViewCard> = {}): MCPViewCard => ({
  id,
  serverName: 'warehouse',
  toolName: 'query',
  argsText: '{"sql":"select 1"}',
  display: 'line',
  ...overrides,
});

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri());
  createModels(mongoose);
  SavedView = mongoose.models.SavedView;
  await SavedView.syncIndexes();
  methods = createSavedViewMethods(mongoose);
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
});

beforeEach(async () => {
  await SavedView.deleteMany({});
});

describe('createSavedView / getSavedViews', () => {
  test('round-trips name and cards, newest first, scoped to the user', async () => {
    const first = await methods.createSavedView({
      userId: userA,
      name: 'BabyLab',
      cards: [card('a')],
    });
    const second = await methods.createSavedView({
      userId: userA,
      name: '  UA overview  ',
      cards: [card('b', { title: 'Spend', yKeys: ['cost'], xKey: 'date' })],
    });
    await methods.createSavedView({ userId: userB, name: 'Other user', cards: [] });

    expect(first.cards).toEqual([card('a')]);
    const views = await methods.getSavedViews(userA);
    expect(views.map((view) => view.name)).toEqual(['UA overview', 'BabyLab']);
    expect(views[0]._id.toString()).toBe(second._id.toString());
    expect(views[0].cards[0]).toEqual(card('b', { title: 'Spend', yKeys: ['cost'], xKey: 'date' }));
  });

  test('rejects an invalid display and more cards than allowed', async () => {
    await expect(
      methods.createSavedView({
        userId: userA,
        name: 'bad',
        cards: [card('a', { display: 'pie' as MCPViewCard['display'] })],
      }),
    ).rejects.toThrow();
    const tooMany = Array.from({ length: MAX_SAVED_VIEW_CARDS + 1 }, (_, i) => card(String(i)));
    await expect(
      methods.createSavedView({ userId: userA, name: 'big', cards: tooMany }),
    ).rejects.toThrow(/at most/);
  });

  test('enforces the per-user cap', async () => {
    await SavedView.insertMany(
      Array.from({ length: MAX_SAVED_VIEWS }, (_, i) => ({
        user: userA,
        name: `v${i}`,
        cards: [],
      })),
    );
    await expect(
      methods.createSavedView({ userId: userA, name: 'one more', cards: [] }),
    ).rejects.toMatchObject({
      code: 'MAX_SAVED_VIEWS_EXCEEDED',
    });
    await expect(
      methods.createSavedView({ userId: userB, name: 'fine', cards: [] }),
    ).resolves.toBeDefined();
  });
});

describe('turns', () => {
  test('round-trips turns with their cards and replaces them on update', async () => {
    const turn = {
      id: 't1',
      prompt: 'BabyLab overview',
      overview: 'Installs are up.',
      createdAt: '2026-10-28T10:00:00.000Z',
    };
    const view = await methods.createSavedView({
      userId: userA,
      name: 'Turns',
      cards: [card('a', { turnId: 't1' }), card('m')],
      turns: [turn],
    });
    expect(view.turns).toEqual([turn]);
    expect(view.cards[0].turnId).toBe('t1');
    expect(view.cards[1].turnId).toBeUndefined();

    const next = { id: 't2', prompt: 'Add revenue', createdAt: '2026-10-28T11:00:00.000Z' };
    const updated = await methods.updateSavedView({
      userId: userA,
      id: view._id.toString(),
      turns: [next, turn],
    });
    expect(updated?.turns.map((t) => t.id)).toEqual(['t2', 't1']);
    expect((await methods.getSavedViews(userA))[0].turns).toHaveLength(2);
  });

  test('defaults to no turns and rejects a turn without a prompt', async () => {
    const view = await methods.createSavedView({ userId: userA, name: 'Plain', cards: [] });
    expect(view.turns).toEqual([]);
    await expect(
      methods.createSavedView({
        userId: userA,
        name: 'Bad',
        cards: [],
        turns: [{ id: 't', createdAt: 'x' } as never],
      }),
    ).rejects.toThrow();
  });
});

describe('updateSavedView', () => {
  test('renames and replaces cards for the owner only', async () => {
    const view = await methods.createSavedView({
      userId: userA,
      name: 'Draft',
      cards: [card('a')],
    });
    const id = view._id.toString();

    expect(await methods.updateSavedView({ userId: userB, id, name: 'hijack' })).toBeNull();

    const renamed = await methods.updateSavedView({ userId: userA, id, name: 'Final' });
    expect(renamed?.name).toBe('Final');
    expect(renamed?.cards).toEqual([card('a')]);

    const replaced = await methods.updateSavedView({
      userId: userA,
      id,
      cards: [card('b'), card('c')],
    });
    expect(replaced?.cards.map((c) => c.id)).toEqual(['b', 'c']);
  });

  test('returns null for malformed ids', async () => {
    expect(await methods.updateSavedView({ userId: userA, id: 'not-an-id', name: 'x' })).toBeNull();
  });
});

describe('deleteSavedView', () => {
  test('deletes only the owner view', async () => {
    const view = await methods.createSavedView({ userId: userA, name: 'Temp', cards: [] });
    const id = view._id.toString();

    expect(await methods.deleteSavedView({ userId: userB, id })).toBe(false);
    expect(await methods.deleteSavedView({ userId: userA, id })).toBe(true);
    expect(await methods.deleteSavedView({ userId: userA, id })).toBe(false);
    expect(await methods.deleteSavedView({ userId: userA, id: 'nope' })).toBe(false);
    expect(await methods.getSavedViews(userA)).toEqual([]);
  });
});

describe('views dashboard', () => {
  test('starts empty, saves starred cards, and stays out of the saved views list', async () => {
    expect(await methods.getViewsDashboard(userA)).toEqual({ cards: [] });

    const saved = await methods.saveViewsDashboard(userA, [card('s1'), card('s2')]);
    expect(saved.cards.map((c) => c.id)).toEqual(['s1', 's2']);
    expect((await methods.getViewsDashboard(userA)).cards).toHaveLength(2);
    expect(await methods.getSavedViews(userA)).toEqual([]);
    expect(await methods.getViewsDashboard(userB)).toEqual({ cards: [] });
  });

  test('keeps a single dashboard per user and protects it from the views API', async () => {
    await methods.saveViewsDashboard(userA, [card('s1')]);
    await methods.saveViewsDashboard(userA, [card('s2')]);
    expect(await SavedView.countDocuments({ user: userA, kind: 'dashboard' })).toBe(1);

    const doc = (await SavedView.findOne({ user: userA, kind: 'dashboard' }).lean()) as {
      _id: mongoose.Types.ObjectId;
    };
    const id = doc._id.toString();
    expect(await methods.updateSavedView({ userId: userA, id, name: 'hijack' })).toBeNull();
    expect(await methods.deleteSavedView({ userId: userA, id })).toBe(false);
    expect((await methods.getViewsDashboard(userA)).cards.map((c) => c.id)).toEqual(['s2']);
  });
});

describe('dashboard snapshots', () => {
  const at = (second: number) => `2026-11-01T00:00:0${second}.000Z`;

  test('saveViewsDashboardSnapshots returns null when the user has no dashboard', async () => {
    expect(await methods.saveViewsDashboardSnapshots(userA, {}, at(0))).toBeNull();
  });

  test('round-trips snapshots and the refresh time, scoped to the user', async () => {
    await methods.saveViewsDashboard(userA, [card('a')]);
    await methods.saveViewsDashboard(userB, [card('a')]);
    const snapshots = { a: { result: '{"rows":[]}', fetchedAt: at(0) } };

    const saved = await methods.saveViewsDashboardSnapshots(userA, snapshots, at(1));

    expect(saved).toEqual({ cards: [card('a')], snapshots, refreshedAt: at(1) });
    expect(await methods.getViewsDashboard(userA)).toEqual(saved);
    expect(await methods.getViewsDashboard(userB)).toEqual({ cards: [card('a')] });
  });

  test('saving cards keeps the stored snapshots', async () => {
    await methods.saveViewsDashboard(userA, [card('a')]);
    const snapshots = { a: { result: 'r', fetchedAt: at(0) } };
    await methods.saveViewsDashboardSnapshots(userA, snapshots, at(1));

    const saved = await methods.saveViewsDashboard(userA, [card('a'), card('b')]);

    expect(saved.snapshots).toEqual(snapshots);
    expect(saved.cards).toHaveLength(2);
  });
});
