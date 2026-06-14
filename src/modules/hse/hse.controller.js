const db = require('../../config/database');
const { withDbConnection } = db;
const { applyAuditContext } = require('../../utils/auditContext');
const { HttpError, sendControllerError } = require('../../utils/httpError');

const normalizeDateValue = (value) => {
  if (value === null || value === undefined) return null;
  const text = value.toString().trim();
  if (text.length >= 10 && /^\d{4}-\d{2}-\d{2}/.test(text)) {
    return text.substring(0, 10);
  }
  return text || null;
};

const ensureHseSchema = async (connection) => {
  await connection.execute(`
    CREATE TABLE IF NOT EXISTS hse_trainings (
      id INT AUTO_INCREMENT PRIMARY KEY,
      project_id INT NULL,
      employee_id INT NULL,
      training_type VARCHAR(40) NOT NULL DEFAULT 'training',
      title VARCHAR(200) NOT NULL,
      training_date DATE NOT NULL,
      instructor_name VARCHAR(120) NULL,
      evidence_path VARCHAR(500) NULL,
      notes TEXT NULL,
      status VARCHAR(30) NOT NULL DEFAULT 'completed',
      created_by INT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      INDEX idx_project (project_id),
      INDEX idx_employee (employee_id),
      INDEX idx_training_date (training_date)
    )
  `);

  await connection.execute(`
    CREATE TABLE IF NOT EXISTS hse_epp_deliveries (
      id INT AUTO_INCREMENT PRIMARY KEY,
      project_id INT NULL,
      employee_id INT NULL,
      epp_item VARCHAR(200) NOT NULL,
      quantity DECIMAL(10,2) NOT NULL DEFAULT 1,
      delivery_date DATE NOT NULL,
      evidence_path VARCHAR(500) NULL,
      notes TEXT NULL,
      delivered_by_user_id INT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      INDEX idx_project (project_id),
      INDEX idx_employee (employee_id),
      INDEX idx_delivery_date (delivery_date)
    )
  `);

  await connection.execute(`
    CREATE TABLE IF NOT EXISTS hse_incidents (
      id INT AUTO_INCREMENT PRIMARY KEY,
      project_id INT NULL,
      employee_id INT NULL,
      incident_type VARCHAR(80) NOT NULL DEFAULT 'incident',
      severity VARCHAR(30) NOT NULL DEFAULT 'medium',
      incident_date DATE NOT NULL,
      description TEXT NOT NULL,
      evidence_path VARCHAR(500) NULL,
      status VARCHAR(30) NOT NULL DEFAULT 'open',
      created_by INT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      INDEX idx_project (project_id),
      INDEX idx_status (status),
      INDEX idx_incident_date (incident_date)
    )
  `);

  await connection.execute(`
    CREATE TABLE IF NOT EXISTS hse_unsafe_reports (
      id INT AUTO_INCREMENT PRIMARY KEY,
      project_id INT NULL,
      report_type VARCHAR(30) NOT NULL DEFAULT 'condition',
      description TEXT NOT NULL,
      location_note VARCHAR(250) NULL,
      report_date DATE NOT NULL,
      evidence_path VARCHAR(500) NULL,
      status VARCHAR(30) NOT NULL DEFAULT 'open',
      created_by INT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      INDEX idx_project (project_id),
      INDEX idx_status (status),
      INDEX idx_report_date (report_date)
    )
  `);

  await connection.execute(`
    CREATE TABLE IF NOT EXISTS hse_corrective_actions (
      id INT AUTO_INCREMENT PRIMARY KEY,
      project_id INT NULL,
      source_type VARCHAR(40) NULL,
      source_id INT NULL,
      description TEXT NOT NULL,
      responsible_user_id INT NULL,
      due_date DATE NULL,
      status VARCHAR(30) NOT NULL DEFAULT 'pending',
      completed_at DATETIME NULL,
      notes TEXT NULL,
      created_by INT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      INDEX idx_project (project_id),
      INDEX idx_status (status),
      INDEX idx_due_date (due_date)
    )
  `);
};

