const request = require('supertest');
const app = require('../src/server');
const { closeDatabase } = require('../src/config/database');

const unique = Date.now();

let adminToken;
let leaderToken;
let leaderUserId;
let employeeUser1Id;
let employeeUser2Id;
let employee1Id;
let employee2Id;
let scopedProjectId;
let unscopedProjectId;
let scopedActivityId;
let unscopedActivityId;

describe('Activities operational scope visibility', () => {
  const login = async (email, password) => {
    const res = await request(app)
      .post('/api/auth/login')
      .send({ email, password });

    expect(res.statusCode).toBe(200);
    expect(res.body.token).toBeDefined();
    return res.body.token;
  };

  const createUserAsAdmin = async ({ name, email, role }) => {
    const res = await request(app)
      .post('/api/users')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ name, email, password: 'Pass1234!', role });

    expect(res.statusCode).toBe(201);
    return res.body.data.id;
  };

  const createEmployeeAsAdmin = async ({ userId, name, idNumber }) => {
    const res = await request(app)
      .post('/api/employees')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        user_id: userId,
        employee_name: name,
        identification_number: idNumber,
        position: 'Operario',
        department: 'Operaciones',
        status: 'active',
      });

    expect(res.statusCode).toBe(201);
    return res.body.employeeId;
  };

  beforeAll(async () => {
    adminToken = await login('admin@skaler.com', 'admin123');

    leaderUserId = await createUserAsAdmin({
      name: `Leader Activities ${unique}`,
      email: `leader.activities.${unique}@skaler.com`,
      role: 'leader',
    });

    employeeUser1Id = await createUserAsAdmin({
      name: `Employee Activity Scope ${unique}`,
      email: `employee.activities.scope.${unique}@skaler.com`,
      role: 'employee',
    });

    employeeUser2Id = await createUserAsAdmin({
      name: `Employee Activity Hidden ${unique}`,
      email: `employee.activities.hidden.${unique}@skaler.com`,
      role: 'employee',
    });

    employee1Id = await createEmployeeAsAdmin({
      userId: employeeUser1Id,
      name: `Colaborador Activity Scope ${unique}`,
      idNumber: `ACT-${unique}-1`,
    });

    employee2Id = await createEmployeeAsAdmin({
      userId: employeeUser2Id,
      name: `Colaborador Activity Hidden ${unique}`,
      idNumber: `ACT-${unique}-2`,
    });

    const scopedProjectRes = await request(app)
      .post('/api/projects')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ name: `Proyecto Scope Activity ${unique}`, budget: 100000 });
    expect(scopedProjectRes.statusCode).toBe(201);
    scopedProjectId = scopedProjectRes.body.projectId;

    const unscopedProjectRes = await request(app)
      .post('/api/projects')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ name: `Proyecto Hidden Activity ${unique}`, budget: 101000 });
    expect(unscopedProjectRes.statusCode).toBe(201);
    unscopedProjectId = unscopedProjectRes.body.projectId;

    const scopeRes = await request(app)
      .post('/api/operational-scopes')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ project_id: scopedProjectId, user_id: leaderUserId, role_scope: 'leader' });
    expect(scopeRes.statusCode).toBe(200);

    const assignScoped = await request(app)
      .post(`/api/projects/${scopedProjectId}/collaborators`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ employee_id: employee1Id });
    expect([200, 201]).toContain(assignScoped.statusCode);

    const assignHidden = await request(app)
      .post(`/api/projects/${unscopedProjectId}/collaborators`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ employee_id: employee2Id });
    expect([200, 201]).toContain(assignHidden.statusCode);

    const scopedActivityRes = await request(app)
      .post('/api/activities')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        project_id: scopedProjectId,
        employee_id: employee1Id,
        description: 'Actividad scoped',
        status: 'planned',
      });
    expect(scopedActivityRes.statusCode).toBe(201);
    scopedActivityId = scopedActivityRes.body.activityId;

    const hiddenActivityRes = await request(app)
      .post('/api/activities')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        project_id: unscopedProjectId,
        employee_id: employee2Id,
        description: 'Actividad hidden',
        status: 'planned',
      });
    expect(hiddenActivityRes.statusCode).toBe(201);
    unscopedActivityId = hiddenActivityRes.body.activityId;

    leaderToken = await login(`leader.activities.${unique}@skaler.com`, 'Pass1234!');
  });

  it('GET /api/activities lists only scoped activities for leader', async () => {
    const res = await request(app)
      .get('/api/activities')
      .set('Authorization', `Bearer ${leaderToken}`);

    expect(res.statusCode).toBe(200);
    const activityIds = (res.body.data || []).map((item) => item.id);
    expect(activityIds).toContain(scopedActivityId);
    expect(activityIds).not.toContain(unscopedActivityId);
  });

  it('GET /api/activities/:id returns 404 for activity outside operational scope', async () => {
    const res = await request(app)
      .get(`/api/activities/${unscopedActivityId}`)
      .set('Authorization', `Bearer ${leaderToken}`);

    expect(res.statusCode).toBe(404);
  });

  it('PUT /api/activities/:id allows status-only update inside scope', async () => {
    const res = await request(app)
      .put(`/api/activities/${scopedActivityId}`)
      .set('Authorization', `Bearer ${leaderToken}`)
      .send({ status: 'in_progress' });

    expect(res.statusCode).toBe(200);
  });

  it('PUT /api/activities/:id denies status update outside scope', async () => {
    const res = await request(app)
      .put(`/api/activities/${unscopedActivityId}`)
      .set('Authorization', `Bearer ${leaderToken}`)
      .send({ status: 'completed' });

    expect(res.statusCode).toBe(403);
    expect(res.body.message).toBe('No tienes acceso operativo a esta actividad');
  });

  afterAll(async () => {
    await closeDatabase();
  });
});