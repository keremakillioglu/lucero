import { initializeModel } from '@librechat/agents';
import { MCP_VIEWS_DEFAULT_PROMPT } from 'librechat-data-provider';
import type {
  TModelSpec,
  MCPSuggestedView,
  MCPViewsSuggestEvent,
  MCPViewsSuggestParams,
} from 'librechat-data-provider';
import type { AIMessageChunk, BaseMessageLike } from '@langchain/core/messages';
import type { ToolDefinition } from '@langchain/core/language_models/base';
import type { Runnable } from '@langchain/core/runnables';
import type { Providers } from '@librechat/agents';
import type { EndpointDbMethods, ServerRequest } from '~/types';
import { applyModelSpecPreset, getDefaultModelSpec } from '~/modelSpecs';
import { getProviderConfig } from '~/endpoints';

const MAX_TURNS = 10;
const PROPOSE_TOOL = 'propose_views';
const CALL_TOOL = 'call_mcp_tool';
const DISPLAYS = new Set<MCPSuggestedView['display']>(['line', 'bar', 'table']);
const TOOL_DESCRIPTION_LIMIT = 300;

/** MCP servers that are not data sources, so they are never offered to the suggester */
const EXCLUDED_SERVERS: ReadonlySet<string> = new Set(['web-search']);

export interface SuggestToolCall {
  serverName: string;
  toolName: string;
  arguments: Record<string, unknown>;
}

export interface SuggestToolOutcome {
  /** The full tool result; it is truncated before the model sees it */
  content: string;
  isError: boolean;
}

const MODEL_RESULT_CHAR_LIMIT = 8000;

const truncateForModel = (content: string): string =>
  content.length > MODEL_RESULT_CHAR_LIMIT
    ? `${content.slice(0, MODEL_RESULT_CHAR_LIMIT)}\n…[truncated]`
    : content;

/** Recursively sorts object keys so equal arguments produce the same key regardless of order */
const sortKeys = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    return value.map(sortKeys);
  }
  if (value != null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, child]) => [key, sortKeys(child)]),
    );
  }
  return value;
};

/** Identifies a tool call by source, tool and arguments, independent of argument key order */
export const toolCallKey = (call: SuggestToolCall): string =>
  JSON.stringify([call.serverName, call.toolName, sortKeys(call.arguments)]);

/** Attaches results the agent already fetched to the proposed views whose calls match exactly */
export const attachCachedResults = (
  proposal: ViewsProposal,
  results: ReadonlyMap<string, string>,
): ViewsProposal => ({
  ...proposal,
  views: proposal.views.map((view) => {
    const result = results.get(toolCallKey(view));
    return result == null ? view : { ...view, result };
  }),
});

export interface ViewsProposal {
  views: MCPSuggestedView[];
  notes?: string;
}

export interface SuggestViewsParams {
  req: ServerRequest;
  db: EndpointDbMethods;
  prompt?: string;
  servers: MCPViewsSuggestParams['servers'];
  executeTool: (call: SuggestToolCall) => Promise<SuggestToolOutcome>;
  onEvent: (event: MCPViewsSuggestEvent) => void;
}

/**
 * Reminder sent before the last two turns so the agent lands its proposal instead of spending
 * the whole budget exploring; null on every other turn.
 */
export function turnReminder(turn: number, maxTurns: number = MAX_TURNS): string | null {
  const remaining = maxTurns - turn;
  if (remaining === 1) {
    return 'One turn remains after this one. Finish verifying now; your next turn must call propose_views.';
  }
  if (remaining === 0) {
    return 'This is the final turn: call propose_views now with the 3-6 views you have verified so far. Do not call any other tool.';
  }
  return null;
}

/** Data-source servers the suggester may use, in the order the client listed them */
export function getSuggestServers(servers: MCPViewsSuggestParams['servers']): string[] {
  return Object.keys(servers).filter((name) => !EXCLUDED_SERVERS.has(name));
}

function buildCatalog(servers: MCPViewsSuggestParams['servers'], allowed: string[]): string {
  return allowed
    .map((name) => {
      const tools = (servers[name]?.tools ?? [])
        .map(
          (tool) =>
            `  - ${tool.name}: ${(tool.description || '').slice(0, TOOL_DESCRIPTION_LIMIT)}`,
        )
        .join('\n');
      return `${name}:\n${tools}`;
    })
    .join('\n');
}

