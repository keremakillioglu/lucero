const { Router } = require('express');
const OpenAI = require('openai');
const Anthropic = require('@anthropic-ai/sdk');
const { logger, getTenantId, tenantStorage } = require('@librechat/data-schemas');
const {
  CacheKeys,
  Constants,
  PermissionBits,
  PermissionTypes,
  Permissions,
  EModelEndpoint,
} = require('librechat-data-provider');
const {
  getBasePath,
  createSafeUser,
  MCPOAuthHandler,
  MCPTokenStorage,
  setOAuthSession,
  PENDING_STALE_MS,
  mcpConfig: mcpSettings,
  getUserMCPAuthMap,
  validateOAuthCsrf,
  OAUTH_CSRF_COOKIE,
  setOAuthCsrfCookie,
  generateCheckAccess,
  validateOAuthSession,
  OAUTH_SESSION_COOKIE,
} = require('@librechat/api');
const {
  createMCPServerController,
  updateMCPServerController,
  deleteMCPServerController,
  getMCPServersList,
  getMCPServerById,
  getMCPTools,
} = require('~/server/controllers/mcp');
const {
  getOAuthReconnectionManager,
  getMCPServersRegistry,
  getFlowStateManager,
  getMCPManager,
} = require('~/config');
const {
  getServerConnectionStatus,
  resolveAllMcpConfigs,
  resolveConfigServers,
  getMCPSetupData,
} = require('~/server/services/MCP');
const { requireJwtAuth, canAccessMCPServerResource } = require('~/server/middleware');
const { getUserPluginAuthValue } = require('~/server/services/PluginService');
const { updateMCPServerTools } = require('~/server/services/Config/mcp');
const { reinitMCPServer } = require('~/server/services/Tools/mcp');
const { getLogStores } = require('~/cache');
const db = require('~/models');

const router = Router();

const OAUTH_CSRF_COOKIE_PATH = '/api/mcp';

const getOAuthFlowId = (userId, serverName) =>
  MCPOAuthHandler.generateFlowId(userId, serverName, getTenantId());

const canAccessOAuthFlow = (flowId, userId) => {
  const parsed = MCPOAuthHandler.parseFlowId(flowId);
  if (!parsed) {
    return false;
  }
  if (parsed.tenantId && parsed.tenantId !== getTenantId()) {
    return false;
  }
  return parsed.userId === userId || parsed.userId === 'system';
};

const clearGetTokensFlow = async ({ flowManager, flowId, tokens }) => {
  const state = await flowManager.getFlowState(flowId, 'mcp_get_tokens');
  if (state?.type === 'mcp_get_tokens' && state.status === 'PENDING') {
    await flowManager.completeFlow(flowId, 'mcp_get_tokens', tokens);
    return;
  }
  await flowManager.deleteFlow(flowId, 'mcp_get_tokens');
};

const checkMCPUsePermissions = generateCheckAccess({
  permissionType: PermissionTypes.MCP_SERVERS,
  permissions: [Permissions.USE],
  getRoleByName: db.getRoleByName,
});

const checkMCPCreate = generateCheckAccess({
  permissionType: PermissionTypes.MCP_SERVERS,
  permissions: [Permissions.USE, Permissions.CREATE],
  getRoleByName: db.getRoleByName,
});

/**
 * Get all MCP tools available to the user
 * Returns only MCP tools, completely decoupled from regular LibreChat tools
 */
router.get('/tools', requireJwtAuth, checkMCPUsePermissions, async (req, res) => {
  return getMCPTools(req, res);
});

/**
 * Initiate OAuth flow
 * This endpoint is called when the user clicks the auth link in the UI
 */
