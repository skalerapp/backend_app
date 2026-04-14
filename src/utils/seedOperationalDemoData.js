require('dotenv').config();

const mysql = require('mysql2/promise');
const { ensureCurrentSchema } = require('./syncCurrentSchema');
const { closeDatabase } = require('../config/database');
const { hashPassword } = require('./auth.utils');

const dbName = process.env.DB_NAME || 'skaler_db';

const connectionConfig = {
  host: process.env.DB_HOST || 'localhost',
  port: Number(process.env.DB_PORT || 3306),
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '',
  database: dbName,
};

const today = new Date();

const toIsoDate = (date) => date.toISOString().slice(0, 10);

const addDays = (baseDate, days) => {
  const nextDate = new Date(baseDate);
  nextDate.setDate(nextDate.getDate() + days);
  return nextDate;
};

const findUserByEmail = async (connection, email) => {
  const [rows] = await connection.execute(
    'SELECT id, email, name, role FROM users WHERE LOWER(email) = LOWER(?) LIMIT 1',
    [email]
  );
  return rows[0] || null;
};

const ensureUser = async (connection, { email, password, name, role, status = 'active' }) => {
  const existingUser = await findUserByEmail(connection, email);
  const hashedPassword = await hashPassword(password);

  if (existingUser) {
    await connection.execute(
      `UPDATE users
       SET password = ?, name = ?, role = ?, status = ?, updated_at = NOW()
       WHERE id = ?`,
      [hashedPassword, name, role, status, existingUser.id]
    );
    return { ...existingUser, name, role, status };
  }

  const [result] = await connection.execute(
    `INSERT INTO users (email, password, name, role, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, NOW(), NOW())`,
    [email, hashedPassword, name, role, status]
  );

  return {
    id: result.insertId,
    email,
    name,
    role,
    status,
  };
};

const findProjectByName = async (connection, name) => {
  const [rows] = await connection.execute(
    'SELECT id, name, ot_code FROM projects WHERE name = ? LIMIT 1',
    [name]
  );
  return rows[0] || null;
};

const hasColumn = async (connection, tableName, columnName) => {
  const [rows] = await connection.query(
    `SHOW COLUMNS FROM \`${tableName}\` LIKE ${connection.escape(columnName)}`
  );
  return rows.length > 0;
};

const ensureEmployeeForUser = async (connection, user) => {
  const [rows] = await connection.execute(
    'SELECT id, user_id, employee_name FROM employees WHERE user_id = ? LIMIT 1',
    [user.id]
  );

  if (rows.length > 0) {
    return rows[0];
  }

  const [result] = await connection.execute(
    `INSERT INTO employees (
       user_id,
       employee_name,
       identification_number,
       position,
       department,
       salary,
       hire_date,
       status,
       created_at,
       updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW())`,
    [
      user.id,
      user.name,
      `DEMO-${user.id}`,
      user.role === 'commercial' ? 'Asesor Comercial' : 'Administrador',
      user.role === 'commercial' ? 'Comercial' : 'Administracion',
      null,
      toIsoDate(addDays(today, -60)),
      'active',
    ]
  );

  return {
    id: result.insertId,
    user_id: user.id,
    employee_name: user.name,
  };
};

const ensureProjectCollaborator = async (connection, { projectId, employeeId }) => {
  const [rows] = await connection.execute(
    'SELECT id FROM project_collaborators WHERE project_id = ? AND employee_id = ? LIMIT 1',
    [projectId, employeeId]
  );

  if (rows.length > 0) {
    return rows[0];
  }

  const [result] = await connection.execute(
    'INSERT INTO project_collaborators (project_id, employee_id, created_at) VALUES (?, ?, NOW())',
    [projectId, employeeId]
  );

  return { id: result.insertId };
};

const ensureOperationalAssignment = async (connection, { projectId, userId, roleScope }) => {
  const [rows] = await connection.execute(
    `SELECT id
     FROM operational_role_assignments
     WHERE project_id = ? AND user_id = ? AND role_scope = ?
     LIMIT 1`,
    [projectId, userId, roleScope]
  );

  if (rows.length > 0) {
    return rows[0];
  }

  const [result] = await connection.execute(
    `INSERT INTO operational_role_assignments (project_id, user_id, role_scope, is_active, created_at, updated_at)
     VALUES (?, ?, ?, 1, NOW(), NOW())`,
    [projectId, userId, roleScope]
  );

  return { id: result.insertId };
};

