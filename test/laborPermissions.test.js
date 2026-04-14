const request = require('supertest');
const app = require('../src/server');
const { closeDatabase } = require('../src/config/database');

let authToken;
let employeeId;
let laborPermissionId;

describe('Labor Permissions endpoints', () => {
  beforeAll(async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: 'admin@skaler.com', password: 'admin123' });

    authToken = res.body.token;

    const employeesRes = await request(app)
      .get('/api/employees')
      .set('Authorization', `Bearer ${authToken}`);

    if (Array.isArray(employeesRes.body.data) && employeesRes.body.data.length > 0) {
      employeeId = employeesRes.body.data[0].id;
    }

    expect(employeeId).toBeDefined();
  });

  it('GET /api/labor-permissions without token should 401', async () => {
    const res = await request(app).get('/api/labor-permissions');
    expect(res.statusCode).toEqual(401);
  });

  it('POST /api/labor-permissions should create', async () => {
    const payload = {
      employee_id: employeeId,
      permission_type: 'medical',
      start_date: '2026-03-03',
      end_date: '2026-03-04',
      reason: 'Medical appointment',
      status: 'pending'
    };

    const res = await request(app)
      .post('/api/labor-permissions')
      .set('Authorization', `Bearer ${authToken}`)
      .send(payload);

    expect([200, 201]).toContain(res.statusCode);
    if (res.body.laborPermissionId) {
      laborPermissionId = res.body.laborPermissionId;
    }
  });

  it('GET /api/labor-permissions with token should return list', async () => {
    const res = await request(app)
      .get('/api/labor-permissions')
      .set('Authorization', `Bearer ${authToken}`);

    expect(res.statusCode).toEqual(200);
    expect(Array.isArray(res.body.data)).toBe(true);
  });

  it('PUT /api/labor-permissions/:id should update', async () => {
    if (!laborPermissionId) return;

    const res = await request(app)
      .put(`/api/labor-permissions/${laborPermissionId}`)
      .set('Authorization', `Bearer ${authToken}`)
      .send({ status: 'approved' });

    expect(res.statusCode).toEqual(200);
  });

  it('DELETE /api/labor-permissions/:id should remove', async () => {
    if (!laborPermissionId) return;

    const res = await request(app)
      .delete(`/api/labor-permissions/${laborPermissionId}`)
      .set('Authorization', `Bearer ${authToken}`);

    expect(res.statusCode).toEqual(200);
  });

  afterAll(async () => {
    await closeDatabase();
  });
});
