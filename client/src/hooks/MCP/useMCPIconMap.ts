import { useMemo } from 'react';
import { useMCPServersQuery } from '~/data-provider';

type DisplayField = 'iconPath' | 'title';

/** Maps each MCP server name to one of its configured display fields */
function useMCPServerFieldMap(field: DisplayField): Map<string, string> {
  const { data: servers } = useMCPServersQuery();

  return useMemo(() => {
    const map = new Map<string, string>();
    if (!servers) {
      return map;
    }
    for (const [serverName, config] of Object.entries(servers)) {
      const value = config[field];
      if (value) {
        map.set(serverName, value);
      }
    }
    return map;
  }, [servers, field]);
}

export function useMCPIconMap(): Map<string, string> {
  return useMCPServerFieldMap('iconPath');
}

export function useMCPTitleMap(): Map<string, string> {
  return useMCPServerFieldMap('title');
}
