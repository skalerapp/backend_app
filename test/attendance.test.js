const request = require('supertest');
const app = require('../src/server');
const { closeDatabase } = require('../src/config/database');

let authToken;
let employeeId;
let attendanceId;
const testAttendanceDate = new Date(Date.now() + ((Date.now() % 1000) + 1) * 86400000)
  .toISOString()
  .slice(0, 10);

describe('Attendance endpoints', () => {
  beforeAll(async () => {
    const loginRes = await request(app)
      .post('/api/auth/login')
      .send({ email: 'admin@skaler.com', password: 'admin123' });

    authToken = loginRes.body.token;

    const employeesRes = await request(app)
      .get('/api/employees')
      .set('Authorization', `Bearer ${authToken}`);

    if (Array.isArray(employeesRes.body.data) && employeesRes.body.data.length > 0) {
      employeeId = employeesRes.body.data[0].id;
    }

    expect(employeeId).toBeDefined();
  });

  it('GET /api/attendance without token should 401', async () => {
    const res = await request(app).get('/api/attendance');
    expect(res.statusCode).toBe(401);
  });

  it('POST /api/attendance/check-in should create attendance', async () => {
    const payload = {
      employee_id: employeeId,
      location_latitude: 4.7110,
      location_longitude: -74.0721,
      photo_path: 'uploads/test-attendance.jpg',
      attendance_date: testAttendanceDate,
    };

    const res = await request(app)
      .post('/api/attendance/check-in')
      .set('Authorization', `Bearer ${authToken}`)
      .send(payload);

    expect([200, 201]).toContain(res.statusCode);
    if (res.body.attendanceId) {
      attendanceId = res.body.attendanceId;
    }
  });

  it('POST /api/attendance/check-in should prevent duplicate attendance same day', async () => {
    const payload = {
      employee_id: employeeId,
      location_latitude: 4.7112,
      location_longitude: -74.0723,
      photo_path: 'uploads/test-attendance-duplicate.jpg',
      attendance_date: testAttendanceDate,
    };

    const res = await request(app)
      .post('/api/attendance/check-in')
      .set('Authorization', `Bearer ${authToken}`)
      .send(payload);

    expect(res.statusCode).toBe(400);
  });

  it('GET /api/attendance with token should return list', async () => {
    const res = await request(app)
      .get('/api/attendance')
      .set('Authorization', `Bearer ${authToken}`);

    expect(res.statusCode).toBe(200);
    expect(Array.isArray(res.body.data)).toBe(true);
  });

  it('PUT /api/attendance/:id/check-out should close attendance', async () => {
    if (!attendanceId) return;

    const res = await request(app)
      .put(`/api/attendance/${attendanceId}/check-out`)
      .set('Authorization', `Bearer ${authToken}`)
      .send({
        location_latitude: 4.7111,
        location_longitude: -74.0722
      });

    expect(res.statusCode).toBe(200);
  });

  afterAll(async () => {
    await closeDatabase();
  });
});
