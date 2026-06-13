const request = require('supertest');
const app = require('../src/server');
const { closeDatabase } = require('../src/config/database');

const loginAsAdmin = async () => {
  const res = await request(app)
    .post('/api/auth/login')
    .send({ email: 'admin@skaler.com', password: 'admin123' });

  expect(res.statusCode).toBe(200);
  expect(res.body.token).toBeTruthy();
  return res.body.token;
};

describe('Auth web bridge sessions', () => {
  it('revokes web session when mobile session logs out', async () => {
    const appToken = await loginAsAdmin();

    const ticketRes = await request(app)
      .post('/api/auth/web-launch-ticket')
      .set('Authorization', `Bearer ${appToken}`);

    expect(ticketRes.statusCode).toBe(201);
    const ticket = ticketRes.body.data.ticket;
    expect(ticket).toBeTruthy();

    const consumeRes = await request(app)
      .post('/api/auth/web-session/consume')
      .send({ ticket });

    expect(consumeRes.statusCode).toBe(200);
    const webToken = consumeRes.body.token;
    expect(webToken).toBeTruthy();

    const webStatusBefore = await request(app)
      .get('/api/auth/session/status')
      .set('Authorization', `Bearer ${webToken}`);
    expect(webStatusBefore.statusCode).toBe(200);
    expect(webStatusBefore.body.data.active).toBe(true);

    const logoutRes = await request(app)
      .post('/api/auth/logout')
      .set('Authorization', `Bearer ${appToken}`);
    expect(logoutRes.statusCode).toBe(200);

    const webStatusAfter = await request(app)
      .get('/api/auth/session/status')
      .set('Authorization', `Bearer ${webToken}`);
    expect(webStatusAfter.statusCode).toBe(200);
    expect(webStatusAfter.body.data.active).toBe(false);
    expect(webStatusAfter.body.data.linkedAppSessionActive).toBe(false);

    const protectedRes = await request(app)
      .get('/api/projects')
      .set('Authorization', `Bearer ${webToken}`);
    expect(protectedRes.statusCode).toBe(403);
  });

  it('rejects consumed bridge ticket on second use', async () => {
    const appToken = await loginAsAdmin();

    const ticketRes = await request(app)
      .post('/api/auth/web-launch-ticket')
      .set('Authorization', `Bearer ${appToken}`);

    const ticket = ticketRes.body.data.ticket;

    const firstConsume = await request(app)
      .post('/api/auth/web-session/consume')
      .send({ ticket });
    expect(firstConsume.statusCode).toBe(200);

    const secondConsume = await request(app)
      .post('/api/auth/web-session/consume')
      .send({ ticket });
    expect(secondConsume.statusCode).toBe(400);
    expect(secondConsume.body.message).toMatch(/usado|invalidado/i);
  });

  it('revokes pending ticket when mobile session logs out', async () => {
    const appToken = await loginAsAdmin();

    const ticketRes = await request(app)
      .post('/api/auth/web-launch-ticket')
      .set('Authorization', `Bearer ${appToken}`);
    const ticket = ticketRes.body.data.ticket;

    const logoutRes = await request(app)
      .post('/api/auth/logout')
      .set('Authorization', `Bearer ${appToken}`);
    expect(logoutRes.statusCode).toBe(200);

    const consumeRes = await request(app)
      .post('/api/auth/web-session/consume')
      .send({ ticket });
    expect(consumeRes.statusCode).toBe(400);
    expect(consumeRes.body.message).toMatch(/usado|invalidado|revocado|móvil|movil|activa/i);
  });

  it('rejects revoked bridge ticket from database status endpoint', async () => {
    const appToken = await loginAsAdmin();

    const ticketRes = await request(app)
      .post('/api/auth/web-launch-ticket')
      .set('Authorization', `Bearer ${appToken}`);
    const ticket = ticketRes.body.data.ticket;

    const logoutRes = await request(app)
      .post('/api/auth/logout')
      .set('Authorization', `Bearer ${appToken}`);
    expect(logoutRes.statusCode).toBe(200);

    const statusRes = await request(app)
      .get(`/api/auth/web-launch/${ticket}/status`);
    expect(statusRes.statusCode).toBe(410);
    expect(statusRes.body.reason).toBe('ticket_revoked');
    expect(statusRes.body.data.ticketStatus).toBe('revoked');

    const consumeRes = await request(app)
      .post('/api/auth/web-session/consume')
      .send({ ticket });
    expect(consumeRes.statusCode).toBe(400);
    expect(consumeRes.body.message).toMatch(/revocado|usado|invalidado/i);
  });

  afterAll(async () => {
    await closeDatabase();
  });
});
