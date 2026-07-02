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

/** Ruta pública servida por express.static('/uploads', UPLOAD_ROOT) */
const toPublicUploadPath = (absoluteFilePath) => {
  const relativeToRoot = path.relative(UPLOAD_ROOT, absoluteFilePath).replace(/\\/g, '/');
  return `/uploads/${relativeToRoot}`.replace(/\/+/g, '/');
};

/** Normaliza rutas legacy guardadas antes del volumen persistente */
const normalizeStoredUploadPath = (storedPath) => {
  if (storedPath == null) return null;
  const raw = storedPath.toString().trim().replace(/\\/g, '/');
  if (!raw) return null;
  if (raw.startsWith('http://') || raw.startsWith('https://')) return raw;

  const uploadsIndex = raw.indexOf('/uploads/');
  if (uploadsIndex >= 0) {
    return raw.slice(uploadsIndex);
  }

  if (raw.startsWith('uploads/')) {
    return `/${raw}`;
  }

  if (raw.startsWith('/uploads/')) {
    return raw;
  }

  const dataUploadsIndex = raw.indexOf('/data/uploads/');
  if (dataUploadsIndex >= 0) {
    return raw.slice(dataUploadsIndex).replace('/data/uploads/', '/uploads/');
  }

  return raw.startsWith('/') ? raw : `/${raw}`;
};

module.exports = {
  UPLOAD_ROOT,
  resolveUploadRoot,
  ensureUploadRoot,
  toPublicUploadPath,
  normalizeStoredUploadPath,
};
