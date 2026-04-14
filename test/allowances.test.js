const request = require('supertest');
const app = require('../src/server');
const { closeDatabase } = require('../src/config/database');

let authToken;
let administrativeToken;
let leaderToken;
let coordinatorToken;
let leaderUserId;
let coordinatorUserId;
let activeProjectId;
let closedProjectId;
let allowanceProjectId;

describe('Allowances endpoints', () => {
  beforeAll(async () => {
    const loginRes = await request(app)
      .post('/api/auth/login')
      .send({ email: 'admin@skaler.com', password: 'admin123' });

    authToken = loginRes.body.token;

    const activeProjectRes = await request(app)
      .post('/api/projects')
      .set('Authorization', `Bearer ${authToken}`)
      .send({
        name: `Proyecto Viaticos ${Date.now()}`,
        budget: 120000,
      });

    expect(activeProjectRes.statusCode).toBe(201);
    activeProjectId = activeProjectRes.body.projectId;
    allowanceProjectId = activeProjectId;

    const closedProjectRes = await request(app)
      .post('/api/projects')
      .set('Authorization', `Bearer ${authToken}`)
      .send({
        name: `Proyecto Viaticos Cerrado ${Date.now()}`,
        budget: 90000,
      });

    expect(closedProjectRes.statusCode).toBe(201);
    closedProjectId = closedProjectRes.body.projectId;

    const currentClosedRes = await request(app)
      .get(`/api/projects/${closedProjectId}`)
      .set('Authorization', `Bearer ${authToken}`);

    expect(currentClosedRes.statusCode).toBe(200);

    const current = currentClosedRes.body.data;
    const closeRes = await request(app)
      .put(`/api/projects/${closedProjectId}`)
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

    expect(closeRes.statusCode).toBe(200);

    const createLeaderRes = await request(app)
      .post('/api/users')
      .set('Authorization', `Bearer ${authToken}`)
      .send({
        name: `Leader Allowance Request ${Date.now()}`,
        email: `leader.request.${Date.now()}@skaler.com`,
        password: 'Pass1234!',
        role: 'leader',
      });

    expect(createLeaderRes.statusCode).toBe(201);
    leaderUserId = createLeaderRes.body.data.id;

    const createAdministrativeRes = await request(app)
      .post('/api/users')
      .set('Authorization', `Bearer ${authToken}`)
      .send({
        name: `Administrative Allowance Approval ${Date.now()}`,
        email: `administrative.allowance.${Date.now()}@skaler.com`,
        password: 'Pass1234!',
        role: 'administrative',
      });

    expect(createAdministrativeRes.statusCode).toBe(201);

    const createCoordinatorRes = await request(app)
      .post('/api/users')
      .set('Authorization', `Bearer ${authToken}`)
      .send({
        name: `Coordinator Allowance Request ${Date.now()}`,
        email: `coordinator.request.${Date.now()}@skaler.com`,
        password: 'Pass1234!',
        role: 'coordinator_operations',
      });

    expect(createCoordinatorRes.statusCode).toBe(201);
    coordinatorUserId = createCoordinatorRes.body.data.id;

    const leaderScopeRes = await request(app)
      .post('/api/operational-scopes')
      .set('Authorization', `Bearer ${authToken}`)
      .send({
        project_id: activeProjectId,
        user_id: leaderUserId,
        role_scope: 'leader',
      });

    expect(leaderScopeRes.statusCode).toBe(200);

    leaderToken = (
      await request(app)
        .post('/api/auth/login')
        .send({ email: createLeaderRes.body.data.email, password: 'Pass1234!' })
    ).body.token;

    administrativeToken = (
      await request(app)
        .post('/api/auth/login')
        .send({ email: createAdministrativeRes.body.data.email, password: 'Pass1234!' })
    ).body.token;

    coordinatorToken = (
      await request(app)
        .post('/api/auth/login')
        .send({ email: createCoordinatorRes.body.data.email, password: 'Pass1234!' })
    ).body.token;
  });

  it('GET /api/allowances without token should 401', async () => {
    const res = await request(app).get('/api/allowances');
    expect(res.statusCode).toBe(401);
  });

  it('POST /api/allowances/assign assigns allowance to active project', async () => {
    const res = await request(app)
      .post('/api/allowances/assign')
      .set('Authorization', `Bearer ${authToken}`)
      .send({
        project_id: activeProjectId,
        assigned_amount: 150000,
      });

    expect(res.statusCode).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.project_id).toBe(activeProjectId);
    expect(Number(res.body.data.assigned_amount)).toBe(150000);
  });

  it('GET /api/allowances returns assigned allowance list', async () => {
    const res = await request(app)
      .get('/api/allowances')
      .set('Authorization', `Bearer ${authToken}`);

    expect(res.statusCode).toBe(200);
    expect(Array.isArray(res.body.data)).toBe(true);
    expect(res.body.data.some((item) => item.project_id === activeProjectId)).toBe(true);
  });

  it('GET /api/allowances/project/:projectId returns project allowance summary', async () => {
    const res = await request(app)
      .get(`/api/allowances/project/${activeProjectId}`)
      .set('Authorization', `Bearer ${authToken}`);

    expect(res.statusCode).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.project_id).toBe(activeProjectId);
  });

  it('POST /api/allowances/project/:projectId/expenses registers expense and discounts balance', async () => {
    const res = await request(app)
      .post(`/api/allowances/project/${allowanceProjectId}/expenses`)
      .set('Authorization', `Bearer ${authToken}`)
      .send({
        amount: 40000,
        expense_date: '2026-04-07',
        notes: 'Traslado inicial',
        evidence_path: '/uploads/expense-test.jpg',
      });

    expect(res.statusCode).toBe(201);
    expect(res.body.success).toBe(true);
    expect(Number(res.body.summary.spent_amount)).toBe(40000);
    expect(Number(res.body.summary.remaining_amount)).toBe(110000);
  });

  it('GET /api/allowances/project/:projectId/expenses lists registered expenses', async () => {
    const res = await request(app)
      .get(`/api/allowances/project/${allowanceProjectId}/expenses`)
      .set('Authorization', `Bearer ${authToken}`);

    expect(res.statusCode).toBe(200);
    expect(Array.isArray(res.body.data)).toBe(true);
    expect(res.body.data.some((item) => Number(item.amount) === 40000)).toBe(true);
  });

  it('rejects expense that exceeds available balance', async () => {
    const res = await request(app)
      .post(`/api/allowances/project/${allowanceProjectId}/expenses`)
      .set('Authorization', `Bearer ${authToken}`)
      .send({
        amount: 120000,
        expense_date: '2026-04-07',
        notes: 'Exceso de saldo',
      });

    expect(res.statusCode).toBe(409);
    expect(res.body.success).toBe(false);
  });

  it('rejects assigning allowance to finalized project', async () => {
    const res = await request(app)
      .post('/api/allowances/assign')
      .set('Authorization', `Bearer ${authToken}`)
      .send({
        project_id: closedProjectId,
        assigned_amount: 50000,
      });

    expect(res.statusCode).toBe(409);
    expect(res.body.message).toBe('No se puede asignar viático a un proyecto finalizado');
  });

  it('allows leader and coordinator to create allowance requests but blocks administrative creation', async () => {
    const leaderRes = await request(app)
      .post('/api/allowances/requests')
      .set('Authorization', `Bearer ${leaderToken}`)
      .send({
        project_id: activeProjectId,
        departure_date: '2026-04-08',
        return_date: '2026-04-09',
        budget_transport: 12000,
        notes: 'Solicitud creada por líder',
      });

    expect(leaderRes.statusCode).toBe(201);
    expect(leaderRes.body.data.requester_name).toBeDefined();

    const coordinatorRes = await request(app)
      .post('/api/allowances/requests')
      .set('Authorization', `Bearer ${coordinatorToken}`)
      .send({
        project_id: activeProjectId,
        departure_date: '2026-04-10',
        return_date: '2026-04-11',
        budget_transport: 15000,
        notes: 'Solicitud creada por coordinacion',
      });

    expect(coordinatorRes.statusCode).toBe(201);

    const adminRes = await request(app)
      .post('/api/allowances/requests')
      .set('Authorization', `Bearer ${administrativeToken}`)
      .send({
        project_id: activeProjectId,
        departure_date: '2026-04-12',
        return_date: '2026-04-13',
        budget_transport: 18000,
        notes: 'Solicitud creada por administrativo',
      });

    expect(adminRes.statusCode).toBe(403);
  });

  it('allows only administrative profiles to approve allowance requests', async () => {
    const requestRes = await request(app)
      .post('/api/allowances/requests')
      .set('Authorization', `Bearer ${leaderToken}`)
      .send({
        project_id: activeProjectId,
        departure_date: '2026-04-14',
        return_date: '2026-04-15',
        budget_transport: 9000,
        notes: 'Solicitud pendiente de aprobacion',
      });

    expect(requestRes.statusCode).toBe(201);
    const requestId = requestRes.body.data.id;

    const leaderDecisionRes = await request(app)
      .patch(`/api/allowances/requests/${requestId}/status`)
      .set('Authorization', `Bearer ${leaderToken}`)
      .send({ status: 'approved' });

    expect(leaderDecisionRes.statusCode).toBe(403);

    const adminDecisionRes = await request(app)
      .patch(`/api/allowances/requests/${requestId}/status`)
      .set('Authorization', `Bearer ${administrativeToken}`)
      .send({ status: 'approved', decision_notes: 'Aprobada por administrativo' });

    expect(adminDecisionRes.statusCode).toBe(200);
    expect(adminDecisionRes.body.data.status).toBe('approved');
    expect(adminDecisionRes.body.data.approver_name).toBeDefined();
  });

  afterAll(async () => {
    await closeDatabase();
  });
});