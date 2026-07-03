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

  it('POST /api/commercial/clients creates a registered commercial client', async () => {
    const res = await request(app)
      .post('/api/commercial/clients')
      .set('Authorization', `Bearer ${authToken}`)
      .send({
        client_type: 'juridica',
        nit: `900${Date.now()}`.slice(0, 12),
        business_name: 'Cliente Norte S.A.S.',
        city: 'Bogotá',
        contact_name: 'Laura Gómez',
        billing_email: 'laura@clientenorte.com',
        areas: ['compras'],
      });

    expect(res.statusCode).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.data.business_name).toBe('Cliente Norte S.A.S.');
    global.__commercialTestClientId = res.body.data.id;
  });

  it('POST /api/commercial/visits creates a georeferenced commercial visit', async () => {
    const res = await request(app)
      .post('/api/commercial/visits')
      .set('Authorization', `Bearer ${authToken}`)
      .send({
        client_id: global.__commercialTestClientId,
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

  it('POST /api/commercial/visits rejects visits without a registered client', async () => {
    const res = await request(app)
      .post('/api/commercial/visits')
      .set('Authorization', `Bearer ${authToken}`)
      .send({
        client_name: 'Cliente sin registrar',
        visit_date: '2026-04-11',
        latitude: 4.711,
        longitude: -74.0721,
        status: 'planned',
      });

    expect(res.statusCode).toBe(400);
    expect(res.body.message).toMatch(/cliente registrado/i);
  });

  it('POST /api/commercial/opportunities creates a pipeline opportunity linked to a visit', async () => {
    const res = await request(app)
      .post('/api/commercial/opportunities')
      .set('Authorization', `Bearer ${authToken}`)
      .send({
        client_id: global.__commercialTestClientId,
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

  it('POST /api/commercial/opportunities rejects opportunities without a registered client', async () => {
    const res = await request(app)
      .post('/api/commercial/opportunities')
      .set('Authorization', `Bearer ${authToken}`)
      .send({
        client_name: 'Cliente sin registrar',
        opportunity_name: 'Oportunidad inválida',
        stage: 'lead',
      });

    expect(res.statusCode).toBe(400);
    expect(res.body.message).toMatch(/cliente registrado/i);
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
    expect(res.body.data).toHaveProperty('total_quotations');
    expect(res.body.data).toHaveProperty('total_clients');
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
    expect(Array.isArray(res.body.data.project_commercial_snapshot)).toBe(true);
    expect(Array.isArray(res.body.data.geo_audit)).toBe(true);
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

  let quotationId;
  let quotationNumberA;
  it('POST /api/commercial/clients creates a commercial client', async () => {
    const res = await request(app)
      .post('/api/commercial/clients')
      .set('Authorization', `Bearer ${authToken}`)
      .send({
        client_type: 'juridica',
        nit: `900${Date.now()}`,
        business_name: 'Cliente Norte S.A.S.',
        city: 'Bogotá',
        billing_email: 'facturacion@clientenorte.com',
        contact_name: 'Laura Gómez',
        contact_phone: '3001234567',
        areas: ['compras', 'cartera', 'hse'],
      });

    expect(res.statusCode).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.data.business_name).toBe('Cliente Norte S.A.S.');
    expect(res.body.data.areas).toEqual(['compras', 'cartera', 'hse']);
  });

  it('allows the same NIT in different cities as separate client sites', async () => {
    const nit = `811${Date.now()}`;
    const basePayload = {
      client_type: 'juridica',
      nit,
      business_name: 'CELSIA COLOMBIA SA ESP',
      billing_email: 'facturacion@celsia.com',
      contact_name: 'Contacto prueba',
      contact_phone: '3001234567',
    };

    const resSalvajina = await request(app)
      .post('/api/commercial/clients')
      .set('Authorization', `Bearer ${authToken}`)
      .send({ ...basePayload, city: 'SALVAJINA' });
    const resSanMiguel = await request(app)
      .post('/api/commercial/clients')
      .set('Authorization', `Bearer ${authToken}`)
      .send({ ...basePayload, city: 'SAN MIGUEL' });

    expect(resSalvajina.statusCode).toBe(201);
    expect(resSanMiguel.statusCode).toBe(201);
    expect(resSalvajina.body.data.display_label).toContain('SALVAJINA');
    expect(resSanMiguel.body.data.display_label).toContain('SAN MIGUEL');
  });

  it('rejects duplicate NIT in the same city', async () => {
    const nit = `860${Date.now()}`;
    const payload = {
      client_type: 'juridica',
      nit,
      business_name: 'COLOMBIANA KIMBERLY COLPAPEL SAS',
      city: 'PTO TEJADA',
      billing_email: 'facturacion@kimberly.com',
      contact_name: 'Contacto prueba',
      contact_phone: '3001234567',
    };

    const first = await request(app)
      .post('/api/commercial/clients')
      .set('Authorization', `Bearer ${authToken}`)
      .send(payload);
    const duplicate = await request(app)
      .post('/api/commercial/clients')
      .set('Authorization', `Bearer ${authToken}`)
      .send(payload);

    expect(first.statusCode).toBe(201);
    expect(duplicate.statusCode).toBe(409);
  });

  let clientIdForUpdate;
  it('POST /api/commercial/clients accepts extended profile fields', async () => {
    const res = await request(app)
      .post('/api/commercial/clients')
      .set('Authorization', `Bearer ${authToken}`)
      .send({
        client_type: 'juridica',
        nit: `901${Date.now()}`,
        business_name: 'Cliente Extendido S.A.S.',
        city: 'CALI',
        rut: '123456789-0',
        billing_email: 'facturacion@extendido.com',
        contact_name: 'Ana Pérez',
        contact_phone: '3009876543',
        contact_address: 'Carrera 100 # 10-20',
        area_contacts: {
          compras: { name: 'Pedro Compras' },
          hse: { name: 'María HSE' },
        },
      });

    expect(res.statusCode).toBe(201);
    expect(res.body.data.profile_complete).toBe(true);
    expect(res.body.data.area_contacts.compras.name).toBe('Pedro Compras');
    clientIdForUpdate = res.body.data.id;
  });

  it('PUT /api/commercial/clients/:id completes a minimal client profile', async () => {
    const created = await request(app)
      .post('/api/commercial/clients')
      .set('Authorization', `Bearer ${authToken}`)
      .send({
        client_type: 'juridica',
        nit: `902${Date.now()}`,
        business_name: 'Cliente Parcial S.A.S.',
        city: 'MEDELLIN',
      });

    expect(created.statusCode).toBe(201);
    expect(created.body.data.profile_complete).toBe(false);
    expect(created.body.data.missing_fields.length).toBeGreaterThan(0);

    const updated = await request(app)
      .put(`/api/commercial/clients/${created.body.data.id}`)
      .set('Authorization', `Bearer ${authToken}`)
      .send({
        rut: '987654321-1',
        billing_email: 'facturacion@parcial.com',
        contact_name: 'Laura Gómez',
        contact_phone: '3001112233',
        area_contacts: {
          compras: { name: 'Jefe Compras' },
        },
      });

    expect(updated.statusCode).toBe(200);
    expect(updated.body.data.profile_complete).toBe(true);
    expect(updated.body.data.areas).toContain('compras');
  });

  it('PUT /api/commercial/clients/:id updates an existing client', async () => {
    const res = await request(app)
      .put(`/api/commercial/clients/${clientIdForUpdate}`)
      .set('Authorization', `Bearer ${authToken}`)
      .send({
        contact_address: 'Av. 6N # 28-30',
        area_contacts: {
          compras: { name: 'Pedro Compras' },
          cartera: { name: 'Luis Cartera' },
          hse: { name: 'María HSE' },
        },
      });

    expect(res.statusCode).toBe(200);
    expect(res.body.data.contact_address).toBe('Av. 6N # 28-30');
    expect(res.body.data.area_contacts.cartera.name).toBe('Luis Cartera');
  });

  it('GET /api/commercial/clients lets commercial users search the shared client directory', async () => {
    const uniqueSuffix = Date.now();
    const businessName = `Cliente Directorio ${uniqueSuffix}`;

    const createdByAdmin = await request(app)
      .post('/api/commercial/clients')
      .set('Authorization', `Bearer ${authToken}`)
      .send({
        client_type: 'juridica',
        nit: `902${uniqueSuffix}`,
        business_name: businessName,
        city: 'Cali',
        billing_email: 'facturacion@directorio.com',
        contact_name: 'Ana Compras',
        contact_phone: '3005551212',
      });

    expect(createdByAdmin.statusCode).toBe(201);

    const commercialEmail = `commercial.search.${uniqueSuffix}@skaler.com`;
    const createCommercialUser = await request(app)
      .post('/api/users')
      .set('Authorization', `Bearer ${authToken}`)
      .send({
        name: `Comercial Search ${uniqueSuffix}`,
        email: commercialEmail,
        password: 'Pass1234!',
        role: 'commercial',
      });

    expect(createCommercialUser.statusCode).toBe(201);

    const commercialLogin = await request(app)
      .post('/api/auth/login')
      .send({ email: commercialEmail, password: 'Pass1234!' });

    expect(commercialLogin.statusCode).toBe(200);
    expect(commercialLogin.body.token).toBeTruthy();

    const searchRes = await request(app)
      .get(`/api/commercial/clients?q=${encodeURIComponent(`Directorio ${uniqueSuffix}`)}`)
      .set('Authorization', `Bearer ${commercialLogin.body.token}`);

    expect(searchRes.statusCode).toBe(200);
    expect(searchRes.body.success).toBe(true);
    expect(
      searchRes.body.data.some((client) => client.business_name === businessName),
    ).toBe(true);
  });

  it('POST /api/commercial/quotations creates a new quotation tied to a project', async () => {
    const res = await request(app)
      .post('/api/commercial/quotations')
      .set('Authorization', `Bearer ${authToken}`)
      .send({
        project_id: projectId,
        visit_id: visitId,
        budget: 1850000,
        observations: 'Cotización inicial de prueba',
      });

    expect(res.statusCode).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.data.project_id).toBe(projectId);
    expect(res.body.data.visit_id).toBe(visitId);
    expect(res.body.data.status).toBe('cotizado');
    expect(res.body.data.quotation_number).toMatch(/^[0-9]+[A-Z]{1,4}-A$/);
    quotationId = res.body.data.id;
    quotationNumberA = res.body.data.quotation_number;
  });

  it('POST /api/commercial/quotations reuses consecutive with suffix B for same visit/project', async () => {
    const res = await request(app)
      .post('/api/commercial/quotations')
      .set('Authorization', `Bearer ${authToken}`)
      .send({
        project_id: projectId,
        visit_id: visitId,
        budget: 1900000,
        observations: 'Segunda cotización misma visita',
      });

    expect(res.statusCode).toBe(201);
    expect(res.body.data.quotation_number).toMatch(/^[0-9]+[A-Z]{1,4}-B$/);
    expect(res.body.data.quotation_number.slice(0, -2)).toBe(quotationNumberA.slice(0, -2));
  });

  it('POST /api/commercial/visits stores audit location visible to admin', async () => {
    const res = await request(app)
      .get('/api/commercial/visits')
      .set('Authorization', `Bearer ${authToken}`);

    expect(res.statusCode).toBe(200);
    const visit = res.body.data.find((item) => item.id === visitId);
    expect(visit).toBeDefined();
    expect(visit.latitude).toBeUndefined();
    expect(visit.audit_location).toBeDefined();
    expect(visit.audit_location.latitude).toBeCloseTo(4.711, 2);
  });

  it('GET /api/commercial/quotations returns the created quotation', async () => {
    const res = await request(app)
      .get('/api/commercial/quotations')
      .set('Authorization', `Bearer ${authToken}`);

    expect(res.statusCode).toBe(200);
    expect(res.body.success).toBe(true);
    expect(Array.isArray(res.body.data)).toBe(true);
    expect(res.body.data.some((item) => item.id === quotationId)).toBe(true);
  });

  it('PATCH /api/commercial/quotations/:id/approve approves quotation and creates OT', async () => {
    const otCode = `OT-TEST-${Date.now()}`;
    const res = await request(app)
      .patch(`/api/commercial/quotations/${quotationId}/approve`)
      .set('Authorization', `Bearer ${authToken}`)
      .send({
        approved_value: 1850000,
        create_ot: true,
        ot_code: otCode,
      });

    expect(res.statusCode).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.status).toBe('aprobado');
    expect(Number(res.body.data.approved_value)).toBe(1850000);
    expect(res.body.data.ot_code).toBe(otCode);
  });

  it('GET /api/commercial/quotations/:id returns quotation with OT code', async () => {
    const res = await request(app)
      .get(`/api/commercial/quotations/${quotationId}`)
      .set('Authorization', `Bearer ${authToken}`);

    expect(res.statusCode).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.id).toBe(quotationId);
    expect(res.body.data.status).toBe('aprobado');
    expect(res.body.data.ot_code).toBeDefined();
    expect(res.body.data.ot_code).toMatch(/^OT-TEST-/);
  });

  afterAll(async () => {
    await closeDatabase();
  });
});