const { logger } = require('@librechat/data-schemas');
const { CacheKeys, Constants } = require('librechat-data-provider');
const {
  createSafeUser,
  getUserMCPAuthMap,
  createDashboardSnapshots,
  createDashboardRefreshHandler,
} = require('@librechat/api');
const { getMCPServersRegistry, getFlowStateManager, getMCPManager } = require('~/config');
const { resolveConfigServers } = require('~/server/services/MCP');
const { getLogStores } = require('~/cache');
const db = require('~/models');

/**
 * Resolves server config and auth for a user, calls an MCP tool, and returns its text content.
 * Throws an Error with a `status` property on resolution failures.
 */
async function resolveAndCallTool({ req, user, serverName, toolName, toolArguments }) {
  const configServers = await resolveConfigServers(req);
  const serverConfig = await getMCPServersRegistry().getServerConfig(
    serverName,
    user.id,
    configServers,
  );
  if (!serverConfig) {
    const error = new Error(`MCP server '${serverName}' not found in configuration`);
    error.status = 404;
    throw error;
  }

  /** @type {Record<string, string> | undefined} */
  let customUserVars;
  if (serverConfig.customUserVars && typeof serverConfig.customUserVars === 'object') {
    const userMCPAuthMap = await getUserMCPAuthMap({
      userId: user.id,
      servers: [serverName],
      findPluginAuthsByKeys: db.findPluginAuthsByKeys,
    });
    customUserVars = userMCPAuthMap?.[`${Constants.mcp_prefix}${serverName}`];
  }

  const flowsCache = getLogStores(CacheKeys.FLOWS);
  const flowManager = getFlowStateManager(flowsCache);

  const [content] = await getMCPManager().callTool({
    user,
    serverName,
    serverConfig,
    toolName,
    provider: 'openai',
    toolArguments,
    customUserVars,
    flowManager,
    tokenMethods: {
      findToken: db.findToken,
      createToken: db.createToken,
      updateToken: db.updateToken,
      deleteTokens: db.deleteTokens,
    },
  });

  return typeof content === 'string' ? content : JSON.stringify(content, null, 2);
}

const dashboardSnapshots = createDashboardSnapshots({
  getViewsDashboard: db.getViewsDashboard,
  saveViewsDashboardSnapshots: db.saveViewsDashboardSnapshots,
});

/** Tool runner for dashboard cards, bound to the request and its user */
const runCardFor =
  (req, user = createSafeUser(req.user)) =>
  (call) =>
    resolveAndCallTool({ req, user, ...call });

/** Re-runs every card of the caller's dashboard and responds with the refreshed dashboard */
const refreshViewsDashboard = createDashboardRefreshHandler({
  refresh: dashboardSnapshots.refresh,
  runCardFor,
});

/**
 * Refreshes the user's dashboard in the background right after a sign-in, so the dashboard opens
 * with this session's data. Never throws: a failed refresh only leaves the previous snapshots.
 */
function refreshDashboardOnLogin(req, rawUser) {
  const user = createSafeUser(rawUser);
  if (!user.id) {
    return;
  }
  dashboardSnapshots.refresh(user.id, runCardFor(req, user)).catch((error) => {
    logger.warn(`[Dashboard] Sign-in refresh failed for user ${user.id}:`, error);
  });
}

module.exports = { resolveAndCallTool, refreshViewsDashboard, refreshDashboardOnLogin };