const employeeNameExpression = `COALESCE(u.name, e.employee_name, CONCAT('Colaborador #', e.id))`;

const listTrainings = async (req, res) => {
  try {
    const projectId = req.query.project_id ? Number(req.query.project_id) : null;
    const rows = await withDbConnection(async (connection) => {
      await ensureHseSchema(connection);
      const conditions = [];
      const params = [];
      if (projectId) {
        conditions.push('ht.project_id = ?');
        params.push(projectId);
      }
      const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
      const [result] = await connection.execute(
        `SELECT ht.*, p.name AS project_name, ${employeeNameExpression} AS employee_name
         FROM hse_trainings ht
         LEFT JOIN projects p ON p.id = ht.project_id
         LEFT JOIN employees e ON e.id = ht.employee_id
         LEFT JOIN users u ON u.id = e.user_id
         ${where}
         ORDER BY ht.training_date DESC, ht.id DESC
         LIMIT 200`,
        params
      );
      return result;
    });
    res.json({ success: true, data: rows });
  } catch (error) {
    sendControllerError(res, error, 'Error al listar capacitaciones HSE');
  }
};

const createTraining = async (req, res) => {
  try {
    const {
      project_id,
      employee_id,
      training_type,
      title,
      training_date,
      instructor_name,
      evidence_path,
      notes,
      status,
    } = req.body;

    if (!title || !training_date) {
      throw new HttpError(400, 'title y training_date son requeridos');
    }

    const row = await withDbConnection(async (connection) => {
      await ensureHseSchema(connection);
      await applyAuditContext(connection, req);
      const [result] = await connection.execute(
        `INSERT INTO hse_trainings
         (project_id, employee_id, training_type, title, training_date, instructor_name, evidence_path, notes, status, created_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          project_id || null,
          employee_id || null,
          (training_type || 'training').toString().trim(),
          title.toString().trim(),
          normalizeDateValue(training_date),
          instructor_name || null,
          evidence_path || null,
          notes || null,
          (status || 'completed').toString().trim(),
          req.user?.id || null,
        ]
      );
      const [rows] = await connection.execute('SELECT * FROM hse_trainings WHERE id = ?', [result.insertId]);
      return rows[0];
    });

    res.status(201).json({ success: true, data: row, message: 'Capacitación registrada' });
  } catch (error) {
    sendControllerError(res, error, 'Error al registrar capacitación HSE');
  }
};

const listEppDeliveries = async (req, res) => {
  try {
    const projectId = req.query.project_id ? Number(req.query.project_id) : null;
    const rows = await withDbConnection(async (connection) => {
      await ensureHseSchema(connection);
      const conditions = [];
      const params = [];
      if (projectId) {
        conditions.push('ed.project_id = ?');
        params.push(projectId);
      }
      const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
      const [result] = await connection.execute(
        `SELECT ed.*, p.name AS project_name, ${employeeNameExpression} AS employee_name,
                du.name AS delivered_by_name
         FROM hse_epp_deliveries ed
         LEFT JOIN projects p ON p.id = ed.project_id
         LEFT JOIN employees e ON e.id = ed.employee_id
         LEFT JOIN users u ON u.id = e.user_id
         LEFT JOIN users du ON du.id = ed.delivered_by_user_id
         ${where}
         ORDER BY ed.delivery_date DESC, ed.id DESC
         LIMIT 200`,
        params
      );
      return result;
    });
    res.json({ success: true, data: rows });
  } catch (error) {
    sendControllerError(res, error, 'Error al listar entregas de EPP');
  }
};

const createEppDelivery = async (req, res) => {
  try {
    const { project_id, employee_id, epp_item, quantity, delivery_date, evidence_path, notes } = req.body;
    if (!epp_item || !delivery_date) {
      throw new HttpError(400, 'epp_item y delivery_date son requeridos');
    }

    const row = await withDbConnection(async (connection) => {
      await ensureHseSchema(connection);
      await applyAuditContext(connection, req);
      const [result] = await connection.execute(
        `INSERT INTO hse_epp_deliveries
         (project_id, employee_id, epp_item, quantity, delivery_date, evidence_path, notes, delivered_by_user_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          project_id || null,
          employee_id || null,
          epp_item.toString().trim(),
          Number(quantity) > 0 ? Number(quantity) : 1,
          normalizeDateValue(delivery_date),
          evidence_path || null,
          notes || null,
          req.user?.id || null,
        ]
      );
      const [rows] = await connection.execute('SELECT * FROM hse_epp_deliveries WHERE id = ?', [result.insertId]);
      return rows[0];
    });

    res.status(201).json({ success: true, data: row, message: 'Entrega de EPP registrada' });
  } catch (error) {
    sendControllerError(res, error, 'Error al registrar entrega de EPP');
  }
};