const ensureActivity = async (connection, { projectId, employeeId }) => {
  const description = 'Instalacion inicial de linea de vida y validacion de puntos de anclaje';
  const [rows] = await connection.execute(
    'SELECT id FROM activities WHERE project_id = ? AND employee_id = ? AND description = ? LIMIT 1',
    [projectId, employeeId, description]
  );

  if (rows.length > 0) {
    return rows[0];
  }

  const [result] = await connection.execute(
    `INSERT INTO activities (
       project_id,
       employee_id,
       description,
       start_time,
       end_time,
       status,
       title,
       date,
       activity_date,
       hours_worked,
       evidences,
       created_at,
       updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW())`,
    [
      projectId,
      employeeId,
      description,
      `${toIsoDate(addDays(today, -1))} 07:30:00`,
      `${toIsoDate(addDays(today, -1))} 16:45:00`,
      'completed',
      'Montaje de sistema de proteccion',
      toIsoDate(addDays(today, -1)),
      toIsoDate(addDays(today, -1)),
      9.25,
      1,
    ]
  );

  return { id: result.insertId };
};

const ensureAttendance = async (connection, { projectId, employeeId, employeeUserId }) => {
  const attendanceDate = toIsoDate(today);
  const [rows] = await connection.execute(
    'SELECT id FROM attendance WHERE employee_id = ? AND attendance_date = ? LIMIT 1',
    [employeeId, attendanceDate]
  );

  if (rows.length > 0) {
    return rows[0];
  }

  const [result] = await connection.execute(
    `INSERT INTO attendance (
       employee_id,
       user_id,
       project_id,
       check_in,
       check_out,
       location_latitude,
       location_longitude,
       photo_path,
       checkout_location_latitude,
       checkout_location_longitude,
       checkout_photo_path,
       attendance_date,
       created_at,
       updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW())`,
    [
      employeeId,
      employeeUserId,
      projectId,
      `${attendanceDate} 07:02:00`,
      `${attendanceDate} 17:11:00`,
      4.6482837,
      -74.2478943,
      'uploads/attendance/demo-check-in.jpg',
      4.6482837,
      -74.2478943,
      'uploads/attendance/demo-check-out.jpg',
      attendanceDate,
    ]
  );

  return { id: result.insertId };
};

const ensureAllowanceData = async (connection, { projectId, leaderUserId, adminUserId }) => {
  const [allowanceRows] = await connection.execute(
    'SELECT id FROM project_allowances WHERE project_id = ? LIMIT 1',
    [projectId]
  );

  let allowanceId = allowanceRows[0]?.id;
  if (!allowanceId) {
    const [result] = await connection.execute(
      `INSERT INTO project_allowances (project_id, leader_user_id, assigned_amount, created_at, updated_at)
       VALUES (?, ?, ?, NOW(), NOW())`,
      [projectId, leaderUserId, 3500000]
    );
    allowanceId = result.insertId;
  }

  const [requestRows] = await connection.execute(
    'SELECT id FROM allowance_requests WHERE project_id = ? AND activity_name = ? LIMIT 1',
    [projectId, 'Desplazamiento cuadrilla demo']
  );

  let requestId = requestRows[0]?.id;
  if (!requestId) {
    const [result] = await connection.execute(
      `INSERT INTO allowance_requests (
         project_id,
         requester_user_id,
         responsible_user_id,
         approver_user_id,
         status,
         center_cost,
         work_order,
         client_name,
         activity_name,
         city,
         personnel_count,
         departure_date,
         return_date,
         outbound_route,
         return_route,
         transport_type,
         vehicle_required,
         vehicle_brand,
         vehicle_model,
         vehicle_plate,
         budget_transport,
         budget_local_transport,
         budget_lodging,
         budget_meals,
         budget_tolls,
         budget_fuel,
         budget_other,
         other_budget_label,
         total_requested,
         notes,
         decision_notes,
         decided_at,
         applied_to_allowance_at,
         created_at,
         updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW(), NOW(), NOW())`,
      [
        projectId,
        leaderUserId,
        adminUserId,
        adminUserId,
        'approved',
        'CC-DEMO-001',
        'OT-DEMO-REC',
        'Cliente Demo Skaler',
        'Desplazamiento cuadrilla demo',
        'Bogota',
        3,
        toIsoDate(addDays(today, 2)),
        toIsoDate(addDays(today, 4)),
        'Bogota - Tocancipa',
        'Tocancipa - Bogota',
        'camioneta',
        1,
        'Toyota',
        'Hilux',
        'SKL001',
        420000,
        180000,
        350000,
        240000,
        85000,
        160000,
        0,
        null,
        1435000,
        'Solicitud demo aprobada para validar panel de viaticos.',
        'Aprobada como muestra para pruebas de recuperacion.',
      ]
    );
    requestId = result.insertId;
  }

  const [expenseRows] = await connection.execute(
    'SELECT id FROM allowance_expenses WHERE allowance_id = ? AND allowance_request_id = ? LIMIT 1',
    [allowanceId, requestId]
  );

  if (!expenseRows.length) {
    await connection.execute(
      `INSERT INTO allowance_expenses (
         allowance_id,
         allowance_request_id,
         amount,
         expense_date,
         notes,
         evidence_path,
         created_by,
         created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, NOW())`,
      [
        allowanceId,
        requestId,
        385000,
        toIsoDate(addDays(today, -1)),
        'Consumo inicial demo de viaticos para desplazamiento.',
        'uploads/allowances/demo-expense-001.jpg',
        leaderUserId,
      ]
    );
  }

  return { allowanceId, requestId };
};