router.get('/:serverName/oauth/initiate', requireJwtAuth, setOAuthSession, async (req, res) => {
  try {
    const { serverName } = req.params;
    const { userId, flowId } = req.query;
    const user = req.user;

    // Verify the userId matches the authenticated user
    if (typeof userId !== 'string' || userId !== user.id) {
      return res.status(403).json({ error: 'User mismatch' });
    }

    const expectedFlowId = getOAuthFlowId(user.id, serverName);
    if (typeof flowId !== 'string' || flowId !== expectedFlowId) {
      logger.error('[MCP OAuth] Invalid flow ID for initiate request', {
        serverName,
        userId,
        flowId,
        expectedFlowId,
      });
      return res.status(403).json({ error: 'Flow mismatch' });
    }

    logger.debug('[MCP OAuth] Initiate request', { serverName, userId, flowId });

    const flowsCache = getLogStores(CacheKeys.FLOWS);
    const flowManager = getFlowStateManager(flowsCache);

    /** Flow state to retrieve OAuth config */
    const flowState = await flowManager.getFlowState(flowId, 'mcp_oauth');
    if (!flowState) {
      logger.error('[MCP OAuth] Flow state not found', { flowId });
      return res.status(404).json({ error: 'Flow not found' });
    }

    const {
      authorizationUrl: storedAuthorizationUrl,
      serverName: flowServerName,
      userId: flowUserId,
      serverUrl,
      oauth: oauthConfig,
    } = flowState.metadata || {};

    if (flowUserId && flowUserId !== user.id) {
      logger.error('[MCP OAuth] Flow user mismatch', { flowId, userId, flowUserId });
      return res.status(403).json({ error: 'User mismatch' });
    }

    if (flowServerName && flowServerName !== serverName) {
      logger.error('[MCP OAuth] Flow server mismatch', { flowId, serverName, flowServerName });
      return res.status(400).json({ error: 'Invalid flow state' });
    }

    const pendingAge = flowState.createdAt ? Date.now() - flowState.createdAt : Infinity;
    const isFreshPendingFlow = flowState.status === 'PENDING' && pendingAge < PENDING_STALE_MS;
    if (!isFreshPendingFlow) {
      logger.error('[MCP OAuth] Flow is not active for initiation', {
        flowId,
        status: flowState.status,
        pendingAge,
      });
      return res.status(400).json({ error: 'Invalid flow state' });
    }

    if (typeof storedAuthorizationUrl === 'string' && storedAuthorizationUrl.length > 0) {
      logger.debug('[MCP OAuth] Reusing stored authorization URL', {
        serverName,
        userId,
        flowId,
      });
      setOAuthCsrfCookie(res, flowId, OAUTH_CSRF_COOKIE_PATH);
      return res.redirect(storedAuthorizationUrl);
    }

    if (!serverUrl || !oauthConfig) {
      logger.error('[MCP OAuth] Missing server URL or OAuth config in flow state');
      return res.status(400).json({ error: 'Invalid flow state' });
    }

    const configServers = await resolveConfigServers(req);
    const oauthHeaders = await getOAuthHeaders(serverName, userId, configServers);
    const registry = getMCPServersRegistry();
    const { allowedDomains, allowedAddresses } = await registry.resolveAllowlists({
      userId,
      role: req.user?.role,
    });
    const {
      authorizationUrl,
      flowId: oauthFlowId,
      flowMetadata,
    } = await MCPOAuthHandler.initiateOAuthFlow(
      serverName,
      serverUrl,
      userId,
      oauthHeaders,
      oauthConfig,
      allowedDomains,
      undefined,
      allowedAddresses,
      getTenantId(),
    );

    logger.debug('[MCP OAuth] OAuth flow initiated', { oauthFlowId, authorizationUrl });

    const oldState = flowState.metadata?.state;
    if (typeof oldState === 'string') {
      await MCPOAuthHandler.deleteStateMapping(oldState, flowManager);
    }
    const metadataWithUrl = { ...flowMetadata, authorizationUrl, tenantId: getTenantId() };
    await flowManager.initFlow(oauthFlowId, 'mcp_oauth', metadataWithUrl);
    await MCPOAuthHandler.storeStateMapping(flowMetadata.state, oauthFlowId, flowManager);
    setOAuthCsrfCookie(res, oauthFlowId, OAUTH_CSRF_COOKIE_PATH);
    res.redirect(authorizationUrl);
  } catch (error) {
    logger.error('[MCP OAuth] Failed to initiate OAuth', error);
    res.status(500).json({ error: 'Failed to initiate OAuth' });
  }
});

/**
 * OAuth callback handler
 * This handles the OAuth callback after the user has authorized the application
 */
