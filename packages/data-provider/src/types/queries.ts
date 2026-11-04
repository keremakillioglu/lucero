import type { InfiniteData } from '@tanstack/react-query';
import type * as p from '../accessPermissions';
import type * as a from '../types/agents';
import type * as s from '../schemas';
import type * as t from '../types';

export type Conversation = {
  id: string;
  createdAt: number;
  participants: string[];
  lastMessage: string;
  conversations: s.TConversation[];
};

export type ConversationListParams = {
  cursor?: string;
  isArchived?: boolean;
  sortBy?: 'title' | 'createdAt' | 'updatedAt';
  sortDirection?: 'asc' | 'desc';
  tags?: string[];
  search?: string;
  projectId?: string;
};

export type MinimalConversation = Pick<
  s.TConversation,
  'conversationId' | 'endpoint' | 'title' | 'createdAt' | 'updatedAt' | 'user' | 'chatProjectId'
>;

export type ConversationListResponse = {
  conversations: MinimalConversation[];
  nextCursor: string | null;
};

export type ConversationData = InfiniteData<ConversationListResponse>;
export type ConversationUpdater = (
  data: ConversationData,
  conversation: s.TConversation,
) => ConversationData;

export type ProjectListParams = {
  cursor?: string;
  limit?: number;
  sortBy?: 'name' | 'createdAt' | 'lastConversationAt';
  sortDirection?: 'asc' | 'desc';
  search?: string;
};

export type ProjectListResponse = {
  projects: t.TChatProject[];
  nextCursor: string | null;
};

export type ProjectData = InfiniteData<ProjectListResponse>;

/* Messages */
export type MessagesListParams = {
  cursor?: string | null;
  sortBy?: 'endpoint' | 'createdAt' | 'updatedAt';
  sortDirection?: 'asc' | 'desc';
  pageSize?: number;
  conversationId?: string;
  messageId?: string;
  search?: string;
};

export type MessagesListResponse = {
  messages: s.TMessage[];
  nextCursor: string | null;
};

/* Shared Links */
export type SharedMessagesResponse = Omit<s.TSharedLink, 'messages'> & {
  messages: s.TMessage[];
};

export interface SharedLinksListParams {
  pageSize: number;
  sortBy: 'title' | 'createdAt';
  sortDirection: 'asc' | 'desc';
  search?: string;
  cursor?: string;
}

export type SharedLinkItem = {
  shareId: string;
  title: string;
  createdAt: Date;
  conversationId: string;
};

export interface SharedLinksResponse {
  links: SharedLinkItem[];
  nextCursor: string | null;
  hasNextPage: boolean;
}

export interface SharedLinkQueryData {
  pages: SharedLinksResponse[];
  pageParams: (string | null)[];
}

export type AllPromptGroupsFilterRequest = {
  category: string;
  pageNumber: string;
  pageSize: string | number;
  before?: string | null;
  after?: string | null;
  order?: 'asc' | 'desc';
  name?: string;
  author?: string;
};

export type AllPromptGroupsResponse = t.TPromptGroup[];

export type ConversationTagsResponse = s.TConversationTag[];

/* MCP Types */
export type MCPTool = {
  name: string;
  pluginKey: string;
  description: string;
};

export type MCPServer = {
  name: string;
  icon: string;
  authenticated: boolean;
  authConfig: s.TPluginAuthConfig[];
  tools: MCPTool[];
};

export type MCPServersResponse = {
  servers: Record<string, MCPServer>;
};

export type MCPToolCallParams = {
  serverName: string;
  toolName: string;
  toolArguments?: Record<string, unknown>;
};

export type MCPToolCallResponse = {
  success: boolean;
  serverName: string;
  toolName: string;
  result: string;
};

export type MCPViewDisplay = 'auto' | 'line' | 'bar' | 'table' | 'json';

/** One chart card on the Views page: a single MCP tool call and how to render its result */
export type MCPViewCard = {
  id: string;
  serverName: string;
  toolName: string;
  argsText: string;
  display: MCPViewDisplay;
  title?: string;
  datasetPath?: string;
  xKey?: string;
  yKeys?: string[];
  /** The AI Suggest turn that generated this card; absent for manually added cards */
  turnId?: string;
};

/** One AI Suggest turn on a view: the user's prompt and the AI overview of the cards it added */
export type MCPViewTurn = {
  id: string;
  prompt: string;
  overview?: string;
  createdAt: string;
};

/** A named set of view cards persisted for the user */
export type TSavedView = {
  _id: string;
  name: string;
  cards: MCPViewCard[];
  turns: MCPViewTurn[];
  createdAt: string;
  updatedAt: string;
};

