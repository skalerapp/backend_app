const request = require('supertest');
const app = require('../src/server');
const { closeDatabase } = require('../src/config/database');

const unique = Date.now();

let adminToken;
let administrativeToken;
let createdUserId;

describe('Users endpoints', () => {
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

    const administrativeEmail = `administrative.users.${unique}@skaler.com`;
    const createAdministrativeRes = await request(app)
      .post('/api/users')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        name: `Administrative Users ${unique}`,
        email: administrativeEmail,
        password: 'Pass1234!',
        role: 'administrative',
      });

    expect(createAdministrativeRes.statusCode).toBe(201);

    administrativeToken = await login(administrativeEmail, 'Pass1234!');
  });

  it('GET /api/users requires authentication', async () => {
    const res = await request(app).get('/api/users');

    expect(res.statusCode).toBe(401);
  });

  it('GET /api/users returns active users for authenticated requester', async () => {
    const res = await request(app)
      .get('/api/users')
      .set('Authorization', `Bearer ${adminToken}`);

    expect(res.statusCode).toBe(200);
    expect(res.body.success).toBe(true);
    expect(Array.isArray(res.body.data)).toBe(true);
  });

  it('POST /api/users creates a new app user', async () => {
    const res = await request(app)
      .post('/api/users')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        name: `Usuario App ${unique}`,
        email: `app.user.${unique}@skaler.com`,
        password: 'Pass1234!',
        role: 'employee',
      });

    expect(res.statusCode).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toHaveProperty('id');
    expect(res.body.data.role).toBe('employee');
    createdUserId = res.body.data.id;
  });

  it('POST /api/users rejects duplicate email', async () => {
    const res = await request(app)
      .post('/api/users')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        name: `Usuario Repetido ${unique}`,
        email: `app.user.${unique}@skaler.com`,
        password: 'Pass1234!',
        role: 'employee',
      });

    expect(res.statusCode).toBe(409);
    expect(res.body.message).toBe('Ya existe un usuario con ese correo');
  });

  it('PUT /api/users/:id updates user data and status', async () => {
    const res = await request(app)
      .put(`/api/users/${createdUserId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        name: `Usuario App Editado ${unique}`,
        email: `app.user.${unique}@skaler.com`,
        role: 'leader',
        status: 'inactive',
      });

    expect(res.statusCode).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.role).toBe('leader');
    expect(res.body.data.status).toBe('inactive');
  });

  it('administrative requester cannot assign super admin role', async () => {
    const res = await request(app)
      .post('/api/users')
      .set('Authorization', `Bearer ${administrativeToken}`)
      .send({
        name: `Intento Super Admin ${unique}`,
        email: `super.admin.blocked.${unique}@skaler.com`,
        password: 'Pass1234!',
        role: 'super_admin',
      });

    expect(res.statusCode).toBe(403);
    expect(res.body.message).toBe('Solo Super Admin puede asignar el rol Super Admin');
  });

  afterAll(async () => {
    await closeDatabase();
  });
});