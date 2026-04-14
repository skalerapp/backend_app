const request = require('supertest');
const app = require('../src/server');
const { closeDatabase } = require('../src/config/database');

let authToken;
let createdProjectId;
let secondProjectId;
let thirdProjectId;
let fourthProjectId;
let createdEmployeeId;
let createdActivityId;

describe('Project collaborators endpoints', () => {
  beforeAll(async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: 'admin@skaler.com', password: 'admin123' });
    authToken = res.body.token;
  });

  it('should create base project and employee', async () => {
    const projectRes = await request(app)
      .post('/api/projects')
      .set('Authorization', `Bearer ${authToken}`)
      .send({
        name: `Proyecto Test ${Date.now()}`,
        budget: 1000000,
      });

    expect(projectRes.statusCode).toEqual(201);
    createdProjectId = projectRes.body.projectId;

    const secondProjectRes = await request(app)
      .post('/api/projects')
      .set('Authorization', `Bearer ${authToken}`)
      .send({
        name: `Proyecto Test 2 ${Date.now()}`,
        budget: 2000000,
      });

    expect(secondProjectRes.statusCode).toEqual(201);
    secondProjectId = secondProjectRes.body.projectId;

    const thirdProjectRes = await request(app)
      .post('/api/projects')
      .set('Authorization', `Bearer ${authToken}`)
      .send({
        name: `Proyecto Test 3 ${Date.now()}`,
        budget: 3000000,
      });

    expect(thirdProjectRes.statusCode).toEqual(201);
    thirdProjectId = thirdProjectRes.body.projectId;

    const fourthProjectRes = await request(app)
      .post('/api/projects')
      .set('Authorization', `Bearer ${authToken}`)
      .send({
        name: `Proyecto Test 4 ${Date.now()}`,
        budget: 4000000,
      });

    expect(fourthProjectRes.statusCode).toEqual(201);
    fourthProjectId = fourthProjectRes.body.projectId;

    const employeeRes = await request(app)
      .post('/api/employees')
      .set('Authorization', `Bearer ${authToken}`)
      .send({
        employee_name: 'Colaborador Proyecto Test',
        identification_number: `PT-${Date.now()}`,
        position: 'Operario',
        department: 'Operaciones',
        status: 'active',
      });

    expect(employeeRes.statusCode).toEqual(201);
    createdEmployeeId = employeeRes.body.employeeId;
  });

  it('should assign collaborator to project', async () => {
    const res = await request(app)
      .post(`/api/projects/${createdProjectId}/collaborators`)
      .set('Authorization', `Bearer ${authToken}`)
      .send({ employee_id: createdEmployeeId });

    expect(res.statusCode).toEqual(201);
  });

  it('should reject duplicate assignment to the same project', async () => {
    const res = await request(app)
      .post(`/api/projects/${createdProjectId}/collaborators`)
      .set('Authorization', `Bearer ${authToken}`)
      .send({ employee_id: createdEmployeeId });

    expect(res.statusCode).toEqual(409);
    expect(res.body).toHaveProperty('message', 'El colaborador ya está asignado a este proyecto');
  });

  it('should list only assigned collaborators for project', async () => {
    const res = await request(app)
      .get(`/api/projects/${createdProjectId}/collaborators`)
      .set('Authorization', `Bearer ${authToken}`);

    expect(res.statusCode).toEqual(200);
    expect(Array.isArray(res.body.data)).toBe(true);
    expect(res.body.data.some((item) => item.id === createdEmployeeId)).toBe(true);
  });

  it('should prevent assigning collaborator to another project', async () => {
    const res = await request(app)
      .post(`/api/projects/${secondProjectId}/collaborators`)
      .set('Authorization', `Bearer ${authToken}`)
      .send({ employee_id: createdEmployeeId });

    expect(res.statusCode).toEqual(409);
  });

  it('should prevent removing collaborator with active activities', async () => {
    const activityRes = await request(app)
      .post('/api/activities')
      .set('Authorization', `Bearer ${authToken}`)
      .send({
        project_id: createdProjectId,
        employee_id: createdEmployeeId,
        description: 'Actividad activa de prueba',
        status: 'in_progress',
      });

    expect(activityRes.statusCode).toEqual(201);
    createdActivityId = activityRes.body.activityId;

    const removeRes = await request(app)
      .delete(`/api/projects/${createdProjectId}/collaborators/${createdEmployeeId}`)
      .set('Authorization', `Bearer ${authToken}`);

    expect(removeRes.statusCode).toEqual(409);
  });

  it('should remove test activity before unassigning collaborator', async () => {
    if (!createdActivityId) return;

    const res = await request(app)
      .delete(`/api/activities/${createdActivityId}`)
      .set('Authorization', `Bearer ${authToken}`);

    expect(res.statusCode).toEqual(200);
  });

  it('should remove collaborator from project', async () => {
    const res = await request(app)
      .delete(`/api/projects/${createdProjectId}/collaborators/${createdEmployeeId}`)
      .set('Authorization', `Bearer ${authToken}`);

    expect(res.statusCode).toEqual(200);
  });

  it('should assign collaborator to second project after unassign', async () => {
    const res = await request(app)
      .post(`/api/projects/${secondProjectId}/collaborators`)
      .set('Authorization', `Bearer ${authToken}`)
      .send({ employee_id: createdEmployeeId });

    expect(res.statusCode).toEqual(201);
  });

  it('should reassign collaborator when current project is completed', async () => {
    const currentProjectRes = await request(app)
      .get(`/api/projects/${secondProjectId}`)
      .set('Authorization', `Bearer ${authToken}`);

    expect(currentProjectRes.statusCode).toEqual(200);

    const current = currentProjectRes.body.data;

    const updateRes = await request(app)
      .put(`/api/projects/${secondProjectId}`)
      .set('Authorization', `Bearer ${authToken}`)
      .send({
        name: current.name,
        description: current.description,
        budget: current.budget,
        start_date: current.start_date,
        end_date: current.end_date,
        status: 'completed',
        manager_id: current.manager_id,
      });

    expect(updateRes.statusCode).toEqual(200);

    const reassignRes = await request(app)
      .post(`/api/projects/${thirdProjectId}/collaborators`)
      .set('Authorization', `Bearer ${authToken}`)
      .send({ employee_id: createdEmployeeId });

    expect([200, 201]).toContain(reassignRes.statusCode);

    const thirdListRes = await request(app)
      .get(`/api/projects/${thirdProjectId}/collaborators`)
      .set('Authorization', `Bearer ${authToken}`);

    expect(thirdListRes.statusCode).toEqual(200);
    expect(Array.isArray(thirdListRes.body.data)).toBe(true);
    expect(thirdListRes.body.data.some((item) => item.id === createdEmployeeId)).toBe(true);
  });

  it('should reassign collaborator when current project is paused', async () => {
    const currentProjectRes = await request(app)
      .get(`/api/projects/${thirdProjectId}`)
      .set('Authorization', `Bearer ${authToken}`);

    expect(currentProjectRes.statusCode).toEqual(200);

    const current = currentProjectRes.body.data;

    const updateRes = await request(app)
      .put(`/api/projects/${thirdProjectId}`)
      .set('Authorization', `Bearer ${authToken}`)
      .send({
        name: current.name,
        description: current.description,
        budget: current.budget,
        start_date: current.start_date,
        end_date: current.end_date,
        status: 'paused',
        manager_id: current.manager_id,
      });

    expect(updateRes.statusCode).toEqual(200);

    const reassignRes = await request(app)
      .post(`/api/projects/${fourthProjectId}/collaborators`)
      .set('Authorization', `Bearer ${authToken}`)
      .send({ employee_id: createdEmployeeId });

    expect([200, 201]).toContain(reassignRes.statusCode);

    const fourthListRes = await request(app)
      .get(`/api/projects/${fourthProjectId}/collaborators`)
      .set('Authorization', `Bearer ${authToken}`);

    expect(fourthListRes.statusCode).toEqual(200);
    expect(Array.isArray(fourthListRes.body.data)).toBe(true);
    expect(fourthListRes.body.data.some((item) => item.id === createdEmployeeId)).toBe(true);
  });

  afterAll(async () => {
    if (createdEmployeeId) {
      await request(app)
        .delete(`/api/employees/${createdEmployeeId}`)
        .set('Authorization', `Bearer ${authToken}`);
    }

    if (createdProjectId) {
      await request(app)
        .delete(`/api/projects/${createdProjectId}`)
        .set('Authorization', `Bearer ${authToken}`);
    }

    if (secondProjectId) {
      await request(app)
        .delete(`/api/projects/${secondProjectId}`)
        .set('Authorization', `Bearer ${authToken}`);
    }

    if (thirdProjectId) {
      await request(app)
        .delete(`/api/projects/${thirdProjectId}`)
        .set('Authorization', `Bearer ${authToken}`);
    }

    if (fourthProjectId) {
      await request(app)
        .delete(`/api/projects/${fourthProjectId}`)
        .set('Authorization', `Bearer ${authToken}`);
    }

    await closeDatabase();
  });
});
