const request = require('supertest');
const app = require('../src/server');
const { closeDatabase } = require('../src/config/database');

const unique = Date.now();

let adminToken;
let leaderToken;
let leaderUserId;
let scopedProjectId;
let unscopedProjectId;

describe('Allowances operational scope visibility', () => {
  const login = async (email, password) => {
    const res = await request(app)
      .post('/api/auth/login')
      .send({ email, password });

    expect(res.statusCode).toBe(200);
    expect(res.body.token).toBeDefined();
    return res.body.token;
  };

  beforeAll(async () => {
    adminToken = await login('admin@skaler.com', 'admin123');

    const createLeaderRes = await request(app)
      .post('/api/users')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        name: `Leader Allowances ${unique}`,
        email: `leader.allowances.${unique}@skaler.com`,
        password: 'Pass1234!',
        role: 'leader',
      });

    expect(createLeaderRes.statusCode).toBe(201);
    leaderUserId = createLeaderRes.body.data.id;

    const scopedProjectRes = await request(app)
      .post('/api/projects')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        name: `Proyecto Alcance Viaticos ${unique}`,
        budget: 110000,
      });

    expect(scopedProjectRes.statusCode).toBe(201);
    scopedProjectId = scopedProjectRes.body.projectId;

    const unscopedProjectRes = await request(app)
      .post('/api/projects')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        name: `Proyecto Sin Alcance Viaticos ${unique}`,
        budget: 115000,
      });

    expect(unscopedProjectRes.statusCode).toBe(201);
    unscopedProjectId = unscopedProjectRes.body.projectId;

    const assignScopeRes = await request(app)
      .post('/api/operational-scopes')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        project_id: scopedProjectId,
        user_id: leaderUserId,
        role_scope: 'leader',
      });

    expect(assignScopeRes.statusCode).toBe(200);

    const scopedAllowanceRes = await request(app)
      .post('/api/allowances/assign')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        project_id: scopedProjectId,
        leader_user_id: leaderUserId,
        assigned_amount: 120000,
      });

    expect(scopedAllowanceRes.statusCode).toBe(200);

    const unscopedAllowanceRes = await request(app)
      .post('/api/allowances/assign')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        project_id: unscopedProjectId,
        assigned_amount: 80000,
      });

    expect(unscopedAllowanceRes.statusCode).toBe(200);

    leaderToken = await login(`leader.allowances.${unique}@skaler.com`, 'Pass1234!');
  });

  it('GET /api/allowances shows only scoped allowance rows for leader', async () => {
    const res = await request(app)
      .get('/api/allowances')
      .set('Authorization', `Bearer ${leaderToken}`);

    expect(res.statusCode).toBe(200);
    const projectIds = (res.body.data || []).map((item) => item.project_id);
    expect(projectIds).toContain(scopedProjectId);
    expect(projectIds).not.toContain(unscopedProjectId);
  });

  it('GET /api/allowances/project/:projectId allows only scoped project summary', async () => {
    const scopedRes = await request(app)
      .get(`/api/allowances/project/${scopedProjectId}`)
      .set('Authorization', `Bearer ${leaderToken}`);

    expect(scopedRes.statusCode).toBe(200);
    expect(scopedRes.body.data.project_id).toBe(scopedProjectId);

    const unscopedRes = await request(app)
      .get(`/api/allowances/project/${unscopedProjectId}`)
      .set('Authorization', `Bearer ${leaderToken}`);

    expect(unscopedRes.statusCode).toBe(403);
    expect(unscopedRes.body.message).toBe('No tienes acceso operativo a este proyecto');
  });

  it('POST /api/allowances/project/:projectId/expenses registers only scoped project expenses', async () => {
    const scopedRes = await request(app)
      .post(`/api/allowances/project/${scopedProjectId}/expenses`)
      .set('Authorization', `Bearer ${leaderToken}`)
      .send({
        amount: 25000,
        expense_date: '2026-04-07',
        notes: 'Gasto autorizado por alcance',
      });

    expect(scopedRes.statusCode).toBe(201);
    expect(Number(scopedRes.body.summary.remaining_amount)).toBe(95000);

    const unscopedRes = await request(app)
      .post(`/api/allowances/project/${unscopedProjectId}/expenses`)
      .set('Authorization', `Bearer ${leaderToken}`)
      .send({
        amount: 10000,
        expense_date: '2026-04-07',
        notes: 'Gasto restringido por alcance',
      });

    expect(unscopedRes.statusCode).toBe(403);
    expect(unscopedRes.body.message).toBe('No tienes acceso operativo a este proyecto');
  });

  it('GET /api/allowances/project/:projectId/expenses exposes only scoped expense history', async () => {
    const scopedRes = await request(app)
      .get(`/api/allowances/project/${scopedProjectId}/expenses`)
      .set('Authorization', `Bearer ${leaderToken}`);

    expect(scopedRes.statusCode).toBe(200);
    expect(scopedRes.body.data.some((item) => Number(item.amount) === 25000)).toBe(true);

    const unscopedRes = await request(app)
      .get(`/api/allowances/project/${unscopedProjectId}/expenses`)
      .set('Authorization', `Bearer ${leaderToken}`);

    expect(unscopedRes.statusCode).toBe(403);
    expect(unscopedRes.body.message).toBe('No tienes acceso operativo a este proyecto');
  });

  it('GET /api/allowances/requests shows only scoped requests for leader when not requester/responsible', async () => {
    const scopedRequestRes = await request(app)
      .post('/api/allowances/requests')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        project_id: scopedProjectId,
        departure_date: '2026-04-08',
        return_date: '2026-04-09',
        budget_transport: 5000,
        notes: 'Solicitud con alcance',
      });

    expect(scopedRequestRes.statusCode).toBe(201);

    const unscopedRequestRes = await request(app)
      .post('/api/allowances/requests')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        project_id: unscopedProjectId,
        departure_date: '2026-04-10',
        return_date: '2026-04-11',
        budget_transport: 7000,
        notes: 'Solicitud sin alcance',
      });

    expect(unscopedRequestRes.statusCode).toBe(201);

    const res = await request(app)
      .get('/api/allowances/requests')
      .set('Authorization', `Bearer ${leaderToken}`);

    expect(res.statusCode).toBe(200);
    const projectIds = (res.body.data || []).map((item) => item.project_id);
    expect(projectIds).toContain(scopedProjectId);
    expect(projectIds).not.toContain(unscopedProjectId);
  });

  afterAll(async () => {
    await closeDatabase();
  });
});