router.get('/:serverName/oauth/callback', async (req, res) => {
  const basePath = getBasePath();
  try {
    const { serverName } = req.params;
    const { code, state, error: oauthError } = req.query;

    logger.debug('[MCP OAuth] Callback received', {
      serverName,
      code: code ? 'present' : 'missing',
      state,
      error: oauthError,
    });

    if (oauthError) {
      logger.error('[MCP OAuth] OAuth error received', { error: oauthError });
      // Gate failFlow behind callback validation to prevent DoS via leaked state
      if (state && typeof state === 'string') {
        try {
          const flowsCache = getLogStores(CacheKeys.FLOWS);
          const flowManager = getFlowStateManager(flowsCache);
          const flowId = await MCPOAuthHandler.resolveStateToFlowId(state, flowManager);
          if (flowId) {
            const parsed = MCPOAuthHandler.parseFlowId(flowId);
            if (!parsed) {
              logger.warn('[MCP OAuth] Invalid flow ID format for OAuth error callback', {
                flowId,
              });
            } else {
              const hasCsrf = validateOAuthCsrf(req, res, flowId, OAUTH_CSRF_COOKIE_PATH);
              const hasSession = !hasCsrf && validateOAuthSession(req, parsed.userId);
              if (hasCsrf || hasSession) {
                await flowManager.failFlow(flowId, 'mcp_oauth', String(oauthError));
                logger.debug('[MCP OAuth] Marked flow as FAILED with OAuth error', {
                  flowId,
                  error: oauthError,
                });
              }
            }
          }
        } catch (err) {
          logger.debug('[MCP OAuth] Could not mark flow as failed', err);
        }
      }
      return res.redirect(
        `${basePath}/oauth/error?error=${encodeURIComponent(String(oauthError))}`,
      );
    }

    if (!code || typeof code !== 'string') {
      logger.error('[MCP OAuth] Missing or invalid code');
      return res.redirect(`${basePath}/oauth/error?error=missing_code`);
    }

    if (!state || typeof state !== 'string') {
      logger.error('[MCP OAuth] Missing or invalid state');
      return res.redirect(`${basePath}/oauth/error?error=missing_state`);
    }

    const flowsCache = getLogStores(CacheKeys.FLOWS);
    const flowManager = getFlowStateManager(flowsCache);

    const flowId = await MCPOAuthHandler.resolveStateToFlowId(state, flowManager);
    if (!flowId) {
      logger.error('[MCP OAuth] Could not resolve state to flow ID', { state });
      return res.redirect(`${basePath}/oauth/error?error=invalid_state`);
    }
    logger.debug('[MCP OAuth] Resolved flow ID from state', { flowId });

    const parsedFlowId = MCPOAuthHandler.parseFlowId(flowId);
    if (!parsedFlowId) {
      logger.error('[MCP OAuth] Invalid flow ID format', { flowId });
      return res.redirect(`${basePath}/oauth/error?error=invalid_state`);
    }

    const hasCsrf = validateOAuthCsrf(req, res, flowId, OAUTH_CSRF_COOKIE_PATH);
    const hasSession = !hasCsrf && validateOAuthSession(req, parsedFlowId.userId);
    let hasActiveFlow = false;
    if (!hasCsrf && !hasSession) {
      const pendingFlow = await flowManager.getFlowState(flowId, 'mcp_oauth');
      const pendingAge = pendingFlow?.createdAt ? Date.now() - pendingFlow.createdAt : Infinity;
      hasActiveFlow = pendingFlow?.status === 'PENDING' && pendingAge < PENDING_STALE_MS;
      if (hasActiveFlow) {
        logger.debug(
          '[MCP OAuth] CSRF/session cookies absent, validating via active PENDING flow',
          {
            flowId,
          },
        );
      }
    }

    if (!hasCsrf && !hasSession && !hasActiveFlow) {
      logger.error(
        '[MCP OAuth] CSRF validation failed: no valid CSRF cookie, session cookie, or active flow',
        {
          flowId,
          hasCsrfCookie: !!req.cookies?.[OAUTH_CSRF_COOKIE],
          hasSessionCookie: !!req.cookies?.[OAUTH_SESSION_COOKIE],
        },
      );
      return res.redirect(`${basePath}/oauth/error?error=csrf_validation_failed`);
    }

    logger.debug('[MCP OAuth] Getting flow state for flowId: ' + flowId);
    const flowState = await MCPOAuthHandler.getFlowState(flowId, flowManager);

    if (!flowState) {
      logger.error('[MCP OAuth] Flow state not found for flowId:', flowId);
      return res.redirect(`${basePath}/oauth/error?error=invalid_state`);
    }

    logger.debug('[MCP OAuth] Flow state details', {
      serverName: flowState.serverName,
      userId: flowState.userId,
      hasMetadata: !!flowState.metadata,
      hasClientInfo: !!flowState.clientInfo,
      hasCodeVerifier: !!flowState.codeVerifier,
    });

    /** Check if this flow has already been completed (idempotency protection) */
    const currentFlowState = await flowManager.getFlowState(flowId, 'mcp_oauth');
    if (currentFlowState?.status === 'COMPLETED') {
      logger.warn('[MCP OAuth] Flow already completed, preventing duplicate token exchange', {
        flowId,
        serverName,
      });
      return res.redirect(`${basePath}/oauth/success?serverName=${encodeURIComponent(serverName)}`);
    }

    logger.debug('[MCP OAuth] Completing OAuth flow');
    if (!flowState.oauthHeaders) {
      logger.warn(
        '[MCP OAuth] oauthHeaders absent from flow state — config-source server oauth_headers will be empty',
        { serverName, flowId },
      );
    }
    /**
     * Restore tenant context for the callback body. The callback is a cross-origin
     * redirect from the OAuth provider, so SameSite=Strict cookies (including the
     * JWT) are not sent. The tenantId was stored in the flow metadata at initiation
     * time when the user was authenticated.
     */
    const runWithTenant = async (fn) => {
      const flowTenantId = flowState.tenantId;
      if (flowTenantId && !getTenantId()) {
        return tenantStorage.run({ tenantId: flowTenantId }, fn);
      }
      return fn();
    };

    await runWithTenant(async () => {
      const oauthHeaders =
        flowState.oauthHeaders ?? (await getOAuthHeaders(serverName, flowState.userId));
      const tokens = await MCPOAuthHandler.completeOAuthFlow(
        flowId,
        code,
        flowManager,
        oauthHeaders,
      );
      logger.info('[MCP OAuth] OAuth flow completed, tokens received in callback route');

      /** Persist tokens immediately so reconnection uses fresh credentials */
      if (flowState?.userId && tokens) {
        try {
          await MCPTokenStorage.storeTokens({
            userId: flowState.userId,
            serverName,
            tokens,
            createToken: db.createToken,
            updateToken: db.updateToken,
            findToken: db.findToken,
            clientInfo: flowState.clientInfo,
            metadata: MCPOAuthHandler.buildStoredClientMetadata(
              flowState.metadata,
              flowState.resourceMetadata,
            ),
          });
          logger.debug('[MCP OAuth] Stored OAuth tokens prior to reconnection', {
            serverName,
            userId: flowState.userId,
          });
        } catch (error) {
          logger.error('[MCP OAuth] Failed to store OAuth tokens after callback', error);
          throw error;
        }

        /**
         * Clear any cached `mcp_get_tokens` flow result so subsequent lookups
         * re-fetch the freshly stored credentials instead of returning stale nulls.
         */
        if (typeof flowManager?.deleteFlow === 'function') {
          try {
            const tokenFlowId = MCPOAuthHandler.generateTokenFlowId(
              flowState.userId,
              serverName,
              flowState.tenantId,
            );
            await clearGetTokensFlow({
              flowManager,
              flowId: tokenFlowId,
              tokens,
            });
            if (tokenFlowId !== flowId) {
              await clearGetTokensFlow({
                flowManager,
                flowId,
                tokens,
              });
            }
          } catch (error) {
            logger.warn('[MCP OAuth] Failed to clear cached token flow state', error);
          }
        }
      }

      try {
        const mcpManager = getMCPManager(flowState.userId);
        logger.debug(`[MCP OAuth] Attempting to reconnect ${serverName} with new OAuth tokens`);

        if (flowState.userId !== 'system') {
          const user = { id: flowState.userId };

          /** Merged config (incl. Config-tier overlays) so the reconnection and
           *  the cache gate both see request-scoped servers the base registry
           *  lookup misses */
          let serverConfig;
          try {
            const allConfigs = await resolveAllMcpConfigs(flowState.userId);
            serverConfig = allConfigs?.[serverName];
          } catch (error) {
            logger.warn(
              `[MCP OAuth] Could not resolve server config for ${serverName} before reconnecting:`,
              error,
            );
          }

          const userConnection = await mcpManager.getUserConnection({
            user,
            serverName,
            flowManager,
            serverConfig,
            tokenMethods: {
              findToken: db.findToken,
              updateToken: db.updateToken,
              createToken: db.createToken,
              deleteTokens: db.deleteTokens,
            },
          });

          logger.info(
            `[MCP OAuth] Successfully reconnected ${serverName} for user ${flowState.userId}`,
          );

          const oauthReconnectionManager = getOAuthReconnectionManager();
          oauthReconnectionManager.clearReconnection(flowState.userId, serverName);

          const tools = await userConnection.fetchTools();
          await updateMCPServerTools({
            userId: flowState.userId,
            serverName,
            tools,
            serverConfig,
          });
        } else {
          logger.debug(`[MCP OAuth] System-level OAuth completed for ${serverName}`);
        }
      } catch (error) {
        logger.warn(
          `[MCP OAuth] Failed to reconnect ${serverName} after OAuth, but tokens are saved:`,
          error,
        );
      }

      /** ID of the flow that the tool/connection is waiting for */
      const toolFlowId = flowState.metadata?.toolFlowId;
      if (toolFlowId) {
        logger.debug('[MCP OAuth] Completing tool flow', { toolFlowId });
        const completed = await flowManager.completeFlow(toolFlowId, 'mcp_oauth', tokens);
        if (!completed) {
          logger.warn(
            '[MCP OAuth] Tool flow state not found during completion — waiter will time out',
            { toolFlowId },
          );
        }
      }
    }); /* end runWithTenant */

    /** Redirect to success page with flowId and serverName */
    const redirectUrl = `${basePath}/oauth/success?serverName=${encodeURIComponent(serverName)}`;
    res.redirect(redirectUrl);
  } catch (error) {
    logger.error('[MCP OAuth] OAuth callback error', error);
    res.redirect(`${basePath}/oauth/error?error=callback_failed`);
  }
});

