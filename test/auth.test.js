const request = require('supertest');
const app = require('../src/server');
const { closeDatabase } = require('../src/config/database');

describe('Auth endpoints', () => {
  it('GET /api/health should return 200', async () => {
    const res = await request(app).get('/api/health');
    expect(res.statusCode).toEqual(200);
    expect(res.body).toHaveProperty('success', true);
  });

  it('POST /api/auth/login with missing fields should return 400', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: 'not-an-email' });
    expect(res.statusCode).toEqual(400);
    expect(res.body).toHaveProperty('errors');
  });

  // Note: This test assumes seedAdmin was run and admin@skaler.com exists with password 'admin123'
  it('POST /api/auth/login with valid credentials should return token', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: 'admin@skaler.com', password: 'admin123' });
    expect([200,201]).toContain(res.statusCode);
    if (res.statusCode === 200) {
      expect(res.body).toHaveProperty('token');
    }
  });

  afterAll(async () => {
    await closeDatabase();
  });
});