const listIncidents = async (req, res) => {
  try {
    const projectId = req.query.project_id ? Number(req.query.project_id) : null;
    const rows = await withDbConnection(async (connection) => {
      await ensureHseSchema(connection);
      const conditions = [];
      const params = [];
      if (projectId) {
        conditions.push('hi.project_id = ?');
        params.push(projectId);
      }
      const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
      const [result] = await connection.execute(
        `SELECT hi.*, p.name AS project_name, ${employeeNameExpression} AS employee_name
         FROM hse_incidents hi
         LEFT JOIN projects p ON p.id = hi.project_id
         LEFT JOIN employees e ON e.id = hi.employee_id
         LEFT JOIN users u ON u.id = e.user_id
         ${where}
         ORDER BY hi.incident_date DESC, hi.id DESC
         LIMIT 200`,
        params
      );
      return result;
    });
    res.json({ success: true, data: rows });
  } catch (error) {
    sendControllerError(res, error, 'Error al listar incidentes HSE');
  }
};

const createIncident = async (req, res) => {
  try {
    const {
      project_id,
      employee_id,
      incident_type,
      severity,
      incident_date,
      description,
      evidence_path,
      status,
    } = req.body;

    if (!description || !incident_date) {
      throw new HttpError(400, 'description e incident_date son requeridos');
    }

    const row = await withDbConnection(async (connection) => {
      await ensureHseSchema(connection);
      await applyAuditContext(connection, req);
      const [result] = await connection.execute(
        `INSERT INTO hse_incidents
         (project_id, employee_id, incident_type, severity, incident_date, description, evidence_path, status, created_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          project_id || null,
          employee_id || null,
          (incident_type || 'incident').toString().trim(),
          (severity || 'medium').toString().trim(),
          normalizeDateValue(incident_date),
          description.toString().trim(),
          evidence_path || null,
          (status || 'open').toString().trim(),
          req.user?.id || null,
        ]
      );
      const [rows] = await connection.execute('SELECT * FROM hse_incidents WHERE id = ?', [result.insertId]);
      return rows[0];
    });

    res.status(201).json({ success: true, data: row, message: 'Incidente registrado' });
  } catch (error) {
    sendControllerError(res, error, 'Error al registrar incidente HSE');
  }
};

const listUnsafeReports = async (req, res) => {
  try {
    const projectId = req.query.project_id ? Number(req.query.project_id) : null;
    const rows = await withDbConnection(async (connection) => {
      await ensureHseSchema(connection);
      const conditions = [];
      const params = [];
      if (projectId) {
        conditions.push('ur.project_id = ?');
        params.push(projectId);
      }
      const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
      const [result] = await connection.execute(
        `SELECT ur.*, p.name AS project_name
         FROM hse_unsafe_reports ur
         LEFT JOIN projects p ON p.id = ur.project_id
         ${where}
         ORDER BY ur.report_date DESC, ur.id DESC
         LIMIT 200`,
        params
      );
      return result;
    });
    res.json({ success: true, data: rows });
  } catch (error) {
    sendControllerError(res, error, 'Error al listar reportes inseguros HSE');
  }
};

const createUnsafeReport = async (req, res) => {
  try {
    const { project_id, report_type, description, location_note, report_date, evidence_path, status } = req.body;
    if (!description || !report_date) {
      throw new HttpError(400, 'description y report_date son requeridos');
    }

    const row = await withDbConnection(async (connection) => {
      await ensureHseSchema(connection);
      await applyAuditContext(connection, req);
      const [result] = await connection.execute(
        `INSERT INTO hse_unsafe_reports
         (project_id, report_type, description, location_note, report_date, evidence_path, status, created_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          project_id || null,
          (report_type || 'condition').toString().trim(),
          description.toString().trim(),
          location_note || null,
          normalizeDateValue(report_date),
          evidence_path || null,
          (status || 'open').toString().trim(),
          req.user?.id || null,
        ]
      );
      const [rows] = await connection.execute('SELECT * FROM hse_unsafe_reports WHERE id = ?', [result.insertId]);
      return rows[0];
    });

    res.status(201).json({ success: true, data: row, message: 'Reporte inseguro registrado' });
  } catch (error) {
    sendControllerError(res, error, 'Error al registrar reporte inseguro HSE');
  }
};

const listCorrectiveActions = async (req, res) => {
  try {
    const projectId = req.query.project_id ? Number(req.query.project_id) : null;
    const rows = await withDbConnection(async (connection) => {
      await ensureHseSchema(connection);
      const conditions = [];
      const params = [];
      if (projectId) {
        conditions.push('ca.project_id = ?');
        params.push(projectId);
      }
      const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
      const [result] = await connection.execute(
        `SELECT ca.*, p.name AS project_name, ru.name AS responsible_user_name
         FROM hse_corrective_actions ca
         LEFT JOIN projects p ON p.id = ca.project_id
         LEFT JOIN users ru ON ru.id = ca.responsible_user_id
         ${where}
         ORDER BY ca.due_date IS NULL, ca.due_date ASC, ca.id DESC
         LIMIT 200`,
        params
      );
      return result;
    });
    res.json({ success: true, data: rows });
  } catch (error) {
    sendControllerError(res, error, 'Error al listar acciones correctivas HSE');
  }
};

const createCorrectiveAction = async (req, res) => {
  try {
    const {
      project_id,
      source_type,
      source_id,
      description,
      responsible_user_id,
      due_date,
      status,
      notes,
    } = req.body;

    if (!description) {
      throw new HttpError(400, 'description es requerido');
    }

    const row = await withDbConnection(async (connection) => {
      await ensureHseSchema(connection);
      await applyAuditContext(connection, req);
      const [result] = await connection.execute(
        `INSERT INTO hse_corrective_actions
         (project_id, source_type, source_id, description, responsible_user_id, due_date, status, notes, created_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          project_id || null,
          source_type || null,
          source_id || null,
          description.toString().trim(),
          responsible_user_id || null,
          normalizeDateValue(due_date),
          (status || 'pending').toString().trim(),
          notes || null,
          req.user?.id || null,
        ]
      );
      const [rows] = await connection.execute('SELECT * FROM hse_corrective_actions WHERE id = ?', [result.insertId]);
      return rows[0];
    });

    res.status(201).json({ success: true, data: row, message: 'Acción correctiva registrada' });
  } catch (error) {
    sendControllerError(res, error, 'Error al registrar acción correctiva HSE');
  }
};

const updateCorrectiveAction = async (req, res) => {
  try {
    const { id } = req.params;
    const { status, notes, completed_at } = req.body;

    const row = await withDbConnection(async (connection) => {
      await ensureHseSchema(connection);
      const [existingRows] = await connection.execute('SELECT * FROM hse_corrective_actions WHERE id = ?', [id]);
      if (!existingRows.length) {
        throw new HttpError(404, 'Acción correctiva no encontrada');
      }

      const nextStatus = (status || existingRows[0].status).toString().trim();
      const nextNotes = notes === undefined ? existingRows[0].notes : notes;
      let nextCompletedAt = completed_at;
      if (nextCompletedAt === undefined && nextStatus === 'completed' && !existingRows[0].completed_at) {
        nextCompletedAt = new Date();
      }

      await applyAuditContext(connection, req);
      await connection.execute(
        `UPDATE hse_corrective_actions
         SET status = ?, notes = ?, completed_at = ?, updated_at = NOW()
         WHERE id = ?`,
        [nextStatus, nextNotes, nextCompletedAt || null, id]
      );

      const [rows] = await connection.execute('SELECT * FROM hse_corrective_actions WHERE id = ?', [id]);
      return rows[0];
    });

    res.json({ success: true, data: row, message: 'Acción correctiva actualizada' });
  } catch (error) {
    sendControllerError(res, error, 'Error al actualizar acción correctiva HSE');
  }
};

const getProjectHseSummary = async (connection, projectId) => {
  await ensureHseSchema(connection);

  const countOpen = async (table, statusColumn = 'status') => {
    const [rows] = await connection.execute(
      `SELECT COUNT(*) AS total FROM ${table} WHERE project_id = ? AND LOWER(TRIM(${statusColumn})) NOT IN ('closed', 'completed', 'resolved')`,
      [projectId]
    );
    return Number(rows[0]?.total || 0);
  };

  const countAll = async (table) => {
    const [rows] = await connection.execute(
      `SELECT COUNT(*) AS total FROM ${table} WHERE project_id = ?`,
      [projectId]
    );
    return Number(rows[0]?.total || 0);
  };

  return {
    trainings_total: await countAll('hse_trainings'),
    epp_deliveries_total: await countAll('hse_epp_deliveries'),
    incidents_total: await countAll('hse_incidents'),
    incidents_open: await countOpen('hse_incidents'),
    unsafe_reports_total: await countAll('hse_unsafe_reports'),
    unsafe_reports_open: await countOpen('hse_unsafe_reports'),
    corrective_actions_total: await countAll('hse_corrective_actions'),
    corrective_actions_pending: await countOpen('hse_corrective_actions'),
  };
};

const getHseDashboardSummary = async (req, res) => {
  try {
    const projectId = req.query.project_id ? Number(req.query.project_id) : null;
    const data = await withDbConnection(async (connection) => {
      await ensureHseSchema(connection);
      if (projectId) {
        return getProjectHseSummary(connection, projectId);
      }

      const countAll = async (table) => {
        const [rows] = await connection.execute(`SELECT COUNT(*) AS total FROM ${table}`);
        return Number(rows[0]?.total || 0);
      };
      const countOpen = async (table) => {
        const [rows] = await connection.execute(
          `SELECT COUNT(*) AS total FROM ${table} WHERE LOWER(TRIM(status)) NOT IN ('closed', 'completed', 'resolved')`
        );
        return Number(rows[0]?.total || 0);
      };

      return {
        trainings_total: await countAll('hse_trainings'),
        epp_deliveries_total: await countAll('hse_epp_deliveries'),
        incidents_total: await countAll('hse_incidents'),
        incidents_open: await countOpen('hse_incidents'),
        unsafe_reports_total: await countAll('hse_unsafe_reports'),
        unsafe_reports_open: await countOpen('hse_unsafe_reports'),
        corrective_actions_total: await countAll('hse_corrective_actions'),
        corrective_actions_pending: await countOpen('hse_corrective_actions'),
      };
    });

    res.json({ success: true, data });
  } catch (error) {
    sendControllerError(res, error, 'Error al obtener resumen HSE');
  }
};

module.exports = {
  ensureHseSchema,
  getProjectHseSummary,
  getHseDashboardSummary,
  listTrainings,
  createTraining,
  listEppDeliveries,
  createEppDelivery,
  listIncidents,
  createIncident,
  listUnsafeReports,
  createUnsafeReport,
  listCorrectiveActions,
  createCorrectiveAction,
  updateCorrectiveAction,
};