/**
 * Get OAuth tokens for a completed flow
 * This is primarily for user-level OAuth flows
 */
router.get('/oauth/tokens/:flowId', requireJwtAuth, async (req, res) => {
  try {
    const { flowId } = req.params;
    const user = req.user;

    if (!user?.id) {
      return res.status(401).json({ error: 'User not authenticated' });
    }

    if (!canAccessOAuthFlow(flowId, user.id)) {
      return res.status(403).json({ error: 'Access denied' });
    }

    const flowsCache = getLogStores(CacheKeys.FLOWS);
    const flowManager = getFlowStateManager(flowsCache);

    const flowState = await flowManager.getFlowState(flowId, 'mcp_oauth');
    if (!flowState) {
      return res.status(404).json({ error: 'Flow not found' });
    }

    if (flowState.status !== 'COMPLETED') {
      return res.status(400).json({ error: 'Flow not completed' });
    }

    res.json({ tokens: flowState.result });
  } catch (error) {
    logger.error('[MCP OAuth] Failed to get tokens', error);
    res.status(500).json({ error: 'Failed to get tokens' });
  }
});

/**
 * Set CSRF binding cookie for OAuth flows initiated outside of HTTP request/response
 * (e.g. during chat via SSE). The frontend should call this before opening the OAuth URL
 * so the callback can verify the browser matches the flow initiator.
 */
router.post('/:serverName/oauth/bind', requireJwtAuth, setOAuthSession, async (req, res) => {
  try {
    const { serverName } = req.params;
    const user = req.user;

    if (!user?.id) {
      return res.status(401).json({ error: 'User not authenticated' });
    }

    const flowId = getOAuthFlowId(user.id, serverName);
    setOAuthCsrfCookie(res, flowId, OAUTH_CSRF_COOKIE_PATH);

    res.json({ success: true });
  } catch (error) {
    logger.error('[MCP OAuth] Failed to set CSRF binding cookie', error);
    res.status(500).json({ error: 'Failed to bind OAuth flow' });
  }
});