function buildSystemPrompt(catalog: string, hasWarehouse: boolean): string {
  const warehouse = hasWarehouse
    ? `\nPrefer the "warehouse" source: it holds the company data locally and answers SQL in milliseconds, while the other sources call vendor APIs live and are slow. Build each view as one warehouse "query" call whenever the warehouse has the data; use list_tables/describe_table to discover it. Fall back to live sources only for data the warehouse lacks.\n`
    : '';
  return `You are a data analyst embedded in a dashboard builder. Today's date is ${new Date().toISOString().slice(0, 10)}.

The user's data sources (MCP servers) and their tools:
${catalog}
${warehouse}
Workflow:
1. Explore with call_mcp_tool — discovery first, then verify the exact arguments for the views you plan to propose. Keep exploration lean: issue independent calls together in the same turn, since they run in parallel.
2. Call propose_views exactly once with 3-6 views.

View rendering rules: each view runs one tool call and charts the first array of records in the result. The x axis is a date/label column and the series are numeric columns. Prefer daily time series (display "line") over single totals; use "bar" for categorical comparisons and "table" only when data is not chartable. Arguments must be exactly valid for the tool — never guess enum values you have not seen.
Views are saved and re-run for months, so every date range must be relative to the day it runs (in SQL use current_date arithmetic such as BETWEEN current_date - 30 AND current_date - 1), never literal dates, unless the user asks for a specific fixed period.`;
}

/**
 * Tool arguments travel as JSON strings: free-form object schemas without declared
 * properties are rejected by some providers (e.g. Gemini function declarations).
 */
const SUGGEST_TOOLS: ToolDefinition[] = [
  {
    type: 'function',
    function: {
      name: CALL_TOOL,
      description:
        "Call a tool on one of the user's MCP data sources and return its result. Use for cheap discovery calls (listing apps, filters, metrics) and to verify the exact arguments you plan to use in a view actually return chartable rows.",
      parameters: {
        type: 'object',
        properties: {
          serverName: { type: 'string', description: 'One of the listed data sources' },
          toolName: { type: 'string', description: 'A tool belonging to that source' },
          arguments_json: {
            type: 'string',
            description: 'Arguments for the tool as a JSON object string, e.g. {"app":"babylab"}',
          },
        },
        required: ['serverName', 'toolName'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: PROPOSE_TOOL,
      description:
        'Submit the final dashboard views. Call exactly once, only after verifying the arguments return meaningful data.',
      parameters: {
        type: 'object',
        properties: {
          notes: { type: 'string', description: 'One or two sentences of insight for the user' },
          views: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                title: { type: 'string' },
                serverName: { type: 'string' },
                toolName: { type: 'string' },
                arguments_json: {
                  type: 'string',
                  description: 'Tool arguments as a JSON object string',
                },
                display: { type: 'string', enum: ['line', 'bar', 'table'] },
              },
              required: ['title', 'serverName', 'toolName', 'arguments_json', 'display'],
            },
          },
        },
        required: ['views'],
      },
    },
  },
];

type RawArgs = Record<string, unknown>;

