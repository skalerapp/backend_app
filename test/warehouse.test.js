const request = require('supertest');
const app = require('../src/server');
const { closeDatabase } = require('../src/config/database');

let authToken;
let projectId;
let assetId;
let validFleetAssetId;

describe('Warehouse endpoints', () => {
  beforeAll(async () => {
    const loginRes = await request(app)
      .post('/api/auth/login')
      .send({ email: 'admin@skaler.com', password: 'admin123' });

    expect(loginRes.statusCode).toBe(200);
    authToken = loginRes.body.token;

    const projectRes = await request(app)
      .post('/api/projects')
      .set('Authorization', `Bearer ${authToken}`)
      .send({
        name: `Proyecto Warehouse ${Date.now()}`,
        budget: 250000,
      });

    expect(projectRes.statusCode).toBe(201);
    projectId = projectRes.body.projectId;
  });

  it('POST /api/warehouse/assets creates a new warehouse asset manually', async () => {
    const res = await request(app)
      .post('/api/warehouse/assets')
      .set('Authorization', `Bearer ${authToken}`)
      .send({
        asset_name: 'Kit de Herramienta Nueva',
        sku_code: 'KIT-NEW-01',
        category_name: 'Herramienta',
        unit_measure: 'UND',
        brand: 'Bosch',
        model: 'ProMix',
        serial_number: 'SER-WH-001',
        current_city: 'Cali',
        current_stock: 3,
        minimum_stock: 1,
        intake_origin: 'purchase',
        notes: 'Ingreso por compra de almacén',
      });

    expect(res.statusCode).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.data.asset_name).toBe('Kit de Herramienta Nueva');
    expect(res.body.data.intake_origin).toBe('purchase');
    assetId = res.body.data.id;
  });

  it('GET /api/warehouse/assets returns the manually created asset', async () => {
    const res = await request(app)
      .get('/api/warehouse/assets')
      .set('Authorization', `Bearer ${authToken}`);

    expect(res.statusCode).toBe(200);
    expect(Array.isArray(res.body.data)).toBe(true);
    expect(res.body.data.some((item) => item.id === assetId)).toBe(true);
  });

  it('POST /api/warehouse/movements persists project return intake origin', async () => {
    const res = await request(app)
      .post('/api/warehouse/movements')
      .set('Authorization', `Bearer ${authToken}`)
      .send({
        asset_id: assetId,
        project_id: projectId,
        movement_type: 'return',
        intake_origin: 'project_return',
        intake_origin_project_id: projectId,
        movement_date: '2026-04-10',
        quantity: '1',
        delivery_signature_name: 'Supervisor Campo',
        delivery_signature_data: JSON.stringify([{ x: 12.4, y: 18.7 }, { x: 20.1, y: 24.3 }, null]),
        receiving_signature_name: 'Admin Logistica',
        receiving_signature_data: JSON.stringify([{ x: 6.1, y: 14.2 }, { x: 15.9, y: 27.5 }, null]),
        checklist_snapshot: 'Ingreso completo y revisado',
        notes: 'Retorno desde proyecto',
      });

    expect(res.statusCode).toBe(200);
    expect(res.body.success).toBe(true);
  });

  it('GET /api/warehouse/movements exposes intake origin metadata', async () => {
    const res = await request(app)
      .get(`/api/warehouse/movements?assetId=${assetId}`)
      .set('Authorization', `Bearer ${authToken}`);

    expect(res.statusCode).toBe(200);
    expect(Array.isArray(res.body.data)).toBe(true);
    expect(res.body.data.some((item) => item.intake_origin === 'project_return' && Number(item.intake_origin_project_id) === projectId)).toBe(true);
    expect(res.body.data.some((item) => item.delivery_signature_data && item.receiving_signature_data)).toBe(true);
  });

  it('rejects fleet asset creation without document due dates', async () => {
    const res = await request(app)
      .post('/api/warehouse/assets')
      .set('Authorization', `Bearer ${authToken}`)
      .send({
        asset_name: 'Camioneta de prueba sin vigencias',
        category_name: 'Vehiculo',
        vehicle_plate: 'TMP123',
        vehicle_type: 'Camioneta',
      });

    expect(res.statusCode).toBe(400);
    expect(res.body.message).toMatch(/SOAT|seguro|tecnomecánica/i);
  });

  it('creates a valid fleet asset with document due dates', async () => {
    const res = await request(app)
      .post('/api/warehouse/assets')
      .set('Authorization', `Bearer ${authToken}`)
      .send({
        asset_name: 'Camioneta Hilux Operativa',
        category_name: 'Vehiculo',
        vehicle_plate: 'SKL123',
        vehicle_type: 'Camioneta',
        soat_due_date: '2026-12-31',
        insurance_due_date: '2026-12-31',
        technical_due_date: '2026-12-31',
        current_city: 'Cali',
      });

    expect(res.statusCode).toBe(201);
    expect(res.body.success).toBe(true);
    validFleetAssetId = res.body.data.id;
  });

  it('rejects fleet movement when documentary validity is expired', async () => {
    const expiredAssetRes = await request(app)
      .post('/api/warehouse/assets')
      .set('Authorization', `Bearer ${authToken}`)
      .send({
        asset_name: 'Bugui vencido',
        category_name: 'Vehiculo',
        vehicle_plate: 'VEN123',
        vehicle_type: 'Bugui',
        soat_due_date: '2025-01-01',
        insurance_due_date: '2025-01-01',
        technical_due_date: '2025-01-01',
      });

    expect(expiredAssetRes.statusCode).toBe(201);
    const expiredAssetId = expiredAssetRes.body.data.id;

    const res = await request(app)
      .post('/api/warehouse/movements')
      .set('Authorization', `Bearer ${authToken}`)
      .send({
        asset_id: expiredAssetId,
        project_id: projectId,
        movement_type: 'transfer',
        movement_date: '2026-04-10',
        vehicle_plate_snapshot: 'VEN123',
        odometer_snapshot: '15200',
        fuel_level_snapshot: '3/4',
        checklist_snapshot: 'Listo para salida',
      });

    expect(res.statusCode).toBe(409);
    expect(res.body.message).toMatch(/vencido/i);
  });

  it('allows fleet movement when SOAT, insurance and technical review are valid', async () => {
    const res = await request(app)
      .post('/api/warehouse/movements')
      .set('Authorization', `Bearer ${authToken}`)
      .send({
        asset_id: validFleetAssetId,
        project_id: projectId,
        movement_type: 'transfer',
        movement_date: '2026-04-10',
        vehicle_plate_snapshot: 'SKL123',
        odometer_snapshot: '24200',
        fuel_level_snapshot: '1/2',
        checklist_snapshot: 'SOAT y tecnomecánica verificados',
      });

    expect(res.statusCode).toBe(200);
    expect(res.body.success).toBe(true);
  });

  afterAll(async () => {
    await closeDatabase();
  });
});