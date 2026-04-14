const request = require('supertest');
const app = require('../src/server');
const { closeDatabase } = require('../src/config/database');

let authToken;
let projectId;
let materialItemId;

describe('Materials endpoints', () => {
  beforeAll(async () => {
    const loginRes = await request(app)
      .post('/api/auth/login')
      .send({ email: 'admin@skaler.com', password: 'admin123' });

    authToken = loginRes.body.token;

    const projectRes = await request(app)
      .post('/api/projects')
      .set('Authorization', `Bearer ${authToken}`)
      .send({
        name: `Proyecto Materiales ${Date.now()}`,
        budget: 130000,
      });

    expect(projectRes.statusCode).toBe(201);
    projectId = projectRes.body.projectId;
  });

  it('GET /api/materials without token should 401', async () => {
    const res = await request(app).get('/api/materials');
    expect(res.statusCode).toBe(401);
  });

  it('POST /api/materials/assign assigns a material to project inventory', async () => {
    const res = await request(app)
      .post('/api/materials/assign')
      .set('Authorization', `Bearer ${authToken}`)
      .send({
        project_id: projectId,
        material_name: 'Cable THHN',
        unit: 'm',
        assigned_quantity: 250,
        unit_cost: 3.5,
      });

    expect(res.statusCode).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.project_id).toBe(projectId);
    expect(res.body.data.material_name).toBe('Cable THHN');
    materialItemId = res.body.data.id;
  });

  it('GET /api/materials returns assigned inventory items', async () => {
    const res = await request(app)
      .get('/api/materials')
      .set('Authorization', `Bearer ${authToken}`);

    expect(res.statusCode).toBe(200);
    expect(Array.isArray(res.body.data)).toBe(true);
    expect(res.body.data.some((item) => item.project_id === projectId)).toBe(true);
  });

  it('GET /api/materials/project/:projectId returns project materials', async () => {
    const res = await request(app)
      .get(`/api/materials/project/${projectId}`)
      .set('Authorization', `Bearer ${authToken}`);

    expect(res.statusCode).toBe(200);
    expect(Array.isArray(res.body.data)).toBe(true);
    expect(res.body.data.some((item) => item.material_name === 'Cable THHN')).toBe(true);
  });

  it('POST /api/materials/project/:projectId/consume registers material consumption', async () => {
    const res = await request(app)
      .post(`/api/materials/project/${projectId}/consume`)
      .set('Authorization', `Bearer ${authToken}`)
      .send({
        material_item_id: materialItemId,
        consumed_quantity: 80,
        consumption_date: '2026-04-07',
        notes: 'Tendido inicial',
        evidence_path: '/uploads/material-consumption.jpg',
      });

    expect(res.statusCode).toBe(201);
    expect(res.body.success).toBe(true);
    expect(Number(res.body.summary.consumed_quantity)).toBe(80);
    expect(Number(res.body.summary.remaining_quantity)).toBe(170);
  });

  it('GET /api/materials/project/:projectId/consumptions lists project consumptions', async () => {
    const res = await request(app)
      .get(`/api/materials/project/${projectId}/consumptions`)
      .set('Authorization', `Bearer ${authToken}`);

    expect(res.statusCode).toBe(200);
    expect(Array.isArray(res.body.data)).toBe(true);
    expect(res.body.data.some((item) => Number(item.consumed_quantity) === 80)).toBe(true);
  });

  it('rejects consumption that exceeds remaining quantity', async () => {
    const res = await request(app)
      .post(`/api/materials/project/${projectId}/consume`)
      .set('Authorization', `Bearer ${authToken}`)
      .send({
        material_item_id: materialItemId,
        consumed_quantity: 500,
        consumption_date: '2026-04-07',
        notes: 'Exceso de inventario',
      });

    expect(res.statusCode).toBe(409);
    expect(res.body.success).toBe(false);
  });

  it('rejects assigning material to non-existing project', async () => {
    const res = await request(app)
      .post('/api/materials/assign')
      .set('Authorization', `Bearer ${authToken}`)
      .send({
        project_id: 999999,
        material_name: 'Tuberia EMT',
        unit: 'm',
        assigned_quantity: 20,
        unit_cost: 10,
      });

    expect(res.statusCode).toBe(404);
    expect(res.body.message).toBe('Proyecto no encontrado');
  });

  afterAll(async () => {
    await closeDatabase();
  });
});