function parseJsonObject(value: unknown): Record<string, unknown> {
  if (typeof value !== 'string' || value.trim() === '') {
    return {};
  }
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed != null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

const asString = (value: unknown): string => (typeof value === 'string' ? value : '');

function toToolCall(args: RawArgs): SuggestToolCall {
  return {
    serverName: asString(args.serverName),
    toolName: asString(args.toolName),
    arguments: parseJsonObject(args.arguments_json),
  };
}

function toProposal(args: RawArgs): ViewsProposal {
  const rawViews = Array.isArray(args.views) ? (args.views as RawArgs[]) : [];
  const views = rawViews.map((view) => {
    const display = asString(view.display) as MCPSuggestedView['display'];
    return {
      title: asString(view.title),
      serverName: asString(view.serverName),
      toolName: asString(view.toolName),
      arguments: parseJsonObject(view.arguments_json),
      display: DISPLAYS.has(display) ? display : 'table',
    };
  });
  const notes = asString(args.notes);
  return notes ? { views, notes } : { views };
}

/**
 * Builds a chat model from the default model spec, resolving credentials and parameters
 * exactly as a chat with that spec would, so every LLM feature follows the selected model.
 */
export async function createModelSpecLLM({
  req,
  db,
  tools,
}: Pick<SuggestViewsParams, 'req' | 'db'> & { tools: ToolDefinition[] }): Promise<Runnable> {
  const modelSpec = getDefaultModelSpec(
    req.config?.modelSpecs as { list?: TModelSpec[] } | undefined,
  );
  const endpoint = modelSpec?.preset?.endpoint;
  if (!modelSpec || !endpoint) {
    throw new Error('No model spec is configured; add one under `modelSpecs` in librechat.yaml');
  }

  const { parsedBody } = applyModelSpecPreset({
    modelSpec,
    parsedBody: {},
    endpoint,
    includePresetDefaults: true,
  });
  const {
    spec: _spec,
    iconURL: _iconURL,
    agent_id: _agentId,
    chatProjectId: _chatProjectId,
    promptPrefix: _promptPrefix,
    ...model_parameters
  } = parsedBody as Record<string, unknown>;

  const { getOptions, overrideProvider } = getProviderConfig({
    provider: endpoint,
    appConfig: req.config,
  });
  const { llmConfig } = await getOptions({ req, endpoint, model_parameters, db });

  return initializeModel({
    provider: overrideProvider as Providers,
    clientOptions: llmConfig as Parameters<typeof initializeModel>[0]['clientOptions'],
    tools,
  });
}

/**
 * Lets the selected model explore the user's data sources via tool calls until it proposes
 * views, reporting each step through `onEvent`. Tool calls within a turn run in parallel.
 */
export async function suggestViews({
  req,
  db,
  prompt,
  servers,
  executeTool,
  onEvent,
}: SuggestViewsParams): Promise<ViewsProposal | null> {
  const allowed = getSuggestServers(servers);
  const allowedSet = new Set(allowed);
  const system = buildSystemPrompt(buildCatalog(servers, allowed), allowedSet.has('warehouse'));
  const model = await createModelSpecLLM({ req, db, tools: SUGGEST_TOOLS });
  const messages: BaseMessageLike[] = [
    { role: 'system', content: system },
    { role: 'user', content: prompt?.trim() || MCP_VIEWS_DEFAULT_PROMPT },
  ];

  /** Full results of successful calls, reused by the proposed views instead of re-running them */
  const results = new Map<string, string>();

  const runCall = async (args: RawArgs): Promise<string> => {
    const call = toToolCall(args);
    if (!allowedSet.has(call.serverName)) {
      return `Unknown data source "${call.serverName}". Use one of: ${allowed.join(', ')}`;
    }
    onEvent({ type: 'tool', serverName: call.serverName, toolName: call.toolName });
    const outcome = await executeTool(call);
    if (!outcome.isError) {
      results.set(toolCallKey(call), outcome.content);
    }
    return truncateForModel(outcome.content);
  };

  for (let turn = 1; turn <= MAX_TURNS; turn++) {
    onEvent({ type: 'thinking', turn });
    const reminder = turnReminder(turn);
    if (reminder) {
      messages.push({ role: 'user', content: reminder });
    }
    const response = (await model.invoke(messages)) as AIMessageChunk;
    messages.push(response);
    const toolCalls = response.tool_calls ?? [];
    if (toolCalls.length === 0) {
      return null;
    }

    const proposalCall = toolCalls.find((call) => call.name === PROPOSE_TOOL);
    const contents = await Promise.all(
      toolCalls.map((call) =>
        call.name === PROPOSE_TOOL ? Promise.resolve('Views received.') : runCall(call.args),
      ),
    );
    toolCalls.forEach((call, i) =>
      messages.push({ role: 'tool', tool_call_id: call.id ?? '', content: contents[i] }),
    );
    if (proposalCall) {
      return attachCachedResults(toProposal(proposalCall.args), results);
    }
  }

  return null;
}
