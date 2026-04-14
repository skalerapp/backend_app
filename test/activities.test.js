const request = require('supertest');
const app = require('../src/server');
const { closeDatabase } = require('../src/config/database');

let authToken;
let projectId;
let employeeId;
let activityId;

describe('Activities endpoints', () => {
  beforeAll(async () => {
    // login as admin
    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: 'admin@skaler.com', password: 'admin123' });
    authToken = res.body.token;

    // create a project for FK
    const projectRes = await request(app)
      .post('/api/projects')
      .set('Authorization', `Bearer ${authToken}`)
      .send({ name: 'Test Project', budget: 5000 });
    projectId = projectRes.body.projectId;
    if (!projectId) {
      console.error('project creation failed', projectRes.statusCode, projectRes.body);
    }
    expect(projectId).toBeDefined();

    // ensure we have an employee for FK (create or reuse existing)
    const listRes = await request(app)
      .get('/api/employees')
      .set('Authorization', `Bearer ${authToken}`);
    if (Array.isArray(listRes.body.data) && listRes.body.data.length > 0) {
      employeeId = listRes.body.data[0].id;
    } else {
      const empRes = await request(app)
        .post('/api/employees')
        .set('Authorization', `Bearer ${authToken}`)
        .send({ user_id: 1, position: 'Worker' });
      employeeId = empRes.body.employeeId;
      if (!employeeId) {
        console.error('employee creation failed', empRes.statusCode, empRes.body);
      }
    }
    expect(employeeId).toBeDefined();
  });

  it('GET /api/activities without token should 401', async () => {
    const res = await request(app).get('/api/activities');
    expect(res.statusCode).toEqual(401);
  });

  it('POST /api/activities create new activity', async () => {
    const payload = {
      project_id: projectId,
      employee_id: employeeId,
      description: 'Initial test activity',
      start_time: '2026-03-02 08:00:00',
    };
    const res = await request(app)
      .post('/api/activities')
      .set('Authorization', `Bearer ${authToken}`)
      .send(payload);
    expect([200,201]).toContain(res.statusCode);
    if (res.body.activityId) {
      activityId = res.body.activityId;
    }
  });

  it('GET /api/activities with token should return list', async () => {
    const res = await request(app)
      .get('/api/activities')
      .set('Authorization', `Bearer ${authToken}`);
    expect(res.statusCode).toEqual(200);
    expect(Array.isArray(res.body.data)).toBe(true);
  });

  it('PUT /api/activities/:id should update if created', async () => {
    if (!activityId) return;
    const res = await request(app)
      .put(`/api/activities/${activityId}`)
      .set('Authorization', `Bearer ${authToken}`)
      .send({
        project_id: projectId,
        employee_id: employeeId,
        description: 'Actividad actualizada',
        status: 'in_progress',
      });

    expect(res.statusCode).toEqual(200);

    const listRes = await request(app)
      .get('/api/activities')
      .set('Authorization', `Bearer ${authToken}`);

    expect(listRes.statusCode).toEqual(200);
    const updated = listRes.body.data.find((item) => item.id === activityId);
    expect(updated).toBeDefined();
    expect(updated.status).toEqual('in_progress');
  });

  it('DELETE /api/activities/:id should remove if created', async () => {
    if (!activityId) return;
    const res = await request(app)
      .delete(`/api/activities/${activityId}`)
      .set('Authorization', `Bearer ${authToken}`);
    expect(res.statusCode).toEqual(200);
  });

  afterAll(async () => {
    await closeDatabase();
  });
});