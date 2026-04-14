const request = require('supertest');
const app = require('../src/server');
const { closeDatabase } = require('../src/config/database');

const unique = Date.now();

let adminToken;
let leaderToken;
let supervisorToken;

let leaderUserId;
let supervisorUserId;
let employeeUser1Id;
let employeeUser2Id;

let employee1Id;
let employee2Id;

let project1Id;
let project2Id;
let activityId;

describe('RBAC scope rules (leader/supervisor/administrative)', () => {
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
    expect(res.body.employeeId).toBeDefined();
    return res.body.employeeId;
  };

  const createProjectAsAdmin = async ({ name, managerId }) => {
    const res = await request(app)
      .post('/api/projects')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ name, budget: 10000, manager_id: managerId });

    expect(res.statusCode).toBe(201);
    expect(res.body.projectId).toBeDefined();
    return res.body.projectId;
  };

  beforeAll(async () => {
    adminToken = await login('admin@skaler.com', 'admin123');

    leaderUserId = await createUserAsAdmin({
      name: `Leader RBAC ${unique}`,
      email: `leader.rbac.${unique}@skaler.com`,
      password: 'Pass1234!',
      role: 'leader',
    });

    supervisorUserId = await createUserAsAdmin({
      name: `Supervisor RBAC ${unique}`,
      email: `supervisor.rbac.${unique}@skaler.com`,
      password: 'Pass1234!',
      role: 'supervisor',
    });

    employeeUser1Id = await createUserAsAdmin({
      name: `Employee1 RBAC ${unique}`,
      email: `employee1.rbac.${unique}@skaler.com`,
      password: 'Pass1234!',
      role: 'employee',
    });

    employeeUser2Id = await createUserAsAdmin({
      name: `Employee2 RBAC ${unique}`,
      email: `employee2.rbac.${unique}@skaler.com`,
      password: 'Pass1234!',
      role: 'employee',
    });

    employee1Id = await createEmployeeAsAdmin({
      userId: employeeUser1Id,
      name: `Colaborador Uno ${unique}`,
      idNumber: `CC-${unique}-1`,
    });

    employee2Id = await createEmployeeAsAdmin({
      userId: employeeUser2Id,
      name: `Colaborador Dos ${unique}`,
      idNumber: `CC-${unique}-2`,
    });

    project1Id = await createProjectAsAdmin({
      name: `Proyecto Leader ${unique}`,
      managerId: leaderUserId,
    });

    project2Id = await createProjectAsAdmin({
      name: `Proyecto General ${unique}`,
      managerId: supervisorUserId,
    });

    const assignEmp1 = await request(app)
      .post(`/api/projects/${project1Id}/collaborators`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ employee_id: employee1Id });
    expect([200, 201]).toContain(assignEmp1.statusCode);

    const createActivity = await request(app)
      .post('/api/activities')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        project_id: project1Id,
        employee_id: employee1Id,
        description: 'Actividad inicial RBAC',
        status: 'planned',
      });
    expect([200, 201]).toContain(createActivity.statusCode);
    activityId = createActivity.body.activityId;
    expect(activityId).toBeDefined();

    leaderToken = await login(`leader.rbac.${unique}@skaler.com`, 'Pass1234!');
    supervisorToken = await login(`supervisor.rbac.${unique}@skaler.com`, 'Pass1234!');
  });

  it('supervisor can visualize all projects', async () => {
    const res = await request(app)
      .get('/api/projects')
      .set('Authorization', `Bearer ${supervisorToken}`);

    expect(res.statusCode).toBe(200);
    const ids = (res.body.data || []).map((p) => p.id);
    expect(ids).toContain(project1Id);
    expect(ids).toContain(project2Id);
  });

  it('leader sees only own/scoped project and assigned personnel', async () => {
    const projectsRes = await request(app)
      .get('/api/projects')
      .set('Authorization', `Bearer ${leaderToken}`);

    expect(projectsRes.statusCode).toBe(200);
    const projectIds = (projectsRes.body.data || []).map((p) => p.id);
    expect(projectIds).toContain(project1Id);
    expect(projectIds).not.toContain(project2Id);

    const collaboratorsRes = await request(app)
      .get(`/api/projects/${project1Id}/collaborators`)
      .set('Authorization', `Bearer ${leaderToken}`);

    expect(collaboratorsRes.statusCode).toBe(200);
    const employeeIds = (collaboratorsRes.body.data || []).map((e) => e.id);
    expect(employeeIds).toContain(employee1Id);
    expect(employeeIds).not.toContain(employee2Id);

    const forbiddenProjectRes = await request(app)
      .get(`/api/projects/${project2Id}/collaborators`)
      .set('Authorization', `Bearer ${leaderToken}`);

    expect(forbiddenProjectRes.statusCode).toBe(403);
  });

  it('leader can update only activity status (cannot edit other fields)', async () => {
    const updateStatusOnly = await request(app)
      .put(`/api/activities/${activityId}`)
      .set('Authorization', `Bearer ${leaderToken}`)
      .send({ status: 'in_progress' });

    expect(updateStatusOnly.statusCode).toBe(200);

    const updateDescriptionAttempt = await request(app)
      .put(`/api/activities/${activityId}`)
      .set('Authorization', `Bearer ${leaderToken}`)
      .send({
        status: 'completed',
        description: 'Intento no permitido',
      });

    expect(updateDescriptionAttempt.statusCode).toBe(403);
  });

  it('leader cannot create or delete activities', async () => {
    const createAttempt = await request(app)
      .post('/api/activities')
      .set('Authorization', `Bearer ${leaderToken}`)
      .send({
        project_id: project1Id,
        employee_id: employee1Id,
        description: 'No debería crear',
      });

    expect(createAttempt.statusCode).toBe(403);

    const deleteAttempt = await request(app)
      .delete(`/api/activities/${activityId}`)
      .set('Authorization', `Bearer ${leaderToken}`);

    expect(deleteAttempt.statusCode).toBe(403);
  });

  it('attendance check-in rejects collaborator not assigned to selected project', async () => {
    const unassignedAttempt = await request(app)
      .post('/api/attendance/check-in')
      .set('Authorization', `Bearer ${leaderToken}`)
      .send({
        employee_id: employee2Id,
        project_id: project1Id,
        location_latitude: 4.71,
        location_longitude: -74.07,
      });

    expect(unassignedAttempt.statusCode).toBe(400);

    const assignedAttempt = await request(app)
      .post('/api/attendance/check-in')
      .set('Authorization', `Bearer ${leaderToken}`)
      .send({
        employee_id: employee1Id,
        project_id: project1Id,
        location_latitude: 4.71,
        location_longitude: -74.07,
      });

    expect([200, 201]).toContain(assignedAttempt.statusCode);
  });

  afterAll(async () => {
    await closeDatabase();
  });
});
