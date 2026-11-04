const { createLoginController, clearCloudFrontCookies } = require('@librechat/api');
const { generate2FATempToken } = require('~/server/services/twoFactorService');
const { refreshDashboardOnLogin } = require('~/server/services/Views/snapshots');
const { getUserById, deleteAllUserSessions } = require('~/models');
const { setAuthTokens } = require('~/server/services/AuthService');

/** Issues the session like the plain service, then refreshes the dashboard for this sign-in */
const setAuthTokensAndRefreshDashboard = async (userId, res, session, req) => {
  const token = await setAuthTokens(userId, res, session, req);
  refreshDashboardOnLogin(req, { id: String(userId) });
  return token;
};

const loginController = createLoginController({
  generate2FATempToken,
  getUserById,
  deleteAllUserSessions,
  setAuthTokens: setAuthTokensAndRefreshDashboard,
  clearCloudFrontCookies,
});

module.exports = { loginController };
