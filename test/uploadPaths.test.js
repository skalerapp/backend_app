const path = require('path');
const {
  toPublicUploadPath,
  normalizeStoredUploadPath,
  resolveUploadRoot,
} = require('../src/utils/uploadPaths');

describe('uploadPaths', () => {
  const originalUploadDir = process.env.UPLOAD_DIR;

  afterEach(() => {
    if (originalUploadDir === undefined) {
      delete process.env.UPLOAD_DIR;
    } else {
      process.env.UPLOAD_DIR = originalUploadDir;
    }
    jest.resetModules();
  });

  it('builds public upload paths relative to UPLOAD_ROOT', () => {
    process.env.UPLOAD_DIR = path.join(process.cwd(), 'uploads-test-root');
    const { toPublicUploadPath: buildPath, resolveUploadRoot: resolveRoot } = require('../src/utils/uploadPaths');
    const root = resolveRoot();
    const absoluteFile = path.join(root, 'attendance', '2026', '06', 'foto.jpg');
    expect(buildPath(absoluteFile)).toBe('/uploads/attendance/2026/06/foto.jpg');
  });

  it('normalizes legacy volume paths for preview', () => {
    expect(normalizeStoredUploadPath('../data/uploads/attendance/2026/06/foto.jpg'))
      .toBe('/uploads/attendance/2026/06/foto.jpg');
    expect(normalizeStoredUploadPath('uploads/attendance/foto.jpg'))
      .toBe('/uploads/attendance/foto.jpg');
  });
});