const ensureMaterialData = async (connection, { projectId, adminUserId }) => {
  const materialName = 'Linea de vida vertical 30m';
  await connection.execute(
    `INSERT INTO project_material_items (
       project_id,
       material_name,
       unit,
       assigned_quantity,
       unit_cost,
       created_at,
       updated_at
     ) VALUES (?, ?, ?, ?, ?, NOW(), NOW())
     ON DUPLICATE KEY UPDATE
       unit = VALUES(unit),
       assigned_quantity = VALUES(assigned_quantity),
       unit_cost = VALUES(unit_cost),
       updated_at = NOW()`,
    [projectId, materialName, 'rollo', 12, 480000]
  );

  const [rows] = await connection.execute(
    'SELECT id FROM project_material_items WHERE project_id = ? AND material_name = ? LIMIT 1',
    [projectId, materialName]
  );
  const materialItemId = rows[0].id;

  const [consumptionRows] = await connection.execute(
    'SELECT id FROM material_consumptions WHERE material_item_id = ? LIMIT 1',
    [materialItemId]
  );

  if (!consumptionRows.length) {
    await connection.execute(
      `INSERT INTO material_consumptions (
         material_item_id,
         consumed_quantity,
         consumption_date,
         notes,
         evidence_path,
         created_by,
         created_at
       ) VALUES (?, ?, ?, ?, ?, ?, NOW())`,
      [
        materialItemId,
        3,
        toIsoDate(addDays(today, -1)),
        'Consumo demo para montaje inicial en proyecto recuperado.',
        'uploads/materials/demo-consumption-001.jpg',
        adminUserId,
      ]
    );
  }

  return { materialItemId };
};

const ensureLaborPermission = async (connection, { employeeId }) => {
  const [rows] = await connection.execute(
    `SELECT id
     FROM labor_permissions
     WHERE employee_id = ? AND permission_type = ? AND start_date = ?
     LIMIT 1`,
    [employeeId, 'cita_medica', toIsoDate(addDays(today, 1))]
  );

  if (rows.length > 0) {
    return rows[0];
  }

  const [result] = await connection.execute(
    `INSERT INTO labor_permissions (
       employee_id,
       permission_type,
       start_date,
       end_date,
       reason,
       status,
       created_at,
       updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, NOW(), NOW())`,
    [
      employeeId,
      'cita_medica',
      toIsoDate(addDays(today, 1)),
      toIsoDate(addDays(today, 1)),
      'Permiso demo para validar consulta de permisos laborales.',
      'approved',
    ]
  );

  return { id: result.insertId };
};

