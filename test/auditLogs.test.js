const request = require('supertest');
const app = require('../src/server');
const { closeDatabase } = require('../src/config/database');

const unique = Date.now();

let adminToken;
let supervisorToken;
let createdUserId;

describe('Audit logs endpoint', () => {
  const login = async (email, password) => {
    const res = await request(app)
      .post('/api/auth/login')
      .send({ email, password });

    expect(res.statusCode).toBe(200);
    expect(res.body.token).toBeDefined();
    return res.body.token;
  };

  const createUserAsAdmin = async ({ name, email, password, role }) => {
    const res = await request(app)
      .post('/api/users')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ name, email, password, role });

    expect(res.statusCode).toBe(201);
    expect(res.body?.data?.id).toBeDefined();
    return res.body.data.id;
  };

  beforeAll(async () => {
    adminToken = await login('admin@skaler.com', 'admin123');

    const supervisorEmail = `supervisor.audit.${unique}@skaler.com`;
    await createUserAsAdmin({
      name: `Supervisor Audit ${unique}`,
      email: supervisorEmail,
      password: 'Pass1234!',
      role: 'supervisor',
    });

    supervisorToken = await login(supervisorEmail, 'Pass1234!');

    createdUserId = await createUserAsAdmin({
      name: `Usuario Audit ${unique}`,
      email: `user.audit.${unique}@skaler.com`,
      password: 'Pass1234!',
      role: 'employee',
    });

    const updateRes = await request(app)
      .put(`/api/users/${createdUserId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        name: `Usuario Audit Editado ${unique}`,
        email: `user.audit.${unique}@skaler.com`,
        role: 'employee',
        status: 'inactive',
      });

    expect(updateRes.statusCode).toBe(200);
  });

  it('admin can list audit logs filtered by entity and entity id', async () => {
    const res = await request(app)
      .get('/api/audit-logs')
      .set('Authorization', `Bearer ${adminToken}`)
      .query({ entity_type: 'users', entity_id: createdUserId, limit: 10 });

    expect(res.statusCode).toBe(200);
    expect(res.body.success).toBe(true);
    expect(Array.isArray(res.body.data)).toBe(true);
    expect(res.body.meta.total).toBeGreaterThanOrEqual(2);

    const actions = res.body.data.map((item) => item.action);
    expect(actions).toContain('INSERT');
    expect(actions).toContain('UPDATE');

    const updateEntry = res.body.data.find((item) => item.action === 'UPDATE');
    expect(updateEntry).toBeDefined();
    expect(updateEntry.entity_type).toBe('users');
    expect(updateEntry.entity_id).toBe(createdUserId);
    expect(Array.isArray(updateEntry.changed_fields)).toBe(true);
    expect(updateEntry.changed_fields).toContain('name');
    expect(updateEntry.changed_fields).toContain('status');
  });

  it('rejects invalid filters', async () => {
    const res = await request(app)
      .get('/api/audit-logs')
      .set('Authorization', `Bearer ${adminToken}`)
      .query({ entity_type: 'fake_table' });

    expect(res.statusCode).toBe(400);
    expect(res.body.success).toBe(false);
  });

  it('supervisor cannot read audit logs', async () => {
    const res = await request(app)
      .get('/api/audit-logs')
      .set('Authorization', `Bearer ${supervisorToken}`);

    expect(res.statusCode).toBe(403);
  });

  afterAll(async () => {
    await closeDatabase();
  });
});