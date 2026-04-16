const db = require('../../config/database');
const pool = db.pool;
const { applyAuditContext } = require('../../utils/auditContext');
const { normalizeRole } = require('../../middleware/auth.middleware');
const {
  ensureOperationalScopeShape,
  canAccessProjectByOperationalScope,
} = require('../operationalScopes/operationalScopes.service');

const isFinalProjectStatus = (statusValue) => {
  const normalized = (statusValue || '').toString().trim().toLowerCase();
  return normalized === 'completed' || normalized === 'cancelled' || normalized === 'closed';
};

const normalizeNullableText = (value, maxLength = 255) => {
  const normalized = (value || '').toString().trim();
  if (!normalized) {
    return null;
  }

  return normalized.slice(0, maxLength);
};

const normalizeInteger = (value) => {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : null;
};

const normalizeDecimal = (value) => {
  const parsed = Number(value || 0);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
};

const computeAllowanceRequestTotal = (payload) => {
  return [
    payload.budget_transport,
    payload.budget_local_transport,
    payload.budget_lodging,
    payload.budget_meals,
    payload.budget_tolls,
    payload.budget_fuel,
    payload.budget_other,
  ].reduce((sum, item) => sum + normalizeDecimal(item), 0);
};

const canCreateAllowanceRequest = (normalizedRole) => {
  return normalizedRole === 'super_admin'
    || normalizedRole === 'leader'
    || normalizedRole === 'supervisor'
    || normalizedRole === 'coordinator_operations'
    || normalizedRole === 'commercial';
};

const normalizeAllowanceRequestStatus = (value) => {
  const normalized = (value || '').toString().trim().toLowerCase();
  if (normalized === 'approved' || normalized === 'rejected' || normalized === 'submitted' || normalized === 'draft') {
    return normalized;
  }

  return 'submitted';
};

const allowanceRequestSelect = `
  SELECT
    ar.id,
    ar.project_id,
    p.name AS project_name,
    p.status AS project_status,
    ar.requester_user_id,
    requester.name AS requester_name,
    ar.responsible_user_id,
    responsible.name AS responsible_name,
    ar.approver_user_id,
    approver.name AS approver_name,
    ar.status,
    ar.center_cost,
    ar.work_order,
    ar.client_name,
    ar.activity_name,
    ar.city,
    ar.personnel_count,
    ar.departure_date,
    ar.return_date,
    ar.outbound_route,
    ar.return_route,
    ar.transport_type,
    ar.vehicle_required,
    ar.vehicle_brand,
    ar.vehicle_model,
    ar.vehicle_plate,
    ar.budget_transport,
    ar.budget_local_transport,
    ar.budget_lodging,
    ar.budget_meals,
    ar.budget_tolls,
    ar.budget_fuel,
    ar.budget_other,
    ar.other_budget_label,
    ar.total_requested,
    ar.notes,
    ar.decision_notes,
    ar.decided_at,
    ar.applied_to_allowance_at,
    ar.created_at,
    ar.updated_at
  FROM allowance_requests ar
  INNER JOIN projects p ON p.id = ar.project_id
  LEFT JOIN users requester ON requester.id = ar.requester_user_id
  LEFT JOIN users responsible ON responsible.id = ar.responsible_user_id
  LEFT JOIN users approver ON approver.id = ar.approver_user_id
`;

const getAllowanceRequestById = async (connection, requestId) => {
  const [rows] = await connection.execute(
    `${allowanceRequestSelect} WHERE ar.id = ? LIMIT 1`,
    [requestId]
  );

  return rows[0] || null;
};

const getAllowanceSummaryByProject = async (connection, projectId) => {
  const [rows] = await connection.execute(
    `SELECT
       pa.id,
       pa.project_id,
       p.name AS project_name,
       p.status AS project_status,
       pa.leader_user_id,
       u.name AS leader_name,
       pa.assigned_amount,
       COALESCE(SUM(ae.amount), 0) AS spent_amount,
       (pa.assigned_amount - COALESCE(SUM(ae.amount), 0)) AS remaining_amount,
       pa.updated_at
     FROM project_allowances pa
     INNER JOIN projects p ON p.id = pa.project_id
     LEFT JOIN users u ON u.id = pa.leader_user_id
     LEFT JOIN allowance_expenses ae ON ae.allowance_id = pa.id
     WHERE pa.project_id = ?
     GROUP BY pa.id
     LIMIT 1`,
    [projectId]
  );

  return rows[0] || null;
};

