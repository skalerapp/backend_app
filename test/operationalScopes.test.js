const request = require('supertest');
const app = require('../src/server');
const { closeDatabase } = require('../src/config/database');

const unique = Date.now();

let adminToken;
let leaderUserId;
let supervisorUserId;
let projectId;
let assignmentId;

describe('Operational scopes endpoints', () => {
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
        name: `Leader Scope ${unique}`,
        email: `leader.scope.${unique}@skaler.com`,
        password: 'Pass1234!',
        role: 'leader',
      });

    expect(createLeaderRes.statusCode).toBe(201);
    leaderUserId = createLeaderRes.body.data.id;

    const createSupervisorRes = await request(app)
      .post('/api/users')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        name: `Supervisor Scope ${unique}`,
        email: `supervisor.scope.${unique}@skaler.com`,
        password: 'Pass1234!',
        role: 'supervisor',
      });

    expect(createSupervisorRes.statusCode).toBe(201);
    supervisorUserId = createSupervisorRes.body.data.id;

    const createProjectRes = await request(app)
      .post('/api/projects')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        name: `Proyecto Scope ${unique}`,
        description: 'Proyecto para asignaciones operativas',
        budget: 85000,
        status: 'active',
      });

    expect(createProjectRes.statusCode).toBe(201);
    projectId = createProjectRes.body.projectId;
  });

  it('GET /api/operational-scopes requires authentication', async () => {
    const res = await request(app).get('/api/operational-scopes');

    expect(res.statusCode).toBe(401);
  });

  it('POST /api/operational-scopes rejects invalid role scope', async () => {
    const res = await request(app)
      .post('/api/operational-scopes')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        project_id: projectId,
        user_id: leaderUserId,
        role_scope: 'administrative',
      });

    expect(res.statusCode).toBe(400);
    expect(res.body.message).toContain('role_scope válido');
  });

  it('POST /api/operational-scopes creates assignment for matching role', async () => {
    const res = await request(app)
      .post('/api/operational-scopes')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        project_id: projectId,
        user_id: leaderUserId,
        role_scope: 'leader',
      });

    expect(res.statusCode).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.project_id).toBe(projectId);
    expect(res.body.data.user_id).toBe(leaderUserId);
    expect(res.body.data.role_scope).toBe('leader');
    expect(res.body.data.is_active).toBe(1);
    assignmentId = res.body.data.id;
  });

  it('GET /api/operational-scopes lists and filters assignments', async () => {
    const res = await request(app)
      .get('/api/operational-scopes')
      .query({ role_scope: 'leader', project_id: projectId, user_id: leaderUserId, is_active: 1 })
      .set('Authorization', `Bearer ${adminToken}`);

    expect(res.statusCode).toBe(200);
    expect(res.body.success).toBe(true);
    expect(Array.isArray(res.body.data)).toBe(true);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].id).toBe(assignmentId);
    expect(res.body.data[0].project_id).toBe(projectId);
    expect(res.body.data[0].user_id).toBe(leaderUserId);
  });

  it('POST /api/operational-scopes upserts existing assignment status', async () => {
    const res = await request(app)
      .post('/api/operational-scopes')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        project_id: projectId,
        user_id: leaderUserId,
        role_scope: 'leader',
        is_active: 0,
      });

    expect(res.statusCode).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.id).toBe(assignmentId);
    expect(res.body.data.is_active).toBe(0);

    const listRes = await request(app)
      .get('/api/operational-scopes')
      .query({ project_id: projectId, is_active: 0 })
      .set('Authorization', `Bearer ${adminToken}`);

    expect(listRes.statusCode).toBe(200);
    expect(listRes.body.data.some((item) => item.id === assignmentId && item.is_active === 0)).toBe(true);
  });

  it('POST /api/operational-scopes rejects user role mismatch', async () => {
    const res = await request(app)
      .post('/api/operational-scopes')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        project_id: projectId,
        user_id: supervisorUserId,
        role_scope: 'leader',
      });

    expect(res.statusCode).toBe(409);
    expect(res.body.message).toBe('El usuario no tiene rol leader');
  });

  it('DELETE /api/operational-scopes/:id removes assignment', async () => {
    const res = await request(app)
      .delete(`/api/operational-scopes/${assignmentId}`)
      .set('Authorization', `Bearer ${adminToken}`);

    expect(res.statusCode).toBe(200);
    expect(res.body.message).toBe('Asignación operativa eliminada');
  });

  it('DELETE /api/operational-scopes/:id returns 404 for missing assignment', async () => {
    const res = await request(app)
      .delete(`/api/operational-scopes/${assignmentId}`)
      .set('Authorization', `Bearer ${adminToken}`);

    expect(res.statusCode).toBe(404);
    expect(res.body.message).toBe('Asignación no encontrada');
  });

  afterAll(async () => {
    await closeDatabase();
  });
});