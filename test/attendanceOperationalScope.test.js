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
let scopedAttendanceId;

describe('Attendance operational scope visibility', () => {
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
      .send({
        name,
        email,
        password: 'Pass1234!',
        role,
      });

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
      name: `Leader Attendance ${unique}`,
      email: `leader.attendance.${unique}@skaler.com`,
      role: 'leader',
    });

    employeeUser1Id = await createUserAsAdmin({
      name: `Employee Scope ${unique}`,
      email: `employee.scope.${unique}@skaler.com`,
      role: 'employee',
    });

    employeeUser2Id = await createUserAsAdmin({
      name: `Employee Hidden ${unique}`,
      email: `employee.hidden.${unique}@skaler.com`,
      role: 'employee',
    });

    employee1Id = await createEmployeeAsAdmin({
      userId: employeeUser1Id,
      name: `Colaborador Scope ${unique}`,
      idNumber: `ATT-${unique}-1`,
    });

    employee2Id = await createEmployeeAsAdmin({
      userId: employeeUser2Id,
      name: `Colaborador Hidden ${unique}`,
      idNumber: `ATT-${unique}-2`,
    });

    const scopedProjectRes = await request(app)
      .post('/api/projects')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ name: `Proyecto Scope Attendance ${unique}`, budget: 130000 });
    expect(scopedProjectRes.statusCode).toBe(201);
    scopedProjectId = scopedProjectRes.body.projectId;

    const unscopedProjectRes = await request(app)
      .post('/api/projects')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ name: `Proyecto Hidden Attendance ${unique}`, budget: 135000 });
    expect(unscopedProjectRes.statusCode).toBe(201);
    unscopedProjectId = unscopedProjectRes.body.projectId;

    const scopeRes = await request(app)
      .post('/api/operational-scopes')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ project_id: scopedProjectId, user_id: leaderUserId, role_scope: 'leader' });
    expect(scopeRes.statusCode).toBe(200);

    const assign1 = await request(app)
      .post(`/api/projects/${scopedProjectId}/collaborators`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ employee_id: employee1Id });
    expect([200, 201]).toContain(assign1.statusCode);

    const assign2 = await request(app)
      .post(`/api/projects/${unscopedProjectId}/collaborators`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ employee_id: employee2Id });
    expect([200, 201]).toContain(assign2.statusCode);

    const scopedCheckIn = await request(app)
      .post('/api/attendance/check-in')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        employee_id: employee1Id,
        project_id: scopedProjectId,
        location_latitude: 4.71,
        location_longitude: -74.07,
        attendance_date: '2026-04-18',
      });
    expect(scopedCheckIn.statusCode).toBe(201);
    scopedAttendanceId = scopedCheckIn.body.attendanceId;

    const hiddenCheckIn = await request(app)
      .post('/api/attendance/check-in')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        employee_id: employee2Id,
        project_id: unscopedProjectId,
        location_latitude: 4.72,
        location_longitude: -74.08,
        attendance_date: '2026-04-18',
      });
    expect(hiddenCheckIn.statusCode).toBe(201);

    leaderToken = await login(`leader.attendance.${unique}@skaler.com`, 'Pass1234!');

    const ownCheckIn = await request(app)
      .post('/api/attendance/check-in')
      .set('Authorization', `Bearer ${leaderToken}`)
      .send({
        location_latitude: 4.73,
        location_longitude: -74.09,
        attendance_date: '2026-04-19',
      });
    expect(ownCheckIn.statusCode).toBe(201);
  });

  it('GET /api/attendance lists only scoped attendance for leader by default', async () => {
    const res = await request(app)
      .get('/api/attendance')
      .set('Authorization', `Bearer ${leaderToken}`);

    expect(res.statusCode).toBe(200);
    const attendanceIds = (res.body.data || []).map((item) => item.id);
    expect(attendanceIds).toContain(scopedAttendanceId);
    expect((res.body.data || []).some((item) => item.project_id === unscopedProjectId)).toBe(false);
  });

  it('GET /api/attendance?user_id=self returns own user attendance even without scoped project', async () => {
    const res = await request(app)
      .get('/api/attendance')
      .query({ user_id: leaderUserId })
      .set('Authorization', `Bearer ${leaderToken}`);

    expect(res.statusCode).toBe(200);
    expect((res.body.data || []).some((item) => Number(item.user_id) === leaderUserId)).toBe(true);
  });

  it('GET /api/attendance/:id denies access to unscoped attendance record', async () => {
    const hiddenList = await request(app)
      .get('/api/attendance')
      .query({ user_id: employeeUser2Id })
      .set('Authorization', `Bearer ${adminToken}`);

    expect(hiddenList.statusCode).toBe(200);
    const hiddenRecord = (hiddenList.body.data || []).find((item) => item.project_id === unscopedProjectId);
    expect(hiddenRecord).toBeDefined();

    const res = await request(app)
      .get(`/api/attendance/${hiddenRecord.id}`)
      .set('Authorization', `Bearer ${leaderToken}`);

    expect(res.statusCode).toBe(404);
  });

  it('PUT /api/attendance/:id/check-out denies closing unscoped attendance for leader', async () => {
    const hiddenList = await request(app)
      .get('/api/attendance')
      .query({ user_id: employeeUser2Id })
      .set('Authorization', `Bearer ${adminToken}`);

    const hiddenRecord = (hiddenList.body.data || []).find((item) => item.project_id === unscopedProjectId);

    const res = await request(app)
      .put(`/api/attendance/${hiddenRecord.id}/check-out`)
      .set('Authorization', `Bearer ${leaderToken}`)
      .send({ location_latitude: 4.74, location_longitude: -74.1 });

    expect(res.statusCode).toBe(403);
    expect(res.body.message).toBe('No tienes acceso operativo para cerrar este registro');
  });

  afterAll(async () => {
    await closeDatabase();
  });
});