const listApprovedRequestBuckets = async (connection, projectId) => {
  const [rows] = await connection.execute(
    `SELECT
       ar.id,
       ar.project_id,
       ar.requester_user_id,
       requester.name AS requester_name,
       ar.responsible_user_id,
       responsible.name AS responsible_name,
       ar.approver_user_id,
       approver.name AS approver_name,
       ar.status,
       ar.city,
       ar.departure_date,
       ar.return_date,
       ar.total_requested AS approved_amount,
       COALESCE(SUM(ae.amount), 0) AS spent_amount,
       (ar.total_requested - COALESCE(SUM(ae.amount), 0)) AS remaining_amount,
       ar.decided_at,
       ar.applied_to_allowance_at,
       ar.created_at,
       ar.updated_at
     FROM allowance_requests ar
     LEFT JOIN users requester ON requester.id = ar.requester_user_id
     LEFT JOIN users responsible ON responsible.id = ar.responsible_user_id
     LEFT JOIN users approver ON approver.id = ar.approver_user_id
     LEFT JOIN allowance_expenses ae ON ae.allowance_request_id = ar.id
     WHERE ar.project_id = ?
       AND ar.status = 'approved'
       AND ar.applied_to_allowance_at IS NOT NULL
     GROUP BY ar.id
     ORDER BY COALESCE(ar.decided_at, ar.updated_at, ar.created_at) DESC, ar.id DESC`,
    [projectId]
  );

  return rows;
};

const getAllowanceRequestBucket = async (connection, projectId, requestId) => {
  const [rows] = await connection.execute(
    `SELECT
       ar.id,
       ar.project_id,
       ar.status,
       ar.total_requested AS approved_amount,
       ar.applied_to_allowance_at,
       COALESCE(SUM(ae.amount), 0) AS spent_amount,
       (ar.total_requested - COALESCE(SUM(ae.amount), 0)) AS remaining_amount
     FROM allowance_requests ar
     LEFT JOIN allowance_expenses ae ON ae.allowance_request_id = ar.id
     WHERE ar.id = ?
       AND ar.project_id = ?
     GROUP BY ar.id
     LIMIT 1`,
    [requestId, projectId]
  );

  return rows[0] || null;
};

const enrichAllowanceSummary = async (connection, summaryRow) => {
  if (!summaryRow) {
    return null;
  }

  const requestBuckets = await listApprovedRequestBuckets(connection, summaryRow.project_id);
  const [legacyRows] = await connection.execute(
    `SELECT COALESCE(SUM(amount), 0) AS legacy_project_spent
     FROM allowance_expenses
     WHERE allowance_id = ?
       AND allowance_request_id IS NULL`,
    [summaryRow.id]
  );

  return {
    ...summaryRow,
    request_buckets: requestBuckets,
    legacy_project_spent: legacyRows[0]?.legacy_project_spent || 0,
  };
};

const syncProjectAllowanceFromApprovedRequest = async (connection, requestRow) => {
  const projectId = normalizeInteger(requestRow?.project_id);
  const requestedAmount = normalizeDecimal(requestRow?.total_requested);
  const requestId = normalizeInteger(requestRow?.id);

  if (!requestId || !projectId || requestedAmount <= 0) {
    return null;
  }

  if (requestRow?.applied_to_allowance_at) {
    return null;
  }

  const [projectRows] = await connection.execute(
    'SELECT id, manager_id, status FROM projects WHERE id = ? LIMIT 1',
    [projectId]
  );

  if (!projectRows.length || isFinalProjectStatus(projectRows[0].status)) {
    return null;
  }

  const preferredLeaderId =
    normalizeInteger(requestRow?.responsible_user_id) ||
    normalizeInteger(projectRows[0].manager_id) ||
    normalizeInteger(requestRow?.requester_user_id);

  const [existingRows] = await connection.execute(
    'SELECT id, leader_user_id, assigned_amount FROM project_allowances WHERE project_id = ? LIMIT 1',
    [projectId]
  );

  if (!existingRows.length) {
    await connection.execute(
      `INSERT INTO project_allowances (project_id, leader_user_id, assigned_amount, created_at, updated_at)
       VALUES (?, ?, ?, NOW(), NOW())`,
      [projectId, preferredLeaderId, requestedAmount]
    );

    await connection.execute(
      'UPDATE allowance_requests SET applied_to_allowance_at = NOW(), updated_at = NOW() WHERE id = ?',
      [requestId]
    );

    return null;
  }

  const existing = existingRows[0];
  const normalizedAssigned = normalizeDecimal(existing.assigned_amount);
  const nextAssignedAmount = normalizedAssigned + requestedAmount;
  const nextLeaderId = normalizeInteger(existing.leader_user_id) || preferredLeaderId;

  await connection.execute(
    `UPDATE project_allowances
     SET leader_user_id = ?,
         assigned_amount = ?,
         updated_at = NOW()
     WHERE id = ?`,
    [nextLeaderId, nextAssignedAmount, existing.id]
  );

  await connection.execute(
    'UPDATE allowance_requests SET applied_to_allowance_at = NOW(), updated_at = NOW() WHERE id = ?',
    [requestId]
  );

  return existing.id;
};

