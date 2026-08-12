const request = require('supertest');
const app = require('../src/server');
const { closeDatabase } = require('../src/config/database');

let authToken;
let fleetUnitId;

describe('Fleet endpoints', () => {
  beforeAll(async () => {
    const loginRes = await request(app)
      .post('/api/auth/login')
      .send({ email: 'admin@skaler.com', password: 'admin123' });

    expect(loginRes.statusCode).toBe(200);
    authToken = loginRes.body.token;
  });

  it('POST /api/fleet/units creates a fleet unit with document alerts', async () => {
    const res = await request(app)
      .post('/api/fleet/units')
      .set('Authorization', `Bearer ${authToken}`)
      .send({
        asset_name: `Camioneta Flota ${Date.now()}`,
        vehicle_plate: `FLT${String(Date.now()).slice(-4)}`,
        vehicle_type: 'Camioneta',
        brand: 'Toyota',
        model: 'Hilux',
        current_city: 'Cali',
        soat_due_date: '2026-12-31',
        insurance_due_date: '2026-12-31',
        technical_due_date: '2026-12-31',
      });

    expect(res.statusCode).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.data.vehicle_plate).toBeTruthy();
    expect(Array.isArray(res.body.data.document_alerts)).toBe(true);
    expect(res.body.data.alert_summary).toMatchObject({ severity: 'ok' });
    fleetUnitId = res.body.data.id;
  });

  it('GET /api/fleet/units lists fleet units only', async () => {
    const res = await request(app)
      .get('/api/fleet/units')
      .set('Authorization', `Bearer ${authToken}`);

    expect(res.statusCode).toBe(200);
    expect(Array.isArray(res.body.data)).toBe(true);
    expect(res.body.data.some((item) => item.id === fleetUnitId)).toBe(true);
  });

  it('GET /api/fleet/units/:id returns detail with maintenance records', async () => {
    const res = await request(app)
      .get(`/api/fleet/units/${fleetUnitId}`)
      .set('Authorization', `Bearer ${authToken}`);

    expect(res.statusCode).toBe(200);
    expect(res.body.data.id).toBe(fleetUnitId);
    expect(Array.isArray(res.body.data.maintenance_records)).toBe(true);
  });

  it('POST /api/fleet/units/:id/maintenance creates maintenance and can refresh SOAT due date', async () => {
    const res = await request(app)
      .post(`/api/fleet/units/${fleetUnitId}/maintenance`)
      .set('Authorization', `Bearer ${authToken}`)
      .send({
        maintenance_type: 'SOAT',
        service_date: '2026-06-01',
        next_due_date: '2027-06-01',
        odometer_snapshot: '45200',
        vendor_name: 'Aseguradora prueba',
        description: 'Renovación SOAT',
      });

    expect(res.statusCode).toBe(201);
    expect(res.body.data.maintenance_type).toBe('SOAT');

    const detailRes = await request(app)
      .get(`/api/fleet/units/${fleetUnitId}`)
      .set('Authorization', `Bearer ${authToken}`);

    expect(detailRes.statusCode).toBe(200);
    expect(detailRes.body.data.soat_due_date).toContain('2027-06-01');
    expect(detailRes.body.data.maintenance_records.length).toBeGreaterThan(0);
  });

  it('GET /api/fleet/alerts exposes units with expiring or expired documents', async () => {
    const expiringRes = await request(app)
      .post('/api/fleet/units')
      .set('Authorization', `Bearer ${authToken}`)
      .send({
        asset_name: 'Vehículo por vencer',
        vehicle_plate: `EXP${String(Date.now()).slice(-4)}`,
        vehicle_type: 'Furgón',
        soat_due_date: '2026-06-20',
        insurance_due_date: '2026-12-31',
        technical_due_date: '2026-12-31',
      });

    expect(expiringRes.statusCode).toBe(201);

    const res = await request(app)
      .get('/api/fleet/alerts')
      .set('Authorization', `Bearer ${authToken}`);

    expect(res.statusCode).toBe(200);
    expect(Array.isArray(res.body.data)).toBe(true);
    expect(res.body.data.some((item) => item.alert_summary?.hasIssues)).toBe(true);
  });

  afterAll(async () => {
    await closeDatabase();
  });
});
