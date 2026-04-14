const request = require('supertest');
const app = require('../src/server');
const { closeDatabase } = require('../src/config/database');

const unique = Date.now();

let adminToken;
let leaderToken;
let leaderUserId;
let scopedProjectId;
let unscopedProjectId;
let scopedMaterialId;
let unscopedMaterialId;

describe('Materials operational scope visibility', () => {
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
        name: `Leader Materials ${unique}`,
        email: `leader.materials.${unique}@skaler.com`,
        password: 'Pass1234!',
        role: 'leader',
      });

    expect(createLeaderRes.statusCode).toBe(201);
    leaderUserId = createLeaderRes.body.data.id;

    const scopedProjectRes = await request(app)
      .post('/api/projects')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        name: `Proyecto Alcance Material ${unique}`,
        budget: 98000,
      });

    expect(scopedProjectRes.statusCode).toBe(201);
    scopedProjectId = scopedProjectRes.body.projectId;

    const unscopedProjectRes = await request(app)
      .post('/api/projects')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        name: `Proyecto Sin Alcance Material ${unique}`,
        budget: 99000,
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

    const scopedMaterialRes = await request(app)
      .post('/api/materials/assign')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        project_id: scopedProjectId,
        material_name: 'Cable Alcance',
        unit: 'm',
        assigned_quantity: 120,
        unit_cost: 4,
      });

    expect(scopedMaterialRes.statusCode).toBe(200);
    scopedMaterialId = scopedMaterialRes.body.data.id;

    const unscopedMaterialRes = await request(app)
      .post('/api/materials/assign')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        project_id: unscopedProjectId,
        material_name: 'Cable Restringido',
        unit: 'm',
        assigned_quantity: 80,
        unit_cost: 5,
      });

    expect(unscopedMaterialRes.statusCode).toBe(200);
    unscopedMaterialId = unscopedMaterialRes.body.data.id;

    leaderToken = await login(`leader.materials.${unique}@skaler.com`, 'Pass1234!');
  });

  it('GET /api/materials shows only items from scoped projects for leader', async () => {
    const res = await request(app)
      .get('/api/materials')
      .set('Authorization', `Bearer ${leaderToken}`);

    expect(res.statusCode).toBe(200);
    const materialIds = (res.body.data || []).map((item) => item.id);
    expect(materialIds).toContain(scopedMaterialId);
    expect(materialIds).not.toContain(unscopedMaterialId);
  });

  it('GET /api/materials/project/:projectId allows only scoped project access', async () => {
    const scopedRes = await request(app)
      .get(`/api/materials/project/${scopedProjectId}`)
      .set('Authorization', `Bearer ${leaderToken}`);

    expect(scopedRes.statusCode).toBe(200);
    expect(scopedRes.body.data.some((item) => item.id === scopedMaterialId)).toBe(true);

    const unscopedRes = await request(app)
      .get(`/api/materials/project/${unscopedProjectId}`)
      .set('Authorization', `Bearer ${leaderToken}`);

    expect(unscopedRes.statusCode).toBe(403);
    expect(unscopedRes.body.message).toBe('No tienes acceso operativo a este proyecto');
  });

  it('POST /api/materials/project/:projectId/consume allows only scoped project consumption', async () => {
    const scopedRes = await request(app)
      .post(`/api/materials/project/${scopedProjectId}/consume`)
      .set('Authorization', `Bearer ${leaderToken}`)
      .send({
        material_item_id: scopedMaterialId,
        consumed_quantity: 25,
        consumption_date: '2026-04-07',
        notes: 'Consumo autorizado',
      });

    expect(scopedRes.statusCode).toBe(201);
    expect(Number(scopedRes.body.summary.remaining_quantity)).toBe(95);

    const unscopedRes = await request(app)
      .post(`/api/materials/project/${unscopedProjectId}/consume`)
      .set('Authorization', `Bearer ${leaderToken}`)
      .send({
        material_item_id: unscopedMaterialId,
        consumed_quantity: 10,
        consumption_date: '2026-04-07',
        notes: 'Consumo restringido',
      });

    expect(unscopedRes.statusCode).toBe(403);
    expect(unscopedRes.body.message).toBe('No tienes acceso operativo a este proyecto');
  });

  it('GET /api/materials/project/:projectId/consumptions exposes only scoped project history', async () => {
    const scopedRes = await request(app)
      .get(`/api/materials/project/${scopedProjectId}/consumptions`)
      .set('Authorization', `Bearer ${leaderToken}`);

    expect(scopedRes.statusCode).toBe(200);
    expect(scopedRes.body.data.some((item) => item.material_item_id === scopedMaterialId)).toBe(true);

    const unscopedRes = await request(app)
      .get(`/api/materials/project/${unscopedProjectId}/consumptions`)
      .set('Authorization', `Bearer ${leaderToken}`);

    expect(unscopedRes.statusCode).toBe(403);
    expect(unscopedRes.body.message).toBe('No tienes acceso operativo a este proyecto');
  });

  afterAll(async () => {
    await closeDatabase();
  });
});