/**
 * Check OAuth flow status
 * This endpoint can be used to poll the status of an OAuth flow
 */
router.get('/oauth/status/:flowId', requireJwtAuth, async (req, res) => {
  try {
    const { flowId } = req.params;
    const user = req.user;

    if (!user?.id) {
      return res.status(401).json({ error: 'User not authenticated' });
    }

    if (!canAccessOAuthFlow(flowId, user.id)) {
      return res.status(403).json({ error: 'Access denied' });
    }

    const flowsCache = getLogStores(CacheKeys.FLOWS);
    const flowManager = getFlowStateManager(flowsCache);

    const flowState = await flowManager.getFlowState(flowId, 'mcp_oauth');
    if (!flowState) {
      return res.status(404).json({ error: 'Flow not found' });
    }

    res.json({
      status: flowState.status,
      completed: flowState.status === 'COMPLETED',
      failed: flowState.status === 'FAILED',
      error: flowState.error,
    });
  } catch (error) {
    logger.error('[MCP OAuth] Failed to get flow status', error);
    res.status(500).json({ error: 'Failed to get flow status' });
  }
});

/**
 * Cancel OAuth flow
 * This endpoint cancels a pending OAuth flow
 */
router.post('/oauth/cancel/:serverName', requireJwtAuth, async (req, res) => {
  try {
    const { serverName } = req.params;
    const user = req.user;

    if (!user?.id) {
      return res.status(401).json({ error: 'User not authenticated' });
    }

    logger.info(`[MCP OAuth Cancel] Cancelling OAuth flow for ${serverName} by user ${user.id}`);

    const flowsCache = getLogStores(CacheKeys.FLOWS);
    const flowManager = getFlowStateManager(flowsCache);
    const flowId = getOAuthFlowId(user.id, serverName);
    const flowState = await flowManager.getFlowState(flowId, 'mcp_oauth');

    if (!flowState) {
      logger.debug(`[MCP OAuth Cancel] No active flow found for ${serverName}`);
      return res.json({
        success: true,
        message: 'No active OAuth flow to cancel',
      });
    }

    await flowManager.failFlow(flowId, 'mcp_oauth', 'User cancelled OAuth flow');

    logger.info(`[MCP OAuth Cancel] Successfully cancelled OAuth flow for ${serverName}`);

    res.json({
      success: true,
      message: `OAuth flow for ${serverName} cancelled successfully`,
    });
  } catch (error) {
    logger.error('[MCP OAuth Cancel] Failed to cancel OAuth flow', error);
    res.status(500).json({ error: 'Failed to cancel OAuth flow' });
  }
});

/**
 * Reinitialize MCP server
 * This endpoint allows reinitializing a specific MCP server
 */
