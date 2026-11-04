import { logger, SAVED_VIEW_DISPLAYS } from '@librechat/data-schemas';
import type { MCPViewCard, MCPViewTurn, MCPViewDisplay } from 'librechat-data-provider';
import type {
  SavedViewRef,
  ISavedViewLean,
  SavedViewInput,
  SavedViewUpdate,
  ViewsDashboard,
} from '@librechat/data-schemas';
import type { Response } from 'express';
import type { ServerRequest } from '~/types';

const MAX_NAME_LENGTH = 120;
const MAX_CARDS = 50;
const MAX_TURNS = 100;
const MAX_ID_LENGTH = 64;
const MAX_PROMPT_LENGTH = 2000;
const MAX_OVERVIEW_LENGTH = 8000;
const DISPLAYS = new Set<MCPViewDisplay>(SAVED_VIEW_DISPLAYS);

export interface SavedViewsHandlersDeps {
  /** Saved view CRUD — from `@librechat/data-schemas` `createMethods` output. */
  getSavedViews: (userId: string) => Promise<ISavedViewLean[]>;
  createSavedView: (input: SavedViewInput) => Promise<ISavedViewLean>;
  updateSavedView: (update: SavedViewUpdate) => Promise<ISavedViewLean | null>;
  deleteSavedView: (ref: SavedViewRef) => Promise<boolean>;
  getViewsDashboard: (userId: string) => Promise<ViewsDashboard>;
  saveViewsDashboard: (userId: string, cards: MCPViewCard[]) => Promise<ViewsDashboard>;
}

type Validated<T> = { ok: true; value: T } | { ok: false; message: string };

type SavedViewBody = { name?: string; cards?: MCPViewCard[]; turns?: MCPViewTurn[] };

const isString = (value: unknown): value is string => typeof value === 'string';

const isBoundedString = (value: unknown, max: number, min = 0): value is string =>
  isString(value) && value.length >= min && value.length <= max;

const isOptionalString = (value: unknown, max: number): boolean =>
  value === undefined || isBoundedString(value, max);

function validateName(name: unknown): Validated<string> {
  const trimmed = isString(name) ? name.trim() : '';
  if (trimmed.length === 0 || trimmed.length > MAX_NAME_LENGTH) {
    return { ok: false, message: `name must be 1-${MAX_NAME_LENGTH} characters` };
  }
  return { ok: true, value: trimmed };
}

function toCard(raw: unknown): MCPViewCard | null {
  if (raw == null || typeof raw !== 'object') {
    return null;
  }
  const card = raw as Record<keyof MCPViewCard, unknown>;
  if (!isString(card.id) || !isString(card.serverName) || !isString(card.argsText)) {
    return null;
  }
  if (!isString(card.display) || !DISPLAYS.has(card.display as MCPViewDisplay)) {
    return null;
  }
  if (!isOptionalString(card.turnId, MAX_ID_LENGTH)) {
    return null;
  }
  return {
    id: card.id,
    serverName: card.serverName,
    toolName: isString(card.toolName) ? card.toolName : '',
    argsText: card.argsText,
    display: card.display as MCPViewDisplay,
    ...(isString(card.title) ? { title: card.title } : {}),
    ...(isString(card.datasetPath) ? { datasetPath: card.datasetPath } : {}),
    ...(isString(card.xKey) ? { xKey: card.xKey } : {}),
    ...(Array.isArray(card.yKeys) && card.yKeys.every(isString) ? { yKeys: card.yKeys } : {}),
    ...(isString(card.turnId) ? { turnId: card.turnId } : {}),
  };
}

function toTurn(raw: unknown): MCPViewTurn | null {
  if (raw == null || typeof raw !== 'object') {
    return null;
  }
  const turn = raw as Record<keyof MCPViewTurn, unknown>;
  if (
    !isBoundedString(turn.id, MAX_ID_LENGTH, 1) ||
    !isBoundedString(turn.prompt, MAX_PROMPT_LENGTH, 1) ||
    !isBoundedString(turn.createdAt, 40, 1) ||
    !isOptionalString(turn.overview, MAX_OVERVIEW_LENGTH)
  ) {
    return null;
  }
  return {
    id: turn.id,
    prompt: turn.prompt,
    createdAt: turn.createdAt,
    ...(isString(turn.overview) ? { overview: turn.overview } : {}),
  };
}

/** Validates a bounded list, parsing every item or rejecting the whole list */
function validateList<T>(
  value: unknown,
  max: number,
  parse: (raw: unknown) => T | null,
  message: string,
): Validated<T[]> {
  if (!Array.isArray(value) || value.length > max) {
    return { ok: false, message };
  }
  const parsed = value.map(parse);
  if (parsed.some((item) => item == null)) {
    return { ok: false, message };
  }
  return { ok: true, value: parsed as T[] };
}

/** Validates the fields present in a request body; `required` lists fields that must be present */
function parseBody(body: unknown, required: Array<keyof SavedViewBody>): Validated<SavedViewBody> {
  const raw = (body ?? {}) as Record<keyof SavedViewBody, unknown>;
  const missing = required.find((field) => raw[field] === undefined);
  if (missing) {
    return { ok: false, message: `${missing} is required` };
  }
  const checks = [
    raw.name === undefined ? null : (['name', validateName(raw.name)] as const),
    raw.cards === undefined
      ? null
      : ([
          'cards',
          validateList(
            raw.cards,
            MAX_CARDS,
            toCard,
            `cards must be at most ${MAX_CARDS} cards, each with id, serverName, argsText and a valid display`,
          ),
        ] as const),
    raw.turns === undefined
      ? null
      : ([
          'turns',
          validateList(
            raw.turns,
            MAX_TURNS,
            toTurn,
            `turns must be at most ${MAX_TURNS} turns, each with id, prompt and createdAt`,
          ),
        ] as const),
  ].filter((check) => check != null);

  const failed = checks.find(([, result]) => !result.ok);
  if (failed && !failed[1].ok) {
    return { ok: false, message: failed[1].message };
  }
  return {
    ok: true,
    value: Object.fromEntries(
      checks.map(([field, result]) => [field, result.ok ? result.value : undefined]),
    ),
  };
}