const ensureAllowancesShape = async (connection) => {
  await connection.execute(`
    CREATE TABLE IF NOT EXISTS project_allowances (
      id INT AUTO_INCREMENT PRIMARY KEY,
      project_id INT NOT NULL,
      leader_user_id INT NULL,
      assigned_amount DECIMAL(14,2) NOT NULL DEFAULT 0,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      UNIQUE KEY uk_project (project_id),
      INDEX idx_leader (leader_user_id)
    )
  `);

  await connection.execute(`
    CREATE TABLE IF NOT EXISTS allowance_expenses (
      id INT AUTO_INCREMENT PRIMARY KEY,
      allowance_id INT NOT NULL,
      allowance_request_id INT NULL,
      amount DECIMAL(14,2) NOT NULL,
      expense_date DATE NOT NULL,
      notes TEXT NULL,
      evidence_path VARCHAR(500) NULL,
      created_by INT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_allowance (allowance_id),
      INDEX idx_allowance_request (allowance_request_id),
      INDEX idx_expense_date (expense_date)
    )
  `);

  await connection.execute(`
    CREATE TABLE IF NOT EXISTS allowance_requests (
      id INT AUTO_INCREMENT PRIMARY KEY,
      project_id INT NOT NULL,
      requester_user_id INT NOT NULL,
      responsible_user_id INT NULL,
      status VARCHAR(40) NOT NULL DEFAULT 'submitted',
      center_cost VARCHAR(80) NULL,
      work_order VARCHAR(80) NULL,
      client_name VARCHAR(180) NULL,
      activity_name VARCHAR(180) NULL,
      city VARCHAR(120) NULL,
      personnel_count INT NOT NULL DEFAULT 1,
      departure_date DATE NOT NULL,
      return_date DATE NOT NULL,
      outbound_route VARCHAR(255) NULL,
      return_route VARCHAR(255) NULL,
      transport_type VARCHAR(40) NULL,
      vehicle_required TINYINT(1) NOT NULL DEFAULT 0,
      vehicle_brand VARCHAR(120) NULL,
      vehicle_model VARCHAR(120) NULL,
      vehicle_plate VARCHAR(32) NULL,
      budget_transport DECIMAL(14,2) NOT NULL DEFAULT 0,
      budget_local_transport DECIMAL(14,2) NOT NULL DEFAULT 0,
      budget_lodging DECIMAL(14,2) NOT NULL DEFAULT 0,
      budget_meals DECIMAL(14,2) NOT NULL DEFAULT 0,
      budget_tolls DECIMAL(14,2) NOT NULL DEFAULT 0,
      budget_fuel DECIMAL(14,2) NOT NULL DEFAULT 0,
      budget_other DECIMAL(14,2) NOT NULL DEFAULT 0,
      other_budget_label VARCHAR(120) NULL,
      total_requested DECIMAL(14,2) NOT NULL DEFAULT 0,
      notes TEXT NULL,
      approver_user_id INT NULL,
      decision_notes TEXT NULL,
      decided_at DATETIME NULL,
      applied_to_allowance_at DATETIME NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      INDEX idx_project (project_id),
      INDEX idx_requester (requester_user_id),
      INDEX idx_approver (approver_user_id),
      INDEX idx_status (status),
      INDEX idx_created_at (created_at)
    )
  `);

  try {
    await connection.execute('ALTER TABLE allowance_requests ADD COLUMN approver_user_id INT NULL');
  } catch (error) {
    // ignore if column already exists
  }

  try {
    await connection.execute('ALTER TABLE allowance_requests ADD COLUMN decision_notes TEXT NULL');
  } catch (error) {
    // ignore if column already exists
  }

  try {
    await connection.execute('ALTER TABLE allowance_requests ADD COLUMN decided_at DATETIME NULL');
  } catch (error) {
    // ignore if column already exists
  }

  try {
    await connection.execute('ALTER TABLE allowance_requests ADD COLUMN applied_to_allowance_at DATETIME NULL');
  } catch (error) {
    // ignore if column already exists
  }

  try {
    await connection.execute('ALTER TABLE allowance_expenses ADD COLUMN allowance_request_id INT NULL AFTER allowance_id');
  } catch (error) {
    // ignore if column already exists
  }

  try {
    await connection.execute('ALTER TABLE allowance_expenses ADD INDEX idx_allowance_request (allowance_request_id)');
  } catch (error) {
    // ignore if index already exists
  }

  try {
    await connection.execute('ALTER TABLE allowance_requests ADD COLUMN approver_user_id INT NULL AFTER responsible_user_id');
  } catch (error) {
    // ignore if column already exists or AFTER is not supported in current schema state
  }

  try {
    await connection.execute('ALTER TABLE allowance_requests ADD INDEX idx_approver (approver_user_id)');
  } catch (error) {
    // ignore if index already exists
  }
};

const canManageAllowanceRequestDecision = async ({ connection, requestRow, userId, normalizedRole }) => {
  if (normalizedRole === 'super_admin' || normalizedRole === 'administrative' || normalizedRole === 'gerencial') {
    return true;
  }

  return false;
};

