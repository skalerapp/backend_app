const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

// Encriptar contraseña
const hashPassword = async (password) => {
  const salt = await bcrypt.genSalt(10);
  return await bcrypt.hash(password, salt);
};

// Comparar contraseña
const comparePassword = async (password, hash) => {
  return await bcrypt.compare(password, hash);
};

// Generar JWT
const generateToken = (user, options = {}) => {
  const payload = {
    id: user.id,
    email: user.email,
    role: user.role,
    name: user.name,
  };

  if (options.sessionId) {
    payload.sid = options.sessionId;
  }
  if (options.sessionType) {
    payload.session_type = options.sessionType;
  }
  if (options.linkedAppSessionId) {
    payload.linked_app_session_id = options.linkedAppSessionId;
  }

  const secret = process.env.JWT_SECRET || 'skaler_dev_secret';
  const expiresIn = options.expiresIn || process.env.JWT_EXPIRE || '24h';

  return jwt.sign(payload, secret, {
    expiresIn
  });
};

module.exports = {
  hashPassword,
  comparePassword,
  generateToken
};