const ensureEvidence = async (connection, { activityId, projectId, uploadedBy }) => {
  const [rows] = await connection.execute(
    `SELECT id
     FROM evidence
     WHERE activity_id = ? AND module_type = ? AND file_name = ?
     LIMIT 1`,
    [activityId, 'activities', 'demo-activity-evidence.jpg']
  );

  if (rows.length > 0) {
    return rows[0];
  }

  const [result] = await connection.execute(
    `INSERT INTO evidence (
       activity_id,
       project_id,
       module_type,
       file_path,
       file_name,
       file_size,
       uploaded_by,
       created_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, NOW())`,
    [
      activityId,
      projectId,
      'activities',
      'uploads/activities/demo-activity-evidence.jpg',
      'demo-activity-evidence.jpg',
      245120,
      uploadedBy,
    ]
  );

  return { id: result.insertId };
};

const ensureProject = async (connection, { adminUserId }) => {
  const projectName = 'Proyecto Demo Recuperacion Skaler';
  const existingProject = await findProjectByName(connection, projectName);
  if (existingProject) {
    return existingProject;
  }

  const [result] = await connection.execute(
    `INSERT INTO projects (
       name,
       description,
       budget,
       start_date,
       end_date,
       actual_end_date,
       manager_id,
       status,
       created_at,
       updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW())`,
    [
      projectName,
      'Proyecto de referencia para validar recuperacion de base, paneles y flujos operativos.',
      18500000,
      toIsoDate(addDays(today, -20)),
      toIsoDate(addDays(today, 45)),
      null,
      adminUserId,
      'active',
    ]
  );

  const projectId = result.insertId;
  await connection.execute('UPDATE projects SET ot_code = ? WHERE id = ?', [`OT${projectId}`, projectId]);

  return {
    id: projectId,
    name: projectName,
    ot_code: `OT${projectId}`,
  };
};

const ensureWarehouseAsset = async (connection) => {
  const assetCode = 'DEMO-WA-001';
  const [rows] = await connection.execute(
    'SELECT id, asset_code FROM warehouse_assets WHERE asset_code = ? LIMIT 1',
    [assetCode]
  );

  if (rows.length > 0) {
    return rows[0];
  }

  const [result] = await connection.execute(
    `INSERT INTO warehouse_assets (
       asset_code,
       sku_code,
       legacy_item_code,
       asset_name,
       category_name,
       unit_measure,
       brand,
       serial_number,
       model,
       certification_note,
       event_date,
       work_order,
       client_name,
       dispatch_note,
       asset_status,
       lifecycle_status,
       audit_date,
       current_city,
       minimum_stock,
       current_stock,
       vehicle_plate,
       vehicle_type,
       insurance_due_date,
       soat_due_date,
       technical_due_date,
       technical_detail,
       intake_origin,
       intake_origin_project_id,
       notes,
       created_at,
       updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW())`,
    [
      assetCode,
      'SKU-DEMO-001',
      'LEG-DEMO-001',
      'Linea de vida horizontal 20m',
      'Proteccion contra caidas',
      'unidad',
      'Skaler Safety',
      'SV-LL-2026-001',
      'Lifeline Pro',
      'Activo certificado para demostracion operativa',
      toIsoDate(addDays(today, -30)),
      'OT-DEMO-REC',
      'Cliente Demo Skaler',
      'DESP-DEMO-001',
      'Bueno',
      'available',
      toIsoDate(addDays(today, -2)),
      'Bogota',
      4,
      18,
      null,
      null,
      null,
      null,
      null,
      null,
      'purchase',
      null,
      'Stock inicial para validar tablero de almacen despues de la recuperacion.',
    ]
  );

  return { id: result.insertId, asset_code: assetCode };
};

const ensureWarehouseMovement = async (connection, { assetId, projectId, adminUserId }) => {
  const [rows] = await connection.execute(
    `SELECT id
     FROM warehouse_asset_movements
     WHERE asset_id = ? AND project_id = ? AND movement_type = ? AND work_order = ?
     LIMIT 1`,
    [assetId, projectId, 'entry', 'OT-DEMO-REC']
  );

  if (rows.length > 0) {
    return rows[0];
  }

  const [result] = await connection.execute(
    `INSERT INTO warehouse_asset_movements (
       asset_id,
       project_id,
       movement_type,
       movement_date,
       work_order,
       client_name,
       dispatch_note,
       evidence_path,
       quantity,
       serial_snapshot,
       delivery_signature_name,
       delivery_signature_data,
       receiving_signature_name,
       receiving_signature_data,
       vehicle_plate_snapshot,
       odometer_snapshot,
       fuel_level_snapshot,
       checklist_snapshot,
       intake_origin,
       intake_origin_project_id,
       status_snapshot,
       city_snapshot,
       responsible_user_id,
       receiver_user_id,
       notes,
       created_at,
       updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW())`,
    [
      assetId,
      projectId,
      'entry',
      toIsoDate(addDays(today, -3)),
      'OT-DEMO-REC',
      'Cliente Demo Skaler',
      'DESP-DEMO-001',
      null,
      6,
      'SV-LL-2026-001',
      'Admin Skaler',
      null,
      'Bodega Principal',
      null,
      null,
      null,
      null,
      null,
      'purchase',
      null,
      'Disponible',
      'Bogota',
      adminUserId,
      adminUserId,
      'Ingreso de demostracion para verificar movimientos post-recuperacion.',
    ]
  );

  return { id: result.insertId };
};

