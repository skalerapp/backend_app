const request = require('supertest');
const app = require('../src/server');

describe('App version endpoint', () => {
  const previousValues = {
    APP_LATEST_VERSION: process.env.APP_LATEST_VERSION,
    APP_MIN_VERSION: process.env.APP_MIN_VERSION,
    APP_LATEST_BUILD_NUMBER: process.env.APP_LATEST_BUILD_NUMBER,
    APP_VERSION_CHECK_ENABLED: process.env.APP_VERSION_CHECK_ENABLED,
    APP_ANDROID_DOWNLOAD_URL: process.env.APP_ANDROID_DOWNLOAD_URL,
    APP_GITHUB_RELEASES_URL: process.env.APP_GITHUB_RELEASES_URL,
  };

  afterEach(() => {
    Object.entries(previousValues).forEach(([key, value]) => {
      if (value == null) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    });
  });

  it('GET /api/app/version returns production version metadata', async () => {
    process.env.APP_LATEST_VERSION = '1.2.3';
    process.env.APP_MIN_VERSION = '1.2.0';
    process.env.APP_LATEST_BUILD_NUMBER = '15';
    process.env.APP_ANDROID_DOWNLOAD_URL = 'https://github.com/empresa/skaler/releases/download/v1.2.3/skaler.apk';
    process.env.APP_GITHUB_RELEASES_URL = 'https://github.com/empresa/skaler/releases/latest';

    const res = await request(app).get('/api/app/version');

    expect(res.statusCode).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.latestVersion).toBe('1.2.3');
    expect(res.body.data.minVersion).toBe('1.2.0');
    expect(res.body.data.latestBuildNumber).toBe(15);
    expect(res.body.data.androidDownloadUrl).toContain('skaler.apk');
    expect(res.body.data.githubReleasesUrl).toContain('releases/latest');
  });
});
