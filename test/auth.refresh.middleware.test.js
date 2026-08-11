const jwt = require('jsonwebtoken');
const { verifyTokenAllowExpired } = require('../src/middleware/auth.middleware');

const buildResponse = () => {
  const res = {
    statusCode: 200,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    },
  };
  return res;
};

describe('verifyTokenAllowExpired', () => {
  const secret = process.env.JWT_SECRET || 'skaler_dev_secret';

  it('accepts an expired JWT when the signature is valid', async () => {
    const token = jwt.sign(
      { id: 1, email: 'user@test.com', role: 'employee', sid: 'session-123' },
      secret,
      { expiresIn: '-1s' },
    );

    const req = {
      headers: {
        authorization: `Bearer ${token}`,
      },
    };
    const res = buildResponse();
    let nextCalled = false;

    await verifyTokenAllowExpired(req, res, () => {
      nextCalled = true;
    });

    expect(nextCalled).toBe(true);
    expect(req.user.sid).toBe('session-123');
  });

  it('rejects tokens without session id', async () => {
    const token = jwt.sign(
      { id: 1, email: 'user@test.com', role: 'employee' },
      secret,
      { expiresIn: '1h' },
    );

    const req = {
      headers: {
        authorization: `Bearer ${token}`,
      },
    };
    const res = buildResponse();
    let nextCalled = false;

    await verifyTokenAllowExpired(req, res, () => {
      nextCalled = true;
    });

    expect(nextCalled).toBe(false);
    expect(res.statusCode).toBe(403);
    expect(res.body.reason).toBe('legacy_session_unsupported');
  });
});