const ensureCommercialVisit = async (connection, { projectId, commercialUserId, commercialEmployeeId }) => {
  const visitDate = toIsoDate(addDays(today, -5));
  const [rows] = await connection.execute(
    `SELECT id
     FROM commercial_visits
     WHERE client_name = ? AND visit_date = ? AND summary = ?
     LIMIT 1`,
    ['Constructora Andina', visitDate, 'Levantamiento inicial de necesidad para trabajo seguro en alturas']
  );

  if (rows.length > 0) {
    return rows[0];
  }

  const columns = [];
  const values = [];
  const params = [];

  if (await hasColumn(connection, 'commercial_visits', 'employee_id')) {
    columns.push('employee_id');
    values.push('?');
    params.push(commercialEmployeeId);
  }

  columns.push(
    'client_name',
    'client_contact',
    'visit_date',
    'latitude',
    'longitude',
    'form_type',
    'form_payload',
    'summary',
    'outcome',
    'next_action',
    'next_action_date',
    'evidence_path',
    'expense_amount',
    'status',
    'project_id',
    'created_by',
    'created_at',
    'updated_at'
  );
  values.push('?', '?', '?', '?', '?', '?', '?', '?', '?', '?', '?', '?', '?', '?', '?', '?', 'NOW()', 'NOW()');
  params.push(
    'Constructora Andina',
    'Laura Gomez - compras@constructoraandina.com',
    visitDate,
    4.6482837,
    -74.2478943,
    'diagnostico_operativo',
    JSON.stringify({ necesidad: 'lineas de vida y capacitacion', sede: 'Planta Norte' }),
    'Levantamiento inicial de necesidad para trabajo seguro en alturas',
    'Cliente solicita propuesta tecnica y economica.',
    'Enviar propuesta comercial y agendar visita tecnica',
    toIsoDate(addDays(today, 3)),
    'uploads/commercial/demo-visit-001.jpg',
    85000,
    'follow_up',
    projectId,
    commercialUserId,
  );

  const [result] = await connection.execute(
    `INSERT INTO commercial_visits (${columns.join(', ')}) VALUES (${values.join(', ')})`,
    params
  );

  return { id: result.insertId };
};

const ensureCommercialOpportunities = async (connection, { projectId, commercialUserId, sourceVisitId }) => {
  const demoOpportunities = [
    {
      clientName: 'Constructora Andina',
      contactName: 'Laura Gomez',
      opportunityName: 'Propuesta integral Planta Norte',
      stage: 'proposal',
      estimatedValue: 128000000,
      probability: 60,
      expectedCloseDate: toIsoDate(addDays(today, 18)),
      lastActivityDate: toIsoDate(addDays(today, -2)),
      nextStep: 'Presentar propuesta economica y alcance tecnico',
      notes: 'Oportunidad principal ligada a la visita recuperada.',
      sourceVisitId,
    },
    {
      clientName: 'Logistica Central SAS',
      contactName: 'Andres Ruiz',
      opportunityName: 'Renovacion anual HSE y trabajo en alturas',
      stage: 'negotiation',
      estimatedValue: 76000000,
      probability: 80,
      expectedCloseDate: toIsoDate(addDays(today, 7)),
      lastActivityDate: toIsoDate(addDays(today, -1)),
      nextStep: 'Cerrar condiciones de servicio y cronograma de ejecucion',
      notes: 'Oportunidad sembrada para poblar tablero comercial.',
      sourceVisitId: null,
    },
  ];

  let created = 0;
  for (const item of demoOpportunities) {
    const [rows] = await connection.execute(
      'SELECT id FROM commercial_opportunities WHERE opportunity_name = ? LIMIT 1',
      [item.opportunityName]
    );

    if (rows.length > 0) {
      continue;
    }

    await connection.execute(
      `INSERT INTO commercial_opportunities (
         client_name,
         contact_name,
         opportunity_name,
         stage,
         estimated_value,
         probability,
         expected_close_date,
         last_activity_date,
         next_step,
         notes,
         project_id,
         source_visit_id,
         owner_user_id,
         created_by,
         created_at,
         updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW())`,
      [
        item.clientName,
        item.contactName,
        item.opportunityName,
        item.stage,
        item.estimatedValue,
        item.probability,
        item.expectedCloseDate,
        item.lastActivityDate,
        item.nextStep,
        item.notes,
        projectId,
        item.sourceVisitId,
        commercialUserId,
        commercialUserId,
      ]
    );
    created += 1;
  }

  return created;
};