const listAllowances = async (req, res) => {
  try {
    const connection = await pool.getConnection();
    await ensureAllowancesShape(connection);
    await ensureOperationalScopeShape(connection);

    const normalizedRole = normalizeRole(req.user?.role);
    const conditions = [];
    const params = [];

    if (normalizedRole === 'supervisor' || normalizedRole === 'leader' || normalizedRole === 'coordinator_operations') {
      conditions.push(`(
        EXISTS (
          SELECT 1
          FROM operational_role_assignments ora
          WHERE ora.project_id = p.id
            AND ora.user_id = ?
            AND ora.role_scope = ?
            AND ora.is_active = 1
        )
        OR pa.leader_user_id = ?
      )`);
      params.push(req.user.id, normalizedRole, req.user.id);
    } else if (normalizedRole === 'commercial' || normalizedRole === 'employee') {
      conditions.push('1 = 0');
    }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

    const [rows] = await connection.execute(`
      SELECT
        pa.id,
        pa.project_id,
        p.name AS project_name,
        p.status AS project_status,
        pa.leader_user_id,
        u.name AS leader_name,
        pa.assigned_amount,
        COALESCE(SUM(ae.amount), 0) AS spent_amount,
        (pa.assigned_amount - COALESCE(SUM(ae.amount), 0)) AS remaining_amount,
        pa.updated_at
      FROM project_allowances pa
      INNER JOIN projects p ON p.id = pa.project_id
      LEFT JOIN users u ON u.id = pa.leader_user_id
      LEFT JOIN allowance_expenses ae ON ae.allowance_id = pa.id
      ${where}
      GROUP BY pa.id
      ORDER BY pa.updated_at DESC
    `, params);

    connection.release();
    res.json({ success: true, data: rows });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Error al listar viáticos', error: error.message });
  }
};

const getAllowanceByProject = async (req, res) => {
  try {
    const { projectId } = req.params;
    const connection = await pool.getConnection();
    await ensureAllowancesShape(connection);
    await ensureOperationalScopeShape(connection);

    const normalizedRole = normalizeRole(req.user?.role);
    if (normalizedRole === 'supervisor' || normalizedRole === 'leader' || normalizedRole === 'coordinator_operations') {
      const hasProjectAccess = await canAccessProjectByOperationalScope({
        connection,
        userId: req.user.id,
        role: normalizedRole,
        projectId: Number(projectId),
      });

      if (!hasProjectAccess) {
        connection.release();
        return res.status(403).json({ success: false, message: 'No tienes acceso operativo a este proyecto' });
      }
    }

    if (normalizedRole === 'employee') {
      connection.release();
      return res.status(403).json({ success: false, message: 'Acceso denegado' });
    }

    const summary = await getAllowanceSummaryByProject(connection, projectId);
    if (!summary) {
      connection.release();
      return res.status(404).json({ success: false, message: 'No hay viático asignado para este proyecto' });
    }

    const data = await enrichAllowanceSummary(connection, summary);
    connection.release();
    res.json({ success: true, data });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Error al obtener viático del proyecto', error: error.message });
  }
};

const assignAllowance = async (req, res) => {
  try {
    const { project_id, leader_user_id, assigned_amount } = req.body;
    const normalizedAmount = Number(assigned_amount || 0);

    if (!project_id || Number.isNaN(normalizedAmount) || normalizedAmount < 0) {
      return res.status(400).json({ success: false, message: 'project_id y assigned_amount válidos son requeridos' });
    }

    const connection = await pool.getConnection();
    await ensureAllowancesShape(connection);

    const [projectRows] = await connection.execute('SELECT id, status FROM projects WHERE id = ? LIMIT 1', [project_id]);
    if (!projectRows.length) {
      connection.release();
      return res.status(404).json({ success: false, message: 'Proyecto no encontrado' });
    }

    if (isFinalProjectStatus(projectRows[0].status)) {
      connection.release();
      return res.status(409).json({
        success: false,
        message: 'No se puede asignar viático a un proyecto finalizado',
      });
    }

    await applyAuditContext(connection, req);
    await connection.execute(`
      INSERT INTO project_allowances (project_id, leader_user_id, assigned_amount, created_at, updated_at)
      VALUES (?, ?, ?, NOW(), NOW())
      ON DUPLICATE KEY UPDATE
        leader_user_id = VALUES(leader_user_id),
        assigned_amount = VALUES(assigned_amount),
        updated_at = NOW()
    `, [project_id, leader_user_id || null, normalizedAmount]);

    const rows = [await getAllowanceSummaryByProject(connection, project_id)];

    connection.release();
    res.json({ success: true, message: 'Viático asignado/actualizado', data: rows[0] });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Error al asignar viático', error: error.message });
  }
};

