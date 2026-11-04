import { logger, MAX_SNAPSHOT_RESULT_LENGTH } from '@librechat/data-schemas';
import type { MCPViewCard, MCPToolCallParams, MCPViewCardSnapshot } from 'librechat-data-provider';
import type { ViewsDashboard } from '@librechat/data-schemas';
import type { Response } from 'express';
import type { ServerRequest } from '~/types';

const RUN_CONCURRENCY = 4;

type Snapshots = Record<string, MCPViewCardSnapshot>;
type SnapshotEntry = [cardId: string, snapshot: MCPViewCardSnapshot];

/** Runs one card's tool call and returns its text result; the server binds it to a request's user */
export type RunViewCard = (call: MCPToolCallParams) => Promise<string>;

export type RefreshDashboardSnapshots = (
  userId: string,
  runCard: RunViewCard,
) => Promise<ViewsDashboard>;

export interface DashboardSnapshotsDeps {
  getViewsDashboard: (userId: string) => Promise<ViewsDashboard>;
  saveViewsDashboardSnapshots: (
    userId: string,
    snapshots: Snapshots,
    refreshedAt: string,
  ) => Promise<ViewsDashboard | null>;
}

export interface DashboardRefreshHandlerDeps {
  refresh: RefreshDashboardSnapshots;
  /** Builds the tool runner for the request's user */
  runCardFor: (req: ServerRequest) => RunViewCard;
}

const isArgumentsObject = (value: unknown): value is MCPToolCallParams['toolArguments'] =>
  value != null && typeof value === 'object' && !Array.isArray(value);

/** A card's arguments as the tool receives them; malformed text falls back to no arguments */
export function parseCardArguments(argsText: string): MCPToolCallParams['toolArguments'] {
  try {
    const parsed: unknown = argsText.trim() ? JSON.parse(argsText) : {};
    return isArgumentsObject(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/** Runs `work` over `items` with at most `limit` calls in flight, preserving order */
async function mapLimit<T, R>(
  items: T[],
  limit: number,
  work: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await work(items[index]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

/**
 * Stores the result of every dashboard card so the dashboard opens with data from the last
 * sign-in (or manual refresh) instead of re-running each card on every visit.
 */
export function createDashboardSnapshots(deps: DashboardSnapshotsDeps): {
  refresh: RefreshDashboardSnapshots;
} {
  const pending = new Map<string, Promise<ViewsDashboard>>();

  /** A failed card keeps its previous snapshot; an oversized or tool-less card stores nothing */
  async function snapshotCard(
    card: MCPViewCard,
    runCard: RunViewCard,
    previous: MCPViewCardSnapshot | undefined,
  ): Promise<SnapshotEntry | null> {
    if (!card.toolName) {
      return null;
    }
    try {
      const result = await runCard({
        serverName: card.serverName,
        toolName: card.toolName,
        toolArguments: parseCardArguments(card.argsText),
      });
      if (result.length > MAX_SNAPSHOT_RESULT_LENGTH) {
        logger.warn(
          `[Dashboard] Card ${card.id} result too large to store (${result.length} chars)`,
        );
        return null;
      }
      return [card.id, { result, fetchedAt: new Date().toISOString() }];
    } catch (error) {
      logger.warn(
        `[Dashboard] Card ${card.id} (${card.serverName}/${card.toolName}) failed to refresh:`,
        error,
      );
      return previous ? [card.id, previous] : null;
    }
  }

  async function refreshNow(userId: string, runCard: RunViewCard): Promise<ViewsDashboard> {
    const dashboard = await deps.getViewsDashboard(userId);
    if (dashboard.cards.length === 0) {
      return dashboard;
    }
    const entries = await mapLimit(dashboard.cards, RUN_CONCURRENCY, (card) =>
      snapshotCard(card, runCard, dashboard.snapshots?.[card.id]),
    );
    const snapshots = Object.fromEntries(
      entries.filter((entry): entry is SnapshotEntry => entry != null),
    );
    const saved = await deps.saveViewsDashboardSnapshots(
      userId,
      snapshots,
      new Date().toISOString(),
    );
    return saved ?? dashboard;
  }

  /** Concurrent refreshes for one user (e.g. a sign-in and a manual refresh) share one run */
  const refresh: RefreshDashboardSnapshots = (userId, runCard) => {
    const inFlight = pending.get(userId);
    if (inFlight) {
      return inFlight;
    }
    const run = refreshNow(userId, runCard).finally(() => {
      if (pending.get(userId) === run) {
        pending.delete(userId);
      }
    });
    pending.set(userId, run);
    return run;
  };

  return { refresh };
}

/** Re-runs every card of the caller's dashboard now and responds with the refreshed dashboard */
export function createDashboardRefreshHandler(
  deps: DashboardRefreshHandlerDeps,
): (req: ServerRequest, res: Response) => Promise<Response> {
  return async (req, res) => {
    const userId = req.user?.id;
    if (!userId) {
      return res.status(401).json({ message: 'Unauthorized' });
    }
    try {
      return res.status(200).json(await deps.refresh(userId, deps.runCardFor(req)));
    } catch (error) {
      logger.error('[Dashboard] Error refreshing snapshots:', error);
      return res.status(500).json({ message: 'Failed to refresh dashboard' });
    }
  };
}