const run = async () => {
  let connection;

  try {
    connection = await mysql.createConnection(connectionConfig);
    await ensureCurrentSchema({ connection });

    const adminUser = await findUserByEmail(connection, 'admin@skaler.com');
    const commercialUser = await findUserByEmail(connection, process.env.COMMERCIAL_USER_EMAIL || 'commercial@skaler.com');
    const leaderUser = await ensureUser(connection, {
      email: 'leader@skaler.com',
      password: 'leader123',
      name: 'Lider Operativo Demo',
      role: 'leader',
    });
    const employeeUser = await ensureUser(connection, {
      email: 'employee@skaler.com',
      password: 'employee123',
      name: 'Colaborador Demo',
      role: 'employee',
    });

    if (!adminUser) {
      throw new Error('No existe el usuario admin base. Ejecuta primero db:rebuild:local.');
    }
    if (!commercialUser) {
      throw new Error('No existe el usuario comercial base. Ejecuta primero db:rebuild:local.');
    }

    const commercialEmployee = await ensureEmployeeForUser(connection, commercialUser);
    const leaderEmployee = await ensureEmployeeForUser(connection, leaderUser);
    const employee = await ensureEmployeeForUser(connection, employeeUser);
    const project = await ensureProject(connection, { adminUserId: adminUser.id });
    await ensureProjectCollaborator(connection, { projectId: project.id, employeeId: employee.id });
    await ensureOperationalAssignment(connection, { projectId: project.id, userId: leaderUser.id, roleScope: 'leader' });
    const activity = await ensureActivity(connection, { projectId: project.id, employeeId: employee.id });
    await ensureAttendance(connection, { projectId: project.id, employeeId: employee.id, employeeUserId: employeeUser.id });
    await ensureAllowanceData(connection, { projectId: project.id, leaderUserId: leaderUser.id, adminUserId: adminUser.id });
    await ensureMaterialData(connection, { projectId: project.id, adminUserId: adminUser.id });
    await ensureLaborPermission(connection, { employeeId: employee.id });
    await ensureEvidence(connection, { activityId: activity.id, projectId: project.id, uploadedBy: adminUser.id });
    const asset = await ensureWarehouseAsset(connection);
    await ensureWarehouseMovement(connection, { assetId: asset.id, projectId: project.id, adminUserId: adminUser.id });
    const visit = await ensureCommercialVisit(connection, {
      projectId: project.id,
      commercialUserId: commercialUser.id,
      commercialEmployeeId: commercialEmployee.id,
    });
    const createdOpportunities = await ensureCommercialOpportunities(connection, {
      projectId: project.id,
      commercialUserId: commercialUser.id,
      sourceVisitId: visit.id,
    });

    console.log('✅ Datos demo operativos listos.');
    console.log(`Proyecto demo: ${project.name} (${project.ot_code})`);
    console.log(`Lider demo: ${leaderUser.email} / leader123`);
    console.log(`Colaborador demo: ${employeeUser.email} / employee123`);
    console.log(`Activo demo: ${asset.asset_code}`);
    console.log(`Visita comercial demo ID: ${visit.id}`);
    console.log(`Oportunidades comerciales nuevas: ${createdOpportunities}`);
  } catch (error) {
    console.error(`❌ Error sembrando datos demo: ${error.message}`);
    process.exitCode = 1;
  } finally {
    if (connection) {
      await connection.end();
    }
    await closeDatabase();
  }
};

run();