const addExpense = async (req, res) => {
  try {
    const { projectId } = req.params;
    const { amount, expense_date, notes, evidence_path, allowance_request_id } = req.body;

    const normalizedAmount = Number(amount || 0);
    const normalizedRequestId = normalizeInteger(allowance_request_id);
    if (Number.isNaN(normalizedAmount) || normalizedAmount <= 0) {
      return res.status(400).json({ success: false, message: 'amount debe ser mayor a 0' });
    }

    const connection = await pool.getConnection();
    await ensureAllowancesShape(connection);
    await ensureOperationalScopeShape(connection);

    const normalizedRole = normalizeRole(req.user?.role);
    if (normalizedRole === 'supervisor' || normalizedRole === 'leader' || normalizedRole === 'coordinator_operations') {
      const hasProjectAccess = await canAccessProjectByOperationalScope({
        connection,
        userId: req.user.id,
        role: normalizedRole,
        projectId: Number(projectId),
      });

      if (!hasProjectAccess) {
        connection.release();
        return res.status(403).json({ success: false, message: 'No tienes acceso operativo a este proyecto' });
      }
    }

    if (normalizedRole === 'employee') {
      connection.release();
      return res.status(403).json({ success: false, message: 'Acceso denegado' });
    }

    const [allowanceRows] = await connection.execute(
      'SELECT id, assigned_amount FROM project_allowances WHERE project_id = ? LIMIT 1',
      [projectId]
    );

    if (!allowanceRows.length) {
      connection.release();
      return res.status(404).json({ success: false, message: 'Primero asigna un viático al proyecto' });
    }

    const allowance = allowanceRows[0];
    const [spentRows] = await connection.execute(
      'SELECT COALESCE(SUM(amount), 0) AS spent_amount FROM allowance_expenses WHERE allowance_id = ?',
      [allowance.id]
    );

    const [approvedRequestRows] = await connection.execute(
      `SELECT COUNT(*) AS total
       FROM allowance_requests
       WHERE project_id = ?
         AND status = 'approved'
         AND applied_to_allowance_at IS NOT NULL`,
      [projectId]
    );

    if (Number(approvedRequestRows[0]?.total || 0) > 0 && !normalizedRequestId) {
      connection.release();
      return res.status(409).json({
        success: false,
        message: 'Selecciona la solicitud aprobada contra la que vas a registrar este gasto',
      });
    }

    const spent = Number(spentRows[0].spent_amount || 0);
    const remaining = Number(allowance.assigned_amount || 0) - spent;

    if (normalizedAmount > remaining) {
      connection.release();
      return res.status(409).json({
        success: false,
        message: `El gasto excede el saldo disponible (${remaining.toFixed(2)})`
      });
    }

    let requestBucket = null;
    if (normalizedRequestId) {
      requestBucket = await getAllowanceRequestBucket(connection, Number(projectId), normalizedRequestId);

      if (!requestBucket) {
        connection.release();
        return res.status(404).json({ success: false, message: 'La solicitud aprobada seleccionada no existe para este proyecto' });
      }

      if (normalizeAllowanceRequestStatus(requestBucket.status) !== 'approved' || !requestBucket.applied_to_allowance_at) {
        connection.release();
        return res.status(409).json({
          success: false,
          message: 'Solo puedes registrar gastos sobre solicitudes aprobadas y ya aplicadas al viático',
        });
      }

      const requestRemaining = Number(requestBucket.remaining_amount || 0);
      if (normalizedAmount > requestRemaining) {
        connection.release();
        return res.status(409).json({
          success: false,
          message: `El gasto excede el saldo disponible de la solicitud aprobada (${requestRemaining.toFixed(2)})`,
        });
      }
    }

    const expenseDate = (expense_date && expense_date.toString().trim())
      ? expense_date.toString().trim().slice(0, 10)
      : new Date().toISOString().slice(0, 10);

    const createdBy = req.user?.id || null;

    await applyAuditContext(connection, req);
    const [insertRes] = await connection.execute(
      `INSERT INTO allowance_expenses
       (allowance_id, allowance_request_id, amount, expense_date, notes, evidence_path, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, NOW())`,
      [allowance.id, normalizedRequestId, normalizedAmount, expenseDate, notes || null, evidence_path || null, createdBy]
    );

    const summaryRow = await getAllowanceSummaryByProject(connection, Number(projectId));
    const summary = await enrichAllowanceSummary(connection, summaryRow);

    connection.release();

    res.status(201).json({
      success: true,
      message: 'Gasto registrado y descontado del viático',
      expenseId: insertRes.insertId,
      summary
    });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Error al registrar gasto de viático', error: error.message });
  }
};