export type TSavedViewInput = {
  name: string;
  cards: MCPViewCard[];
  turns?: MCPViewTurn[];
};

export type TSavedViewUpdate = { id: string } & Partial<TSavedViewInput>;

/** A dashboard card's stored tool result, captured by the last refresh (ISO `fetchedAt`) */
export type MCPViewCardSnapshot = {
  result: string;
  fetchedAt: string;
};

/** The user's custom dashboard: copies of the view cards they starred */
export type TViewsDashboard = {
  cards: MCPViewCard[];
  /** Stored results by card id, refreshed at sign-in or on demand */
  snapshots?: Record<string, MCPViewCardSnapshot>;
  refreshedAt?: string;
};

export type MCPSuggestedView = {
  title: string;
  serverName: string;
  toolName: string;
  arguments: Record<string, unknown>;
  display: 'line' | 'bar' | 'table';
  /** The tool result the agent already fetched with these exact arguments, so the card needn't re-run */
  result?: string;
};

export type MCPViewsSuggestParams = {
  prompt?: string;
  servers: Record<string, { tools: Array<{ name: string; description: string }> }>;
};

/** Server-sent events streamed while views are being suggested */
export type MCPViewsSuggestEvent =
  | { type: 'thinking'; turn: number }
  | { type: 'tool'; serverName: string; toolName: string }
  | { type: 'result'; views: MCPSuggestedView[]; notes?: string }
  | { type: 'error'; error: string };

export type VerifyToolAuthParams = { toolId: string };
export type VerifyToolAuthResponse = {
  authenticated: boolean;
  message?: string | s.AuthType;
  authTypes?: [string, s.AuthType][];
};

export type GetToolCallParams = { conversationId: string };
export type ToolCallResults = a.ToolCallResult[];

/* Memories */
export type TUserMemory = {
  key: string;
  value: string;
  updated_at: string;
  tokenCount?: number;
};

export type MemoriesResponse = {
  memories: TUserMemory[];
  totalTokens: number;
  tokenLimit: number | null;
  usagePercentage: number | null;
};

export type PrincipalSearchParams = {
  q: string;
  limit?: number;
  types?: Array<p.PrincipalType.USER | p.PrincipalType.GROUP | p.PrincipalType.ROLE>;
};

export type PrincipalSearchResponse = {
  query: string;
  limit: number;
  types?: Array<p.PrincipalType.USER | p.PrincipalType.GROUP | p.PrincipalType.ROLE>;
  results: p.TPrincipalSearchResult[];
  count: number;
  sources: {
    local: number;
    entra: number;
  };
};

export type AccessRole = {
  accessRoleId: p.AccessRoleIds;
  name: string;
  description: string;
  permBits: number;
};

export type AccessRolesResponse = AccessRole[];

export type ListRolesResponse = {
  roles: Array<{ _id?: string; name: string; description?: string }>;
  total: number;
  limit: number;
  offset?: number;
};

export interface MCPServerStatus {
  requiresOAuth: boolean;
  connectionState: 'disconnected' | 'connecting' | 'connected' | 'error';
}

export interface MCPConnectionStatusResponse {
  success: boolean;
  connectionStatus: Record<string, MCPServerStatus>;
  /** Server-configured OAuth completion window in ms (`MCP_OAUTH_HANDLING_TIMEOUT`) */
  oauthTimeout?: number;
}

export interface MCPServerConnectionStatusResponse {
  success: boolean;
  serverName: string;
  requiresOAuth: boolean;
  connectionStatus: 'disconnected' | 'connecting' | 'connected' | 'error';
}

export interface MCPAuthValuesResponse {
  success: boolean;
  serverName: string;
  authValueFlags: Record<string, boolean>;
}

/**
 * User Favorites — pinned agents, models, and model specs.
 * Exactly one variant should be set per entry; exclusivity is enforced
 * server-side in FavoritesController. Shape is loose for state-update ergonomics.
 */
export type TUserFavorite = {
  agentId?: string;
  model?: string;
  endpoint?: string;
  spec?: string;
};

/**
 * Tool favorites — starred marketplace items (built-in capabilities, plugin
 * tools, MCP servers, skills). Identity is the compound (itemType, itemId)
 * pair, matching the marketplace `itemKey` format `itemType:itemId`.
 */
export type TToolFavoriteType = 'builtin' | 'tool' | 'mcp' | 'skill';

export type TToolFavorite = {
  itemType: TToolFavoriteType;
  itemId: string;
};

/* SharePoint Graph API Token */
export type GraphTokenParams = {
  scopes: string;
};

export type GraphTokenResponse = {
  access_token: string;
  token_type: string;
  expires_in: number;
  scope: string;
};