const isCapError = (error: unknown): boolean =>
  (error as { code?: string } | null)?.code === 'MAX_SAVED_VIEWS_EXCEEDED';

export function createSavedViewsHandlers(deps: SavedViewsHandlersDeps): {
  listSavedViews: (req: ServerRequest, res: Response) => Promise<Response>;
  createSavedView: (req: ServerRequest, res: Response) => Promise<Response>;
  updateSavedView: (req: ServerRequest, res: Response) => Promise<Response>;
  deleteSavedView: (req: ServerRequest, res: Response) => Promise<Response>;
  getViewsDashboard: (req: ServerRequest, res: Response) => Promise<Response>;
  updateViewsDashboard: (req: ServerRequest, res: Response) => Promise<Response>;
} {
  async function listSavedViews(req: ServerRequest, res: Response): Promise<Response> {
    const userId = req.user?.id;
    if (!userId) {
      return res.status(401).json({ message: 'Unauthorized' });
    }
    try {
      return res.status(200).json(await deps.getSavedViews(userId));
    } catch (error) {
      logger.error('[SavedViews] Error listing views:', error);
      return res.status(500).json({ message: 'Failed to retrieve saved views' });
    }
  }

  async function createSavedView(req: ServerRequest, res: Response): Promise<Response> {
    const userId = req.user?.id;
    if (!userId) {
      return res.status(401).json({ message: 'Unauthorized' });
    }
    const parsed = parseBody(req.body, ['name', 'cards']);
    if (!parsed.ok) {
      return res.status(400).json({ message: parsed.message });
    }
    const { name = '', cards = [], turns = [] } = parsed.value;
    try {
      return res.status(201).json(await deps.createSavedView({ userId, name, cards, turns }));
    } catch (error) {
      if (isCapError(error)) {
        return res
          .status(409)
          .json({ code: 'MAX_SAVED_VIEWS_EXCEEDED', message: (error as Error).message });
      }
      logger.error('[SavedViews] Error creating view:', error);
      return res.status(500).json({ message: 'Failed to save view' });
    }
  }

  async function updateSavedView(req: ServerRequest, res: Response): Promise<Response> {
    const userId = req.user?.id;
    if (!userId) {
      return res.status(401).json({ message: 'Unauthorized' });
    }
    const { id } = req.params as { id?: string };
    const parsed = parseBody(req.body, []);
    if (!parsed.ok) {
      return res.status(400).json({ message: parsed.message });
    }
    if (!id || Object.keys(parsed.value).length === 0) {
      return res.status(400).json({ message: 'provide a name, cards and/or turns' });
    }
    try {
      const updated = await deps.updateSavedView({ userId, id, ...parsed.value });
      return updated
        ? res.status(200).json(updated)
        : res.status(404).json({ message: 'View not found' });
    } catch (error) {
      logger.error('[SavedViews] Error updating view:', error);
      return res.status(500).json({ message: 'Failed to update view' });
    }
  }

  async function deleteSavedView(req: ServerRequest, res: Response): Promise<Response> {
    const userId = req.user?.id;
    if (!userId) {
      return res.status(401).json({ message: 'Unauthorized' });
    }
    const { id } = req.params as { id?: string };
    try {
      const deleted = id ? await deps.deleteSavedView({ userId, id }) : false;
      return deleted
        ? res.status(200).json({ deleted })
        : res.status(404).json({ message: 'View not found' });
    } catch (error) {
      logger.error('[SavedViews] Error deleting view:', error);
      return res.status(500).json({ message: 'Failed to delete view' });
    }
  }

  async function getViewsDashboard(req: ServerRequest, res: Response): Promise<Response> {
    const userId = req.user?.id;
    if (!userId) {
      return res.status(401).json({ message: 'Unauthorized' });
    }
    try {
      return res.status(200).json(await deps.getViewsDashboard(userId));
    } catch (error) {
      logger.error('[SavedViews] Error loading dashboard:', error);
      return res.status(500).json({ message: 'Failed to load dashboard' });
    }
  }

  async function updateViewsDashboard(req: ServerRequest, res: Response): Promise<Response> {
    const userId = req.user?.id;
    if (!userId) {
      return res.status(401).json({ message: 'Unauthorized' });
    }
    const parsed = parseBody(req.body, ['cards']);
    if (!parsed.ok) {
      return res.status(400).json({ message: parsed.message });
    }
    try {
      return res.status(200).json(await deps.saveViewsDashboard(userId, parsed.value.cards ?? []));
    } catch (error) {
      logger.error('[SavedViews] Error saving dashboard:', error);
      return res.status(500).json({ message: 'Failed to save dashboard' });
    }
  }

  return {
    listSavedViews,
    createSavedView,
    updateSavedView,
    deleteSavedView,
    getViewsDashboard,
    updateViewsDashboard,
  };
}
