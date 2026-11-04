import type { Types, Document } from 'mongoose';
import type {
  MCPViewCard,
  MCPViewTurn,
  MCPViewDisplay,
  MCPViewCardSnapshot,
} from 'librechat-data-provider';

export const SAVED_VIEW_DISPLAYS: readonly MCPViewDisplay[] = [
  'auto',
  'line',
  'bar',
  'table',
  'json',
];

/** Dashboard results above this size are not stored; the card runs live instead */
export const MAX_SNAPSHOT_RESULT_LENGTH = 200_000;

export interface ISavedView extends Document {
  user: Types.ObjectId;
  name: string;
  cards: MCPViewCard[];
  turns: MCPViewTurn[];
  kind?: 'view' | 'dashboard';
  /** Dashboard only: stored card results keyed by card id */
  snapshots?: Map<string, MCPViewCardSnapshot>;
  refreshedAt?: string;
  tenantId?: string;
  createdAt?: Date;
  updatedAt?: Date;
}

export interface ISavedViewLean {
  _id: Types.ObjectId;
  name: string;
  cards: MCPViewCard[];
  turns: MCPViewTurn[];
  createdAt: Date;
  updatedAt: Date;
}

export interface SavedViewInput {
  userId: string;
  name: string;
  cards: MCPViewCard[];
  turns?: MCPViewTurn[];
}

export interface SavedViewUpdate {
  userId: string;
  id: string;
  name?: string;
  cards?: MCPViewCard[];
  turns?: MCPViewTurn[];
}

export interface ViewsDashboard {
  cards: MCPViewCard[];
  /** Stored results by card id, written by the last refresh */
  snapshots?: Record<string, MCPViewCardSnapshot>;
  refreshedAt?: string;
}

export interface SavedViewRef {
  userId: string;
  id: string;
}