router.post(
  '/:serverName/reinitialize',
  requireJwtAuth,
  checkMCPUsePermissions,
  setOAuthSession,
  async (req, res) => {
    try {
      const { serverName } = req.params;
      const user = createSafeUser(req.user);

      if (!user.id) {
        return res.status(401).json({ error: 'User not authenticated' });
      }

      logger.info(`[MCP Reinitialize] Reinitializing server: ${serverName}`);

      const mcpManager = getMCPManager();
      const configServers = await resolveConfigServers(req);
      const serverConfig = await getMCPServersRegistry().getServerConfig(
        serverName,
        user.id,
        configServers,
      );
      if (!serverConfig) {
        return res.status(404).json({
          error: `MCP server '${serverName}' not found in configuration`,
        });
      }

      await mcpManager.disconnectUserConnection(user.id, serverName);
      logger.info(
        `[MCP Reinitialize] Disconnected existing user connection for server: ${serverName}`,
      );

      /** @type {Record<string, Record<string, string>> | undefined} */
      let userMCPAuthMap;
      if (serverConfig.customUserVars && typeof serverConfig.customUserVars === 'object') {
        userMCPAuthMap = await getUserMCPAuthMap({
          userId: user.id,
          servers: [serverName],
          findPluginAuthsByKeys: db.findPluginAuthsByKeys,
        });
      }

      const result = await reinitMCPServer({
        user,
        serverName,
        serverConfig,
        configServers,
        userMCPAuthMap,
      });

      if (!result) {
        return res.status(500).json({ error: 'Failed to reinitialize MCP server for user' });
      }

      const { success, message, oauthRequired, oauthUrl } = result;

      if (oauthRequired) {
        const flowId = getOAuthFlowId(user.id, serverName);
        setOAuthCsrfCookie(res, flowId, OAUTH_CSRF_COOKIE_PATH);
      }

      res.json({
        success,
        message,
        oauthUrl,
        serverName,
        oauthRequired,
      });
    } catch (error) {
      logger.error('[MCP Reinitialize] Unexpected error', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  },
);

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

/**
 * Call a tool on an MCP server and return its text content
 * Used by the MCP Views panel to display server data outside of chat
 */
router.post(
  '/:serverName/tools/:toolName/call',
  requireJwtAuth,
  checkMCPUsePermissions,
  async (req, res) => {
    try {
      const { serverName, toolName } = req.params;
      const user = createSafeUser(req.user);

      if (!user.id) {
        return res.status(401).json({ error: 'User not authenticated' });
      }

      const toolArguments = req.body?.toolArguments ?? {};
      if (typeof toolArguments !== 'object' || Array.isArray(toolArguments)) {
        return res.status(400).json({ error: '`toolArguments` must be an object' });
      }

      const result = await resolveAndCallTool({ req, user, serverName, toolName, toolArguments });
      res.json({ success: true, serverName, toolName, result });
    } catch (error) {
      if (error?.status === 404) {
        return res.status(404).json({ error: error.message });
      }
      logger.error('[MCP Tool Call] Tool call failed', error);
      res.status(500).json({ error: error?.message || 'Failed to call MCP tool' });
    }
  },
);

const SUGGEST_MODEL = 'claude-opus-5';
const OPENAI_SUGGEST_MODEL = 'gpt-5.5';
const SUGGEST_MAX_TURNS = 10;
const SUGGEST_RESULT_CHAR_LIMIT = 8000;

const isRealKey = (value) =>
  typeof value === 'string' && value.length > 0 && value !== 'user_provided';

/** Resolves an Anthropic API key: server-level env var, else the user's stored key */
async function resolveAnthropicApiKey(userId) {
  const envKey = process.env.ANTHROPIC_API_KEY;
  if (isRealKey(envKey)) {
    return envKey;
  }
  try {
    const values = await db.getUserKeyValues({ userId, name: EModelEndpoint.anthropic });
    return values?.apiKey;
  } catch {
    return undefined;
  }
}

async function runAnthropicSuggestLoop({ apiKey, system, userPrompt, executeTool }) {
  const anthropic = new Anthropic({ apiKey });
  const messages = [{ role: 'user', content: userPrompt }];
  let proposal = null;

  for (let turn = 0; turn < SUGGEST_MAX_TURNS && !proposal; turn++) {
    const response = await anthropic.messages.create({
      model: SUGGEST_MODEL,
      max_tokens: 16000,
      system,
      tools: suggestTools,
      messages,
    });
    messages.push({ role: 'assistant', content: response.content });
    if (response.stop_reason !== 'tool_use') {
      break;
    }

    const toolResults = [];
    for (const block of response.content) {
      if (block.type !== 'tool_use') {
        continue;
      }
      if (block.name === 'propose_views') {
        proposal = block.input;
        toolResults.push({
          type: 'tool_result',
          tool_use_id: block.id,
          content: 'Views received.',
        });
        continue;
      }
      const { content, isError } = await executeTool(block.input);
      toolResults.push({ type: 'tool_result', tool_use_id: block.id, content, is_error: isError });
    }
    messages.push({ role: 'user', content: toolResults });
  }

  return proposal;
}

async function runOpenAISuggestLoop({ system, userPrompt, executeTool }) {
  const openai = new OpenAI();
  const tools = suggestTools.map((tool) => ({
    type: 'function',
    function: { name: tool.name, description: tool.description, parameters: tool.input_schema },
  }));
  const messages = [
    { role: 'system', content: system },
    { role: 'user', content: userPrompt },
  ];
  let proposal = null;

  for (let turn = 0; turn < SUGGEST_MAX_TURNS && !proposal; turn++) {
    const completion = await openai.chat.completions.create({
      model: OPENAI_SUGGEST_MODEL,
      tools,
      messages,
    });
    const message = completion.choices[0]?.message;
    if (!message) {
      break;
    }
    messages.push(message);

    const toolCalls = message.tool_calls ?? [];
    if (toolCalls.length === 0) {
      break;
    }
    for (const call of toolCalls) {
      let input;
      try {
        input = JSON.parse(call.function.arguments || '{}');
      } catch {
        input = {};
      }
      if (call.function.name === 'propose_views') {
        proposal = input;
        messages.push({ role: 'tool', tool_call_id: call.id, content: 'Views received.' });
        continue;
      }
      const { content } = await executeTool(input);
      messages.push({ role: 'tool', tool_call_id: call.id, content });
    }
  }

  return proposal;
}

const suggestTools = [
  {
    name: 'call_mcp_tool',
    description:
      "Call a tool on one of the user's MCP data sources and return its result. Use for cheap discovery calls (listing apps, filters, metrics) and to verify the exact arguments you plan to use in a view actually return chartable rows.",
    input_schema: {
      type: 'object',
      properties: {
        serverName: { type: 'string', description: 'One of the listed data sources' },
        toolName: { type: 'string', description: 'A tool belonging to that source' },
        arguments: { type: 'object', description: 'Arguments for the tool' },
      },
      required: ['serverName', 'toolName'],
    },
  },
  {
    name: 'propose_views',
    description:
      'Submit the final dashboard views. Call exactly once, only after verifying the arguments return meaningful data.',
    input_schema: {
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
              arguments: { type: 'object' },
              display: { type: 'string', enum: ['line', 'bar', 'table'] },
            },
            required: ['title', 'serverName', 'toolName', 'arguments', 'display'],
          },
        },
      },
      required: ['views'],
    },
  },
];

