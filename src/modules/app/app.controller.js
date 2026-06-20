const parseBoolean = (value, fallback = false) => {
  if (value == null) return fallback;
  const normalized = value.toString().trim().toLowerCase();
  if (!normalized) return fallback;
  return !['0', 'false', 'no', 'off'].includes(normalized);
};

const parsePositiveInt = (value, fallback) => {
  const parsed = Number.parseInt((value ?? '').toString().trim(), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

const normalizeUrl = (value) => (value || '').toString().trim().replace(/\/$/, '');

const getAppVersionInfo = (req, res) => {
  const latestVersion = (process.env.APP_LATEST_VERSION || '1.0.0').toString().trim();
  const minVersion = (process.env.APP_MIN_VERSION || latestVersion).toString().trim();
  const latestBuildNumber = parsePositiveInt(process.env.APP_LATEST_BUILD_NUMBER, 1);
  const minBuildNumber = parsePositiveInt(process.env.APP_MIN_BUILD_NUMBER, latestBuildNumber);
  const enabled = parseBoolean(process.env.APP_VERSION_CHECK_ENABLED, true);

  const androidDownloadUrl = normalizeUrl(process.env.APP_ANDROID_DOWNLOAD_URL);
  const webAppUrl = normalizeUrl(
    process.env.APP_WEB_URL ||
    process.env.WEB_APP_URL ||
    process.env.FRONTEND_URL ||
    process.env.DASHBOARD_URL,
  );
  const githubReleasesUrl = normalizeUrl(process.env.APP_GITHUB_RELEASES_URL);

  res.json({
    success: true,
    data: {
      enabled,
      latestVersion,
      minVersion,
      latestBuildNumber,
      minBuildNumber,
      androidDownloadUrl: androidDownloadUrl || null,
      webAppUrl: webAppUrl || null,
      githubReleasesUrl: githubReleasesUrl || null,
      releaseNotes: (process.env.APP_RELEASE_NOTES || '').toString().trim() || null,
    },
  });
};

module.exports = {
  getAppVersionInfo,
};
