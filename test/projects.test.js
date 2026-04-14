const request = require('supertest');
const app = require('../src/server');
const { closeDatabase } = require('../src/config/database');

let authToken;
let createdProjectId;
let openActivityProjectId;
let openActivityId;

describe('Projects endpoints', () => {
  beforeAll(async () => {
    const loginRes = await request(app)
      .post('/api/auth/login')
      .send({ email: 'admin@skaler.com', password: 'admin123' });

    authToken = loginRes.body.token;
  });

  it('GET /api/projects without token should 401', async () => {
    const res = await request(app).get('/api/projects');
    expect(res.statusCode).toBe(401);
  });

  it('GET /api/projects/next-ot returns next generated OT code', async () => {
    const res = await request(app)
      .get('/api/projects/next-ot')
      .set('Authorization', `Bearer ${authToken}`);

    expect(res.statusCode).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.otCode).toMatch(/^OT\d+$/);
  });

  it('POST /api/projects creates a new project', async () => {
    const res = await request(app)
      .post('/api/projects')
      .set('Authorization', `Bearer ${authToken}`)
      .send({
        name: `Proyecto API ${Date.now()}`,
        description: 'Proyecto creado desde suite API',
        budget: 175000,
        status: 'active',
      });

    expect(res.statusCode).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.otCode).toMatch(/^OT\d+$/);
    createdProjectId = res.body.projectId;
  });

  it('GET /api/projects returns created project in list', async () => {
    const res = await request(app)
      .get('/api/projects')
      .set('Authorization', `Bearer ${authToken}`);

    expect(res.statusCode).toBe(200);
    expect(Array.isArray(res.body.data)).toBe(true);
    expect(res.body.data.some((item) => item.id === createdProjectId)).toBe(true);
  });

  it('GET /api/projects/:id returns project detail', async () => {
    const res = await request(app)
      .get(`/api/projects/${createdProjectId}`)
      .set('Authorization', `Bearer ${authToken}`);

    expect(res.statusCode).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.id).toBe(createdProjectId);
  });

  it('PUT /api/projects/:id updates project data', async () => {
    const res = await request(app)
      .put(`/api/projects/${createdProjectId}`)
      .set('Authorization', `Bearer ${authToken}`)
      .send({
        name: 'Proyecto API Editado',
        description: 'Proyecto actualizado desde suite API',
        budget: 210000,
        status: 'paused',
      });

    expect(res.statusCode).toBe(200);
    expect(res.body.message).toBe('Proyecto actualizado');
  });

  it('prevents finalizing a project with open activities', async () => {
    const projectRes = await request(app)
      .post('/api/projects')
      .set('Authorization', `Bearer ${authToken}`)
      .send({
        name: `Proyecto Bloqueado ${Date.now()}`,
        budget: 120000,
        status: 'active',
      });

    expect(projectRes.statusCode).toBe(201);
    openActivityProjectId = projectRes.body.projectId;

    const employeeRes = await request(app)
      .post('/api/employees')
      .set('Authorization', `Bearer ${authToken}`)
      .send({
        employee_name: `Colaborador Proyecto ${Date.now()}`,
        identification_number: `PR-${Date.now()}`,
        position: 'Operario',
        department: 'Operaciones',
        status: 'active',
      });

    expect(employeeRes.statusCode).toBe(201);

    const assignRes = await request(app)
      .post(`/api/projects/${openActivityProjectId}/collaborators`)
      .set('Authorization', `Bearer ${authToken}`)
      .send({ employee_id: employeeRes.body.employeeId });

    expect(assignRes.statusCode).toBe(201);

    const activityRes = await request(app)
      .post('/api/activities')
      .set('Authorization', `Bearer ${authToken}`)
      .send({
        project_id: openActivityProjectId,
        employee_id: employeeRes.body.employeeId,
        description: 'Actividad abierta de proyecto',
        status: 'in_progress',
      });

    expect(activityRes.statusCode).toBe(201);
    openActivityId = activityRes.body.activityId;

    const finalizeRes = await request(app)
      .put(`/api/projects/${openActivityProjectId}`)
      .set('Authorization', `Bearer ${authToken}`)
      .send({
        name: 'Proyecto Bloqueado',
        budget: 120000,
        status: 'completed',
      });

    expect(finalizeRes.statusCode).toBe(409);
    expect(finalizeRes.body.success).toBe(false);
  });

  it('allows finalizing project after closing open activity', async () => {
    const deleteActivityRes = await request(app)
      .delete(`/api/activities/${openActivityId}`)
      .set('Authorization', `Bearer ${authToken}`);

    expect(deleteActivityRes.statusCode).toBe(200);

    const finalizeRes = await request(app)
      .put(`/api/projects/${openActivityProjectId}`)
      .set('Authorization', `Bearer ${authToken}`)
      .send({
        name: 'Proyecto Bloqueado',
        budget: 120000,
        status: 'completed',
      });

    expect(finalizeRes.statusCode).toBe(200);
  });

  it('DELETE /api/projects/:id removes project', async () => {
    const res = await request(app)
      .delete(`/api/projects/${createdProjectId}`)
      .set('Authorization', `Bearer ${authToken}`);

    expect(res.statusCode).toBe(200);
    expect(res.body.message).toBe('Proyecto eliminado');
  });

  afterAll(async () => {
    await closeDatabase();
  });
});