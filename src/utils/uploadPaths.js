const fs = require('fs');
const path = require('path');

const resolveUploadRoot = () => {
  const configured = (process.env.UPLOAD_DIR || '').trim();
  if (configured) {
    return path.isAbsolute(configured)
      ? configured
      : path.resolve(process.cwd(), configured);
  }
  return path.join(__dirname, '../../uploads');
};

const UPLOAD_ROOT = resolveUploadRoot();

const ensureUploadRoot = () => {
  fs.mkdirSync(UPLOAD_ROOT, { recursive: true });
  return UPLOAD_ROOT;
};

module.exports = {
  UPLOAD_ROOT,
  resolveUploadRoot,
  ensureUploadRoot,
};
