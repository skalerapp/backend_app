const request = require('supertest');
const app = require('../src/server');
const { closeDatabase } = require('../src/config/database');

let authToken;
let projectId;
let visitId;
let opportunityId;

describe('Commercial endpoints', () => {
  beforeAll(async () => {
    const loginRes = await request(app)
      .post('/api/auth/login')
      .send({ email: 'admin@skaler.com', password: 'admin123' });

    authToken = loginRes.body.token;

    const projectRes = await request(app)
      .post('/api/projects')
      .set('Authorization', `Bearer ${authToken}`)
      .send({
        name: `Proyecto Comercial ${Date.now()}`,
        budget: 220000,
      });

    expect(projectRes.statusCode).toBe(201);
    projectId = projectRes.body.projectId;
  });

  it('GET /api/commercial/visits without token should 401', async () => {
    const res = await request(app).get('/api/commercial/visits');
    expect(res.statusCode).toBe(401);
  });

  it('POST /api/commercial/visits creates a georeferenced commercial visit', async () => {
    const res = await request(app)
      .post('/api/commercial/visits')
      .set('Authorization', `Bearer ${authToken}`)
      .send({
        client_name: 'Cliente Norte S.A.S.',
        client_contact: 'Laura Gómez',
        visit_date: '2026-04-10',
        latitude: 4.711,
        longitude: -74.0721,
        form_type: 'levantamiento',
        summary: 'Visita inicial para validar alcance técnico.',
        outcome: 'Cliente interesado en propuesta.',
        next_action: 'Enviar cotización y agenda de demo.',
        next_action_date: '2026-04-15',
        evidence_path: '/uploads/commercial/test-visit.jpg',
        form_payload: {
          interest_level: 'alto',
          estimated_value: '25000000',
          decision_window: '15 días',
        },
        expense_amount: 85000,
        status: 'completed',
        project_id: projectId,
      });

    expect(res.statusCode).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.data.client_name).toBe('Cliente Norte S.A.S.');
    expect(res.body.data.project_id).toBe(projectId);
    expect(res.body.data.evidence_path).toBe('/uploads/commercial/test-visit.jpg');
    expect(res.body.data.form_payload.interest_level).toBe('alto');
    visitId = res.body.data.id;
  });

  it('POST /api/commercial/opportunities creates a pipeline opportunity linked to a visit', async () => {
    const res = await request(app)
      .post('/api/commercial/opportunities')
      .set('Authorization', `Bearer ${authToken}`)
      .send({
        client_name: 'Cliente Norte S.A.S.',
        contact_name: 'Laura Gómez',
        opportunity_name: 'Propuesta expansión zona norte',
        stage: 'proposal',
        estimated_value: 42000000,
        probability: 65,
        expected_close_date: '2026-04-29',
        next_step: 'Validar propuesta económica con compras.',
        notes: 'Se requiere visita de ingeniería para cierre técnico.',
        project_id: projectId,
        source_visit_id: visitId,
      });

    expect(res.statusCode).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.data.opportunity_name).toBe('Propuesta expansión zona norte');
    expect(res.body.data.stage).toBe('proposal');
    expect(Number(res.body.data.estimated_value)).toBe(42000000);
    expect(res.body.data.source_visit_id).toBe(visitId);
    opportunityId = res.body.data.id;
  });

  it('GET /api/commercial/opportunities returns pipeline records', async () => {
    const res = await request(app)
      .get('/api/commercial/opportunities')
      .set('Authorization', `Bearer ${authToken}`);

    expect(res.statusCode).toBe(200);
    expect(res.body.success).toBe(true);
    expect(Array.isArray(res.body.data)).toBe(true);
    expect(res.body.data.some((item) => item.id === opportunityId)).toBe(true);
  });

  it('GET /api/commercial/summary returns aggregated commercial metrics', async () => {
    const res = await request(app)
      .get('/api/commercial/summary')
      .set('Authorization', `Bearer ${authToken}`);

    expect(res.statusCode).toBe(200);
    expect(Number(res.body.data.total_visits)).toBeGreaterThanOrEqual(1);
    expect(Number(res.body.data.completed_visits)).toBeGreaterThanOrEqual(1);
    expect(Number(res.body.data.total_expenses)).toBeGreaterThanOrEqual(85000);
    expect(Number(res.body.data.total_opportunities)).toBeGreaterThanOrEqual(1);
    expect(Number(res.body.data.pipeline_value)).toBeGreaterThanOrEqual(42000000);
  });

  it('GET /api/commercial/board returns basic dashboard data', async () => {
    const res = await request(app)
      .get('/api/commercial/board')
      .set('Authorization', `Bearer ${authToken}`);

    expect(res.statusCode).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toHaveProperty('alerts');
    expect(Array.isArray(res.body.data.top_clients)).toBe(true);
    expect(Array.isArray(res.body.data.upcoming_actions)).toBe(true);
    expect(Array.isArray(res.body.data.opportunity_stage_summary)).toBe(true);
    expect(Array.isArray(res.body.data.urgent_opportunities)).toBe(true);
  });

  it('PUT /api/commercial/opportunities/:id updates stage and probability', async () => {
    const res = await request(app)
      .put(`/api/commercial/opportunities/${opportunityId}`)
      .set('Authorization', `Bearer ${authToken}`)
      .send({
        stage: 'negotiation',
        probability: 82,
        next_step: 'Cierre con comité de compras y firma de propuesta.',
        expected_close_date: '2026-05-03',
      });

    expect(res.statusCode).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.stage).toBe('negotiation');
    expect(Number(res.body.data.probability)).toBe(82);
    expect(res.body.data.expected_close_date).toBe('2026-05-03');
  });

  it('PUT /api/commercial/visits/:id updates follow-up data', async () => {
    const res = await request(app)
      .put(`/api/commercial/visits/${visitId}`)
      .set('Authorization', `Bearer ${authToken}`)
      .send({
        form_type: 'seguimiento',
        form_payload: {
          pipeline_stage: 'propuesta enviada',
          blockers: 'esperando revisión de compras',
          conversion_probability: '70%',
        },
        status: 'follow_up',
        next_action: 'Programar segunda reunión con compras.',
        next_action_date: '2026-04-18',
      });

    expect(res.statusCode).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.status).toBe('follow_up');
    expect(res.body.data.form_payload.pipeline_stage).toBe('propuesta enviada');
    expect(res.body.data.next_action_date).toBe('2026-04-18');
  });

  afterAll(async () => {
    await closeDatabase();
  });
});