const reclassifyExpenseToRequest = async (req, res) => {
  try {
    const { projectId, expenseId } = req.params;
    const targetRequestId = normalizeInteger(req.body.allowance_request_id);

    if (!targetRequestId) {
      return res.status(400).json({
        success: false,
        message: 'Debes seleccionar la solicitud aprobada a la que deseas mover este gasto',
      });
    }

    const connection = await pool.getConnection();
    await ensureAllowancesShape(connection);
    await ensureOperationalScopeShape(connection);

    const normalizedRole = normalizeRole(req.user?.role);
    if (normalizedRole === 'supervisor' || normalizedRole === 'leader' || normalizedRole === 'coordinator_operations') {
      const hasProjectAccess = await canAccessProjectByOperationalScope({
        connection,
        userId: req.user.id,
        role: normalizedRole,
        projectId: Number(projectId),
      });

      if (!hasProjectAccess) {
        connection.release();
        return res.status(403).json({ success: false, message: 'No tienes acceso operativo a este proyecto' });
      }
    }

    if (normalizedRole === 'employee') {
      connection.release();
      return res.status(403).json({ success: false, message: 'Acceso denegado' });
    }

    const [allowanceRows] = await connection.execute(
      'SELECT id FROM project_allowances WHERE project_id = ? LIMIT 1',
      [projectId]
    );

    if (!allowanceRows.length) {
      connection.release();
      return res.status(404).json({ success: false, message: 'No hay viático asignado para este proyecto' });
    }

    const allowanceId = allowanceRows[0].id;
    const [expenseRows] = await connection.execute(
      `SELECT id, allowance_id, allowance_request_id, amount
       FROM allowance_expenses
       WHERE id = ?
         AND allowance_id = ?
       LIMIT 1`,
      [expenseId, allowanceId]
    );

    if (!expenseRows.length) {
      connection.release();
      return res.status(404).json({ success: false, message: 'Gasto de viático no encontrado para este proyecto' });
    }

    const expenseRow = expenseRows[0];
    if (normalizeInteger(expenseRow.allowance_request_id)) {
      connection.release();
      return res.status(409).json({
        success: false,
        message: 'Este gasto ya está asociado a una solicitud aprobada',
      });
    }

    const requestBucket = await getAllowanceRequestBucket(connection, Number(projectId), targetRequestId);
    if (!requestBucket) {
      connection.release();
      return res.status(404).json({ success: false, message: 'La solicitud aprobada seleccionada no existe para este proyecto' });
    }

    if (normalizeAllowanceRequestStatus(requestBucket.status) !== 'approved' || !requestBucket.applied_to_allowance_at) {
      connection.release();
      return res.status(409).json({
        success: false,
        message: 'Solo puedes reclasificar a solicitudes aprobadas y ya aplicadas al viático',
      });
    }

    if (Number(expenseRow.amount || 0) > Number(requestBucket.remaining_amount || 0)) {
      connection.release();
      return res.status(409).json({
        success: false,
        message: `El gasto excede el saldo disponible de la solicitud aprobada (${Number(requestBucket.remaining_amount || 0).toFixed(2)})`,
      });
    }

    await applyAuditContext(connection, req);
    await connection.execute(
      `UPDATE allowance_expenses
       SET allowance_request_id = ?
       WHERE id = ?`,
      [targetRequestId, expenseId]
    );

    const summaryRow = await getAllowanceSummaryByProject(connection, Number(projectId));
    const summary = await enrichAllowanceSummary(connection, summaryRow);

    connection.release();
    res.json({
      success: true,
      message: 'Gasto reclasificado a la solicitud aprobada',
      summary,
    });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Error al reclasificar gasto de viático', error: error.message });
  }
};

const listExpensesByProject = async (req, res) => {
  try {
    const { projectId } = req.params;
    const connection = await pool.getConnection();
    await ensureAllowancesShape(connection);
    await ensureOperationalScopeShape(connection);

    const normalizedRole = normalizeRole(req.user?.role);
    if (normalizedRole === 'supervisor' || normalizedRole === 'leader' || normalizedRole === 'coordinator_operations') {
      const hasProjectAccess = await canAccessProjectByOperationalScope({
        connection,
        userId: req.user.id,
        role: normalizedRole,
        projectId: Number(projectId),
      });

      if (!hasProjectAccess) {
        connection.release();
        return res.status(403).json({ success: false, message: 'No tienes acceso operativo a este proyecto' });
      }
    }

    if (normalizedRole === 'employee') {
      connection.release();
      return res.status(403).json({ success: false, message: 'Acceso denegado' });
    }

    const [allowanceRows] = await connection.execute(
      'SELECT id FROM project_allowances WHERE project_id = ? LIMIT 1',
      [projectId]
    );

    if (!allowanceRows.length) {
      connection.release();
      return res.json({ success: true, data: [] });
    }

    const [rows] = await connection.execute(
      `SELECT
         ae.*,
         ar.total_requested AS request_approved_amount,
         ar.city AS request_city,
         ar.departure_date AS request_departure_date,
         ar.return_date AS request_return_date,
         requester.name AS request_requester_name,
         responsible.name AS request_responsible_name
       FROM allowance_expenses ae
       LEFT JOIN allowance_requests ar ON ar.id = ae.allowance_request_id
       LEFT JOIN users requester ON requester.id = ar.requester_user_id
       LEFT JOIN users responsible ON responsible.id = ar.responsible_user_id
       WHERE ae.allowance_id = ?
       ORDER BY ae.created_at DESC`,
      [allowanceRows[0].id]
    );

    connection.release();
    res.json({ success: true, data: rows });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Error al listar gastos de viático', error: error.message });
  }
};

const listAllowanceRequests = async (req, res) => {
  try {
    const connection = await pool.getConnection();
    await ensureAllowancesShape(connection);
    await ensureOperationalScopeShape(connection);

    const normalizedRole = normalizeRole(req.user?.role);
    const conditions = [];
    const params = [];

    if (normalizedRole === 'supervisor' || normalizedRole === 'leader' || normalizedRole === 'coordinator_operations') {
      conditions.push(`(
        EXISTS (
          SELECT 1
          FROM operational_role_assignments ora
          WHERE ora.project_id = ar.project_id
            AND ora.user_id = ?
            AND ora.role_scope = ?
            AND ora.is_active = 1
        )
        OR ar.requester_user_id = ?
        OR ar.responsible_user_id = ?
      )`);
      params.push(req.user.id, normalizedRole, req.user.id, req.user.id);
    } else if (normalizedRole === 'commercial' || normalizedRole === 'employee') {
      conditions.push('(ar.requester_user_id = ? OR ar.responsible_user_id = ?)');
      params.push(req.user.id, req.user.id);
    }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const [rows] = await connection.execute(
      `${allowanceRequestSelect} ${where} ORDER BY ar.created_at DESC LIMIT 80`,
      params
    );

    connection.release();
    res.json({ success: true, data: rows });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Error al listar solicitudes de viáticos', error: error.message });
  }
};

const createAllowanceRequest = async (req, res) => {
  try {
    const normalizedRole = normalizeRole(req.user?.role);
    if (!canCreateAllowanceRequest(normalizedRole)) {
      return res.status(403).json({
        success: false,
        message: 'Solo líder, supervisor, coordinación operativa o comercial pueden radicar solicitudes de viáticos',
      });
    }

    const payload = {
      project_id: normalizeInteger(req.body.project_id),
      responsible_user_id: normalizeInteger(req.body.responsible_user_id),
      center_cost: normalizeNullableText(req.body.center_cost, 80),
      work_order: normalizeNullableText(req.body.work_order, 80),
      client_name: normalizeNullableText(req.body.client_name, 180),
      activity_name: normalizeNullableText(req.body.activity_name, 180),
      city: normalizeNullableText(req.body.city, 120),
      personnel_count: Math.max(normalizeInteger(req.body.personnel_count) || 1, 1),
      departure_date: normalizeNullableText(req.body.departure_date, 10),
      return_date: normalizeNullableText(req.body.return_date, 10),
      outbound_route: normalizeNullableText(req.body.outbound_route, 255),
      return_route: normalizeNullableText(req.body.return_route, 255),
      transport_type: normalizeNullableText(req.body.transport_type, 40),
      vehicle_required: req.body.vehicle_required ? 1 : 0,
      vehicle_brand: normalizeNullableText(req.body.vehicle_brand, 120),
      vehicle_model: normalizeNullableText(req.body.vehicle_model, 120),
      vehicle_plate: normalizeNullableText(req.body.vehicle_plate, 32),
      budget_transport: normalizeDecimal(req.body.budget_transport),
      budget_local_transport: normalizeDecimal(req.body.budget_local_transport),
      budget_lodging: normalizeDecimal(req.body.budget_lodging),
      budget_meals: normalizeDecimal(req.body.budget_meals),
      budget_tolls: normalizeDecimal(req.body.budget_tolls),
      budget_fuel: normalizeDecimal(req.body.budget_fuel),
      budget_other: normalizeDecimal(req.body.budget_other),
      other_budget_label: normalizeNullableText(req.body.other_budget_label, 120),
      notes: normalizeNullableText(req.body.notes, 5000),
      status: 'submitted',
    };

    if (!payload.project_id || !payload.departure_date || !payload.return_date) {
      return res.status(400).json({
        success: false,
        message: 'Proyecto, fecha de salida y fecha de regreso son obligatorios',
      });
    }

    const departureDate = new Date(payload.departure_date);
    const returnDate = new Date(payload.return_date);
    if (Number.isNaN(departureDate.getTime()) || Number.isNaN(returnDate.getTime()) || returnDate < departureDate) {
      return res.status(400).json({
        success: false,
        message: 'Las fechas del desplazamiento no son válidas',
      });
    }

    payload.total_requested = computeAllowanceRequestTotal(payload);
    if (payload.total_requested <= 0) {
      return res.status(400).json({
        success: false,
        message: 'Debes registrar al menos un rubro mayor a 0 para crear la solicitud',
      });
    }

    const connection = await pool.getConnection();
    await ensureAllowancesShape(connection);
    await ensureOperationalScopeShape(connection);

    const [projectRows] = await connection.execute('SELECT id, name, status FROM projects WHERE id = ? LIMIT 1', [payload.project_id]);
    if (!projectRows.length) {
      connection.release();
      return res.status(404).json({ success: false, message: 'Proyecto no encontrado' });
    }

    if (isFinalProjectStatus(projectRows[0].status)) {
      connection.release();
      return res.status(409).json({
        success: false,
        message: 'No se puede crear una solicitud sobre un proyecto finalizado',
      });
    }

    if (normalizedRole === 'supervisor' || normalizedRole === 'leader' || normalizedRole === 'coordinator_operations') {
      const hasProjectAccess = await canAccessProjectByOperationalScope({
        connection,
        userId: req.user.id,
        role: normalizedRole,
        projectId: Number(payload.project_id),
      });

      if (!hasProjectAccess) {
        connection.release();
        return res.status(403).json({ success: false, message: 'No tienes acceso operativo a este proyecto' });
      }
    }

    await applyAuditContext(connection, req);
    const [result] = await connection.execute(
      `INSERT INTO allowance_requests (
        project_id,
        requester_user_id,
        responsible_user_id,
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
        created_at,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW())`,
      [
        payload.project_id,
        req.user.id,
        payload.responsible_user_id,
        payload.status,
        payload.center_cost,
        payload.work_order,
        payload.client_name,
        payload.activity_name,
        payload.city,
        payload.personnel_count,
        payload.departure_date,
        payload.return_date,
        payload.outbound_route,
        payload.return_route,
        payload.transport_type,
        payload.vehicle_required,
        payload.vehicle_brand,
        payload.vehicle_model,
        payload.vehicle_plate,
        payload.budget_transport,
        payload.budget_local_transport,
        payload.budget_lodging,
        payload.budget_meals,
        payload.budget_tolls,
        payload.budget_fuel,
        payload.budget_other,
        payload.other_budget_label,
        payload.total_requested,
        payload.notes,
      ]
    );

    const request = await getAllowanceRequestById(connection, result.insertId);
    connection.release();
    res.status(201).json({
      success: true,
      message: 'Solicitud de viáticos creada',
      data: request,
    });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Error al crear solicitud de viáticos', error: error.message });
  }
};

