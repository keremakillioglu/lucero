const { createEnrollmentControllers, clearCloudFrontCookies } = require('@librechat/api');
const {
  verifyTOTP,
  getTOTPSecret,
  verifyBackupCode,
  generateBackupCodes,
} = require('~/server/services/twoFactorService');
const { refreshDashboardOnLogin } = require('~/server/services/Views/snapshots');
const { setAuthTokens } = require('~/server/services/AuthService');

/** Issues the session like the plain service, then refreshes the dashboard for this sign-in */
const setAuthTokensAndRefreshDashboard = async (userId, res, session, req) => {
  const token = await setAuthTokens(userId, res, session, req);
  refreshDashboardOnLogin(req, { id: String(userId) });
  return token;
};
const { getUserById, updateTwoFactorEnrollment, deleteAllUserSessions } = require('~/models');

module.exports = createEnrollmentControllers({
  getUserById,
  getTOTPSecret,
  verifyTOTP,
  verifyBackupCode,
  generateBackupCodes,
  updateTwoFactorEnrollment,
  deleteAllUserSessions,
  setAuthTokens: setAuthTokensAndRefreshDashboard,
  clearCloudFrontCookies,
});
