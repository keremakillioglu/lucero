import type * as t from '~/types';

export const MAX_SAVED_VIEWS = 200;

const LIST_FIELDS = 'name cards turns createdAt updatedAt';
const DASHBOARD_FIELDS = 'cards snapshots refreshedAt';
const DASHBOARD_NAME = 'Dashboard';

/** Shapes a lean dashboard document, omitting the optional fields it has never set */
const toDashboard = (doc: Partial<t.ViewsDashboard> | null): t.ViewsDashboard => ({
  cards: doc?.cards ?? [],
  ...(doc?.snapshots ? { snapshots: doc.snapshots } : {}),
  ...(doc?.refreshedAt ? { refreshedAt: doc.refreshedAt } : {}),
});

/** Regular views exclude the per-user dashboard document */
const viewsOf = (userId: string) => ({ user: userId, kind: { $ne: 'dashboard' } });

function capError(): Error {
  const error = new Error(`Maximum of ${MAX_SAVED_VIEWS} saved views reached`);
  (error as Error & { code: string; limit: number }).code = 'MAX_SAVED_VIEWS_EXCEEDED';
  (error as Error & { code: string; limit: number }).limit = MAX_SAVED_VIEWS;
  return error;
}

export function createSavedViewMethods(mongoose: typeof import('mongoose')): {
  getSavedViews: (userId: string) => Promise<t.ISavedViewLean[]>;
  createSavedView: (input: t.SavedViewInput) => Promise<t.ISavedViewLean>;
  updateSavedView: (update: t.SavedViewUpdate) => Promise<t.ISavedViewLean | null>;
  deleteSavedView: (ref: t.SavedViewRef) => Promise<boolean>;
  getViewsDashboard: (userId: string) => Promise<t.ViewsDashboard>;
  saveViewsDashboard: (
    userId: string,
    cards: t.ViewsDashboard['cards'],
  ) => Promise<t.ViewsDashboard>;
  saveViewsDashboardSnapshots: (
    userId: string,
    snapshots: NonNullable<t.ViewsDashboard['snapshots']>,
    refreshedAt: string,
  ) => Promise<t.ViewsDashboard | null>;
} {
  const isValidId = (id: string) => mongoose.Types.ObjectId.isValid(id);

  async function getSavedViews(userId: string): Promise<t.ISavedViewLean[]> {
    const SavedView = mongoose.models.SavedView;
    return SavedView.find(viewsOf(userId))
      .select(LIST_FIELDS)
      .sort({ updatedAt: -1 })
      .limit(MAX_SAVED_VIEWS)
      .lean<t.ISavedViewLean[]>();
  }

  /** The per-user cap is read-then-write and may overshoot by one under concurrency */
  async function createSavedView({
    userId,
    name,
    cards,
    turns = [],
  }: t.SavedViewInput): Promise<t.ISavedViewLean> {
    const SavedView = mongoose.models.SavedView;
    const count = await SavedView.countDocuments(viewsOf(userId));
    if (count >= MAX_SAVED_VIEWS) {
      throw capError();
    }
    const created = await SavedView.create({ user: userId, name, cards, turns });
    const { _id, createdAt, updatedAt, ...saved } = created.toObject() as t.ISavedViewLean;
    return { _id, name: saved.name, cards: saved.cards, turns: saved.turns, createdAt, updatedAt };
  }

  async function updateSavedView({
    userId,
    id,
    name,
    cards,
    turns,
  }: t.SavedViewUpdate): Promise<t.ISavedViewLean | null> {
    if (!isValidId(id)) {
      return null;
    }
    const SavedView = mongoose.models.SavedView;
    const changes = {
      ...(name !== undefined ? { name } : {}),
      ...(cards !== undefined ? { cards } : {}),
      ...(turns !== undefined ? { turns } : {}),
    };
    return SavedView.findOneAndUpdate(
      { _id: id, ...viewsOf(userId) },
      { $set: changes },
      {
        new: true,
        runValidators: true,
      },
    )
      .select(LIST_FIELDS)
      .lean<t.ISavedViewLean>();
  }

  async function deleteSavedView({ userId, id }: t.SavedViewRef): Promise<boolean> {
    if (!isValidId(id)) {
      return false;
    }
    const SavedView = mongoose.models.SavedView;
    const result = await SavedView.deleteOne({ _id: id, ...viewsOf(userId) });
    return result.deletedCount > 0;
  }

  async function getViewsDashboard(userId: string): Promise<t.ViewsDashboard> {
    const SavedView = mongoose.models.SavedView;
    const dashboard = await SavedView.findOne({ user: userId, kind: 'dashboard' })
      .select(DASHBOARD_FIELDS)
      .lean<Partial<t.ViewsDashboard>>();
    return toDashboard(dashboard);
  }

  /** Upserts the user's single dashboard document (unique per user via a partial index) */
  async function saveViewsDashboard(
    userId: string,
    cards: t.ViewsDashboard['cards'],
  ): Promise<t.ViewsDashboard> {
    const SavedView = mongoose.models.SavedView;
    const saved = await SavedView.findOneAndUpdate(
      { user: userId, kind: 'dashboard' },
      { $set: { cards }, $setOnInsert: { name: DASHBOARD_NAME } },
      { new: true, upsert: true, runValidators: true },
    )
      .select(DASHBOARD_FIELDS)
      .lean<Partial<t.ViewsDashboard>>();
    return toDashboard(saved);
  }

  /** Stores the results of a dashboard refresh; null when the user has no dashboard yet */
  async function saveViewsDashboardSnapshots(
    userId: string,
    snapshots: NonNullable<t.ViewsDashboard['snapshots']>,
    refreshedAt: string,
  ): Promise<t.ViewsDashboard | null> {
    const SavedView = mongoose.models.SavedView;
    const saved = await SavedView.findOneAndUpdate(
      { user: userId, kind: 'dashboard' },
      { $set: { snapshots, refreshedAt } },
      { new: true, runValidators: true },
    )
      .select(DASHBOARD_FIELDS)
      .lean<Partial<t.ViewsDashboard>>();
    return saved ? toDashboard(saved) : null;
  }

  return {
    getSavedViews,
    createSavedView,
    updateSavedView,
    deleteSavedView,
    getViewsDashboard,
    saveViewsDashboard,
    saveViewsDashboardSnapshots,
  };
}

export type SavedViewMethods = ReturnType<typeof createSavedViewMethods>;
