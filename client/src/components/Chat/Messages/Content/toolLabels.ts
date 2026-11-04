import type { TranslationKeys } from '~/hooks';

type ToolLabel = { key: TranslationKeys; values?: Record<string, string> };

/** Plain-language activity labels for data tools, keyed by `<mcp server>/<tool>` */
const TOOL_LABELS: Record<string, ToolLabel> = {
  'warehouse/search_models': { key: 'com_ui_tool_finding_data' },
  'warehouse/get_model': { key: 'com_ui_tool_checking_definitions' },
  'adjust-reports/run_report': { key: 'com_ui_tool_fetching_live', values: { 0: 'Adjust' } },
};

export const getToolLabel = (serverName: string, toolName: string): ToolLabel | undefined =>
  TOOL_LABELS[`${serverName}/${toolName}`];