const buildSuggestSystemPrompt = (catalog) =>
  `You are a data analyst embedded in a dashboard builder. Today's date is ${new Date().toISOString().slice(0, 10)}.

The user's data sources (MCP servers) and their tools:
${catalog}

Workflow:
1. Explore with call_mcp_tool — discovery first (list apps, filters, available metrics), then verify the exact arguments for each view you plan to propose. Keep exploration lean.
2. Call propose_views exactly once with 3-6 views.

View rendering rules: each view runs one tool call and charts the first array of records in the result. The x axis is a date/label column and the series are numeric columns. Prefer daily time series (display "line") over single totals; use "bar" for categorical comparisons and "table" only when data is not chartable. Arguments must be exactly valid for the tool — never guess enum values you have not seen.`;

/**
 * Suggest dashboard views using an LLM that explores the user's MCP sources
 */
router.post('/views/suggest', requireJwtAuth, checkMCPUsePermissions, async (req, res) => {
  try {
    const user = createSafeUser(req.user);
    if (!user.id) {
      return res.status(401).json({ error: 'User not authenticated' });
    }

    const { prompt, servers } = req.body ?? {};
    if (!servers || typeof servers !== 'object' || Array.isArray(servers)) {
      return res.status(400).json({ error: '`servers` catalog is required' });
    }

    const catalog = Object.entries(servers)
      .map(([serverName, server]) => {
        const tools = (server?.tools ?? [])
          .map((tool) => `  - ${tool.name}: ${(tool.description || '').slice(0, 300)}`)
          .join('\n');
        return `${serverName}:\n${tools}`;
      })
      .join('\n');

    const userPrompt =
      typeof prompt === 'string' && prompt.trim()
        ? prompt
        : 'Propose the most meaningful views across my sources.';
    const system = buildSuggestSystemPrompt(catalog);

    const executeTool = async (input) => {
      try {
        const result = await resolveAndCallTool({
          req,
          user,
          serverName: input?.serverName,
          toolName: input?.toolName,
          toolArguments: input?.arguments ?? {},
        });
        const content =
          result.length > SUGGEST_RESULT_CHAR_LIMIT
            ? `${result.slice(0, SUGGEST_RESULT_CHAR_LIMIT)}\n…[truncated]`
            : result;
        return { content, isError: false };
      } catch (error) {
        return { content: error?.message || 'Tool call failed', isError: true };
      }
    };

    const anthropicKey = await resolveAnthropicApiKey(user.id);
    let proposal = null;
    if (anthropicKey) {
      proposal = await runAnthropicSuggestLoop({
        apiKey: anthropicKey,
        system,
        userPrompt,
        executeTool,
      });
    } else if (isRealKey(process.env.OPENAI_API_KEY)) {
      proposal = await runOpenAISuggestLoop({ system, userPrompt, executeTool });
    } else {
      return res.status(400).json({
        error: 'No LLM API key available. Configure an Anthropic or OpenAI key first.',
      });
    }

    if (!proposal || !Array.isArray(proposal.views)) {
      return res.status(502).json({ error: 'The model did not produce view suggestions' });
    }

    res.json({ success: true, views: proposal.views, notes: proposal.notes });
  } catch (error) {
    logger.error('[MCP Views Suggest] Failed to suggest views', error);
    res.status(500).json({ error: error?.message || 'Failed to suggest views' });
  }
});

/**
 * Get connection status for all MCP servers
 * This endpoint returns all app level and user-scoped connection statuses from MCPManager without disconnecting idle connections
 */
router.get('/connection/status', requireJwtAuth, async (req, res) => {
  try {
    const user = req.user;

    if (!user?.id) {
      return res.status(401).json({ error: 'User not authenticated' });
    }

    const { mcpConfig, appConnections, userConnections, oauthServers } = await getMCPSetupData(
      user.id,
      { role: user.role, tenantId: getTenantId() },
    );
    const connectionStatus = {};

    for (const [serverName, config] of Object.entries(mcpConfig)) {
      try {
        connectionStatus[serverName] = await getServerConnectionStatus(
          user.id,
          serverName,
          config,
          appConnections,
          userConnections,
          oauthServers,
        );
      } catch (error) {
        const message = `Failed to get status for server "${serverName}"`;
        logger.error(`[MCP Connection Status] ${message},`, error);
        connectionStatus[serverName] = {
          connectionState: 'error',
          requiresOAuth: oauthServers.has(serverName),
          error: message,
        };
      }
    }

    res.json({
      success: true,
      connectionStatus,
      oauthTimeout: mcpSettings.OAUTH_HANDLING_TIMEOUT,
    });
  } catch (error) {
    logger.error('[MCP Connection Status] Failed to get connection status', error);
    res.status(500).json({ error: 'Failed to get connection status' });
  }
});

/**
 * Get connection status for a single MCP server
 * This endpoint returns the connection status for a specific server for a given user
 */
