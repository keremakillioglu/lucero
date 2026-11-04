import { Schema } from 'mongoose';
import type { MCPViewCard, MCPViewTurn, MCPViewCardSnapshot } from 'librechat-data-provider';
import type { ISavedView } from '~/types/savedView';
import { SAVED_VIEW_DISPLAYS, MAX_SNAPSHOT_RESULT_LENGTH } from '~/types/savedView';

export const MAX_SAVED_VIEW_CARDS = 50;
export const MAX_SAVED_VIEW_TURNS = 100;

const cardSchema = new Schema<MCPViewCard>(
  {
    id: { type: String, required: true, maxlength: 64 },
    serverName: { type: String, required: true, maxlength: 256 },
    toolName: { type: String, default: '', maxlength: 256 },
    argsText: { type: String, default: '{}', maxlength: 20000 },
    display: { type: String, enum: SAVED_VIEW_DISPLAYS, default: 'auto' },
    title: { type: String, maxlength: 200 },
    datasetPath: { type: String, maxlength: 512 },
    xKey: { type: String, maxlength: 256 },
    yKeys: { type: [String], default: undefined },
    turnId: { type: String, maxlength: 64 },
  },
  { _id: false },
);

const turnSchema = new Schema<MCPViewTurn>(
  {
    id: { type: String, required: true, maxlength: 64 },
    prompt: { type: String, required: true, maxlength: 2000 },
    overview: { type: String, maxlength: 8000 },
    createdAt: { type: String, required: true, maxlength: 40 },
  },
  { _id: false },
);

const snapshotSchema = new Schema<MCPViewCardSnapshot>(
  {
    result: { type: String, required: true, maxlength: MAX_SNAPSHOT_RESULT_LENGTH },
    fetchedAt: { type: String, required: true, maxlength: 40 },
  },
  { _id: false },
);

const savedViewSchema: Schema<ISavedView> = new Schema(
  {
    user: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    name: {
      type: String,
      required: true,
      trim: true,
      maxlength: 120,
    },
    cards: {
      type: [cardSchema],
      default: [],
      validate: {
        validator: (cards: MCPViewCard[]) => cards.length <= MAX_SAVED_VIEW_CARDS,
        message: `A view can hold at most ${MAX_SAVED_VIEW_CARDS} cards`,
      },
    },
    turns: {
      type: [turnSchema],
      default: [],
      validate: {
        validator: (turns: MCPViewTurn[]) => turns.length <= MAX_SAVED_VIEW_TURNS,
        message: `A view can hold at most ${MAX_SAVED_VIEW_TURNS} turns`,
      },
    },
    kind: {
      type: String,
      enum: ['view', 'dashboard'],
      default: 'view',
    },
    /** Dashboard only: stored card results keyed by card id, written by the snapshot refresh */
    snapshots: { type: Map, of: snapshotSchema, default: undefined },
    refreshedAt: { type: String, maxlength: 40 },
    tenantId: {
      type: String,
      index: true,
    },
  },
  { timestamps: true },
);

/** One dashboard document per user */
savedViewSchema.index(
  { user: 1, kind: 1 },
  { unique: true, partialFilterExpression: { kind: 'dashboard' } },
);

/** Lists a user's views newest-first */
savedViewSchema.index({ user: 1, updatedAt: -1 });

export default savedViewSchema;