const updateAllowanceRequestStatus = async (req, res) => {
  let connection;
  try {
    const requestId = normalizeInteger(req.params.requestId);
    const status = normalizeAllowanceRequestStatus(req.body.status);
    const decisionNotes = normalizeNullableText(req.body.decision_notes, 5000);

    if (!requestId) {
      return res.status(400).json({ success: false, message: 'Identificador de solicitud invalido' });
    }

    if (status !== 'approved' && status !== 'rejected') {
      return res.status(400).json({
        success: false,
        message: 'El cambio de estado solo permite aprobar o rechazar solicitudes',
      });
    }

    if (status === 'rejected' && !decisionNotes) {
      return res.status(400).json({
        success: false,
        message: 'Debes registrar una observacion para rechazar la solicitud',
      });
    }

    connection = await pool.getConnection();
    await ensureAllowancesShape(connection);
    await ensureOperationalScopeShape(connection);

    const requestRow = await getAllowanceRequestById(connection, requestId);
    if (!requestRow) {
      return res.status(404).json({ success: false, message: 'Solicitud de viaticos no encontrada' });
    }

    const normalizedRole = normalizeRole(req.user?.role);
    const canManage = await canManageAllowanceRequestDecision({
      connection,
      requestRow,
      userId: req.user.id,
      normalizedRole,
    });

    if (!canManage) {
      return res.status(403).json({ success: false, message: 'No tienes permiso para decidir esta solicitud' });
    }

    if (
      Number(requestRow.requester_user_id) === Number(req.user.id) &&
      normalizedRole !== 'super_admin' &&
      normalizedRole !== 'administrative' &&
      normalizedRole !== 'gerencial'
    ) {
      return res.status(409).json({
        success: false,
        message: 'La solicitud debe ser decidida por un responsable distinto al solicitante',
      });
    }

    const currentStatus = normalizeAllowanceRequestStatus(requestRow.status);
    if (currentStatus === 'approved' || currentStatus === 'rejected') {
      return res.status(409).json({
        success: false,
        message: 'La solicitud ya tiene una decision final registrada',
      });
    }

    await connection.beginTransaction();
    await applyAuditContext(connection, req);
    await connection.execute(
      `UPDATE allowance_requests
       SET status = ?,
           approver_user_id = ?,
           decision_notes = ?,
           decided_at = NOW(),
           updated_at = NOW()
       WHERE id = ?`,
      [status, req.user.id, decisionNotes, requestId]
    );

    if (status === 'approved') {
      await syncProjectAllowanceFromApprovedRequest(connection, requestRow);
    }

    const updatedRequest = await getAllowanceRequestById(connection, requestId);
    await connection.commit();

    res.json({
      success: true,
      message: status === 'approved' ? 'Solicitud aprobada' : 'Solicitud rechazada',
      data: updatedRequest,
    });
  } catch (error) {
    if (connection) {
      try {
        await connection.rollback();
      } catch (_) {}
    }
    res.status(500).json({ success: false, message: 'Error al actualizar estado de la solicitud', error: error.message });
  } finally {
    connection?.release();
  }
};

module.exports = {
  listAllowances,
  getAllowanceByProject,
  assignAllowance,
  addExpense,
  reclassifyExpenseToRequest,
  listExpensesByProject,
  listAllowanceRequests,
  createAllowanceRequest,
  updateAllowanceRequestStatus,
  ensureAllowancesShape,
};