router.get('/connection/status/:serverName', requireJwtAuth, async (req, res) => {
  try {
    const user = req.user;
    const { serverName } = req.params;

    if (!user?.id) {
      return res.status(401).json({ error: 'User not authenticated' });
    }

    const { mcpConfig, appConnections, userConnections, oauthServers } = await getMCPSetupData(
      user.id,
      { role: user.role, tenantId: getTenantId() },
    );

    if (!mcpConfig[serverName]) {
      return res
        .status(404)
        .json({ error: `MCP server '${serverName}' not found in configuration` });
    }

    const serverStatus = await getServerConnectionStatus(
      user.id,
      serverName,
      mcpConfig[serverName],
      appConnections,
      userConnections,
      oauthServers,
    );

    res.json({
      success: true,
      serverName,
      connectionStatus: serverStatus.connectionState,
      requiresOAuth: serverStatus.requiresOAuth,
    });
  } catch (error) {
    logger.error(
      `[MCP Per-Server Status] Failed to get connection status for ${req.params.serverName}`,
      error,
    );
    res.status(500).json({ error: 'Failed to get connection status' });
  }
});

/**
 * Check which authentication values exist for a specific MCP server
 * This endpoint returns only boolean flags indicating if values are set, not the actual values
 */
router.get('/:serverName/auth-values', requireJwtAuth, checkMCPUsePermissions, async (req, res) => {
  try {
    const { serverName } = req.params;
    const user = req.user;

    if (!user?.id) {
      return res.status(401).json({ error: 'User not authenticated' });
    }

    const configServers = await resolveConfigServers(req);
    const serverConfig = await getMCPServersRegistry().getServerConfig(
      serverName,
      user.id,
      configServers,
    );
    if (!serverConfig) {
      return res.status(404).json({
        error: `MCP server '${serverName}' not found in configuration`,
      });
    }

    const pluginKey = `${Constants.mcp_prefix}${serverName}`;
    const authValueFlags = {};

    if (serverConfig.customUserVars && typeof serverConfig.customUserVars === 'object') {
      for (const varName of Object.keys(serverConfig.customUserVars)) {
        try {
          const value = await getUserPluginAuthValue(user.id, varName, false, pluginKey);
          authValueFlags[varName] = !!(value && value.length > 0);
        } catch (err) {
          logger.error(
            `[MCP Auth Value Flags] Error checking ${varName} for user ${user.id}:`,
            err,
          );
          authValueFlags[varName] = false;
        }
      }
    }

    res.json({
      success: true,
      serverName,
      authValueFlags,
    });
  } catch (error) {
    logger.error(
      `[MCP Auth Value Flags] Failed to check auth value flags for ${req.params.serverName}`,
      error,
    );
    res.status(500).json({ error: 'Failed to check auth value flags' });
  }
});

async function getOAuthHeaders(serverName, userId, configServers) {
  const serverConfig = await getMCPServersRegistry().getServerConfig(
    serverName,
    userId,
    configServers,
  );
  return serverConfig?.oauth_headers ?? {};
}

/**
MCP Server CRUD Routes (User-Managed MCP Servers)
*/

/**
 * Get list of accessible MCP servers
 * @route GET /api/mcp/servers
 * @param {Object} req.query - Query parameters for pagination and search
 * @param {number} [req.query.limit] - Number of results per page
 * @param {string} [req.query.after] - Pagination cursor
 * @param {string} [req.query.search] - Search query for title/description
 * @returns {MCPServerListResponse} 200 - Success response - application/json
 */
router.get('/servers', requireJwtAuth, checkMCPUsePermissions, getMCPServersList);

/**
 * Create a new MCP server
 * @route POST /api/mcp/servers
 * @param {MCPServerCreateParams} req.body - The MCP server creation parameters.
 * @returns {MCPServer} 201 - Success response - application/json
 */
router.post('/servers', requireJwtAuth, checkMCPCreate, createMCPServerController);

/**
 * Get single MCP server by ID
 * @route GET /api/mcp/servers/:serverName
 * @param {string} req.params.serverName - MCP server identifier.
 * @returns {MCPServer} 200 - Success response - application/json
 */
router.get(
  '/servers/:serverName',
  requireJwtAuth,
  checkMCPUsePermissions,
  canAccessMCPServerResource({
    requiredPermission: PermissionBits.VIEW,
    resourceIdParam: 'serverName',
  }),
  getMCPServerById,
);

/**
 * Update MCP server
 * @route PATCH /api/mcp/servers/:serverName
 * @param {string} req.params.serverName - MCP server identifier.
 * @param {MCPServerUpdateParams} req.body - The MCP server update parameters.
 * @returns {MCPServer} 200 - Success response - application/json
 */
router.patch(
  '/servers/:serverName',
  requireJwtAuth,
  checkMCPCreate,
  canAccessMCPServerResource({
    requiredPermission: PermissionBits.EDIT,
    resourceIdParam: 'serverName',
  }),
  updateMCPServerController,
);

/**
 * Delete MCP server
 * @route DELETE /api/mcp/servers/:serverName
 * @param {string} req.params.serverName - MCP server identifier.
 * @returns {Object} 200 - Success response - application/json
 */
router.delete(
  '/servers/:serverName',
  requireJwtAuth,
  checkMCPCreate,
  canAccessMCPServerResource({
    requiredPermission: PermissionBits.DELETE,
    resourceIdParam: 'serverName',
  }),
  deleteMCPServerController,
);

module.exports = router;
