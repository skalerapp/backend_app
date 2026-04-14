const request = require('supertest');
const app = require('../src/server');
const { closeDatabase } = require('../src/config/database');

let authToken;
let projectId;
let uploadedFileName;

describe('Evidence endpoints', () => {
  beforeAll(async () => {
    const loginRes = await request(app)
      .post('/api/auth/login')
      .send({ email: 'admin@skaler.com', password: 'admin123' });

    authToken = loginRes.body.token;

    const projectRes = await request(app)
      .post('/api/projects')
      .set('Authorization', `Bearer ${authToken}`)
      .send({
        name: `Proyecto Evidencia API ${Date.now()}`,
        budget: 140000,
      });

    expect(projectRes.statusCode).toBe(201);
    projectId = projectRes.body.projectId;
  });

  it('GET /api/evidence without token should 401', async () => {
    const res = await request(app).get('/api/evidence');
    expect(res.statusCode).toBe(401);
  });

  it('POST /api/evidence/upload rejects missing file', async () => {
    const res = await request(app)
      .post('/api/evidence/upload')
      .set('Authorization', `Bearer ${authToken}`)
      .field('project_id', String(projectId))
      .field('module_type', 'projects');

    expect(res.statusCode).toBe(400);
    expect(res.body.message).toBe('Archivo no proporcionado');
  });

  it('POST /api/evidence/upload stores multipart file and metadata', async () => {
    const pngBytes = Buffer.from([
      137, 80, 78, 71, 13, 10, 26, 10,
      0, 0, 0, 13, 73, 72, 68, 82,
      0, 0, 0, 1, 0, 0, 0, 1,
      8, 6, 0, 0, 0, 31, 21, 196,
      137, 0, 0, 0, 13, 73, 68, 65,
      84, 120, 156, 99, 248, 255, 255, 63,
      0, 5, 254, 2, 254, 167, 53, 129,
      132, 0, 0, 0, 0, 73, 69, 78,
      68, 174, 66, 96, 130,
    ]);

    const res = await request(app)
      .post('/api/evidence/upload')
      .set('Authorization', `Bearer ${authToken}`)
      .field('project_id', String(projectId))
      .field('module_type', 'projects')
      .attach('file', pngBytes, { filename: 'evidence-test.png', contentType: 'image/png' });

    expect(res.statusCode).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.file.path).toContain('projects/');
    expect(res.body.file.name).toBe('evidence-test.png');
    uploadedFileName = res.body.file.name;
  });

  it('GET /api/evidence lists uploaded evidence filtered by project and module', async () => {
    const res = await request(app)
      .get('/api/evidence')
      .set('Authorization', `Bearer ${authToken}`)
      .query({ project_id: projectId, module_type: 'projects' });

    expect(res.statusCode).toBe(200);
    expect(Array.isArray(res.body.data)).toBe(true);
    expect(res.body.data.some((item) => item.project_id === projectId)).toBe(true);
    expect(res.body.data.some((item) => item.file_name === uploadedFileName)).toBe(true);
  });

  it('GET /api/evidence can filter by module_type only', async () => {
    const res = await request(app)
      .get('/api/evidence')
      .set('Authorization', `Bearer ${authToken}`)
      .query({ module_type: 'projects' });

    expect(res.statusCode).toBe(200);
    expect(Array.isArray(res.body.data)).toBe(true);
    expect(res.body.data.some((item) => item.file_name === uploadedFileName)).toBe(true);
  });

  afterAll(async () => {
    await closeDatabase();
  });
});