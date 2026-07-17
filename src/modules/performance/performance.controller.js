const db = require('../../config/database');
const { withDbConnection } = db;
const { applyAuditContext } = require('../../utils/auditContext');
const { HttpError, sendControllerError } = require('../../utils/httpError');
const { normalizeRole } = require('../../middleware/auth.middleware');

const normalizeEvaluationStatus = (value) => {
  const raw = (value || 'draft').toString().trim().toLowerCase();
  if (raw === 'submitted' || raw === 'enviada') return 'submitted';
  if (raw === 'approved' || raw === 'aprobada') return 'approved';
  return 'draft';
};

const normalizeEvaluationType = (value) => {
  const raw = (value || 'periodic').toString().trim().toLowerCase();
  if (raw === 'project' || raw === 'proyecto') return 'project';
  if (raw === 'probation' || raw === 'prueba') return 'probation';
  return 'periodic';
};

const normalizeDateValue = (value) => {
  if (value === null || value === undefined) return null;
  const text = value.toString().trim();
  if (text.length >= 10 && /^\d{4}-\d{2}-\d{2}/.test(text)) return text.substring(0, 10);
  return text || null;
};

const normalizeNullableText = (value, maxLength = 5000) => {
  if (value == null) return null;
  const text = value.toString().trim();
  if (!text) return null;
  return text.length > maxLength ? text.substring(0, maxLength) : text;
};

const canApprovePerformanceEvaluation = (normalizedRole) => {
  return normalizedRole === 'super_admin' || normalizedRole === 'administrative' || normalizedRole === 'gerencial';
};

const canSubmitPerformanceEvaluation = (normalizedRole) => {
  return (
    normalizedRole === 'super_admin' ||
    normalizedRole === 'administrative' ||
    normalizedRole === 'coordinator_operations' ||
    normalizedRole === 'supervisor' ||
    normalizedRole === 'leader'
  );
};

const ensurePerformanceEvaluationsSchema = async (connection) => {
  await connection.execute(`
    CREATE TABLE IF NOT EXISTS performance_evaluations (
      id INT AUTO_INCREMENT PRIMARY KEY,
      employee_id INT NOT NULL,
      project_id INT NULL,
      evaluator_user_id INT NULL,
      evaluation_type VARCHAR(30) NOT NULL DEFAULT 'periodic',
      evaluation_date DATE NOT NULL,
      period_label VARCHAR(80) NULL,
      score DECIMAL(4,2) NOT NULL DEFAULT 0,
      strengths TEXT NULL,
      improvements TEXT NULL,
      status VARCHAR(30) NOT NULL DEFAULT 'draft',
      approver_user_id INT NULL,
      decided_at DATETIME NULL,
      decision_notes TEXT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      INDEX idx_employee (employee_id),
      INDEX idx_project (project_id),
      INDEX idx_evaluation_date (evaluation_date),
      INDEX idx_status (status)
    )
  `);

  const columns = [
    ['evaluation_type', "VARCHAR(30) NOT NULL DEFAULT 'periodic'"],
    ['approver_user_id', 'INT NULL'],
    ['decided_at', 'DATETIME NULL'],
    ['decision_notes', 'TEXT NULL'],
  ];

  for (const [columnName, definition] of columns) {
    const [rows] = await connection.execute(
      `SELECT COUNT(*) AS total
       FROM information_schema.COLUMNS
       WHERE TABLE_SCHEMA = DATABASE()
         AND TABLE_NAME = 'performance_evaluations'
         AND COLUMN_NAME = ?`,
      [columnName]
    );
    if (Number(rows[0]?.total || 0) === 0) {
      await connection.execute(`ALTER TABLE performance_evaluations ADD COLUMN ${columnName} ${definition}`);
    }
  }
};

const performanceSelect = `
  SELECT pe.*,
         COALESCE(u.name, e.employee_name, CONCAT('Colaborador #', e.id)) AS employee_name,
         p.name AS project_name,
         ev.name AS evaluator_name,
         app.name AS approver_name
  FROM performance_evaluations pe
  INNER JOIN employees e ON e.id = pe.employee_id
  LEFT JOIN users u ON u.id = e.user_id
  LEFT JOIN projects p ON p.id = pe.project_id
  LEFT JOIN users ev ON ev.id = pe.evaluator_user_id
  LEFT JOIN users app ON app.id = pe.approver_user_id
`;

const listPerformanceEvaluations = async (req, res) => {
  try {
    const employeeId = req.query.employee_id ? Number(req.query.employee_id) : null;
    const projectId = req.query.project_id ? Number(req.query.project_id) : null;

    const rows = await withDbConnection(async (connection) => {
      await ensurePerformanceEvaluationsSchema(connection);
      const conditions = [];
      const params = [];
      if (employeeId) {
        conditions.push('pe.employee_id = ?');
        params.push(employeeId);
      }
      if (projectId) {
        conditions.push('pe.project_id = ?');
        params.push(projectId);
      }
      const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
      const [result] = await connection.execute(
        `${performanceSelect}
         ${where}
         ORDER BY pe.evaluation_date DESC, pe.id DESC
         LIMIT 300`,
        params
      );
      return result;
    });

    res.json({ success: true, data: rows });
  } catch (error) {
    sendControllerError(res, error, 'Error al listar evaluaciones de desempeño');
  }
};

const createPerformanceEvaluation = async (req, res) => {
  try {
    const {
      employee_id,
      project_id,
      evaluation_date,
      period_label,
      score,
      strengths,
      improvements,
      status,
      evaluation_type,
    } = req.body;

    if (!employee_id || !evaluation_date) {
      throw new HttpError(400, 'employee_id y evaluation_date son requeridos');
    }

    const normalizedRole = normalizeRole(req.user?.role);
    const requestedStatus = normalizeEvaluationStatus(status);
    if (requestedStatus === 'approved') {
      throw new HttpError(400, 'Las evaluaciones deben iniciar como borrador o enviadas');
    }
    if (requestedStatus === 'submitted' && !canSubmitPerformanceEvaluation(normalizedRole)) {
      throw new HttpError(403, 'No tienes permiso para enviar evaluaciones');
    }

    const row = await withDbConnection(async (connection) => {
      await ensurePerformanceEvaluationsSchema(connection);
      await applyAuditContext(connection, req);
      const [result] = await connection.execute(
        `INSERT INTO performance_evaluations
         (employee_id, project_id, evaluator_user_id, evaluation_type, evaluation_date, period_label, score, strengths, improvements, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          employee_id,
          project_id || null,
          req.user?.id || null,
          normalizeEvaluationType(evaluation_type),
          normalizeDateValue(evaluation_date),
          period_label || null,
          Number(score) || 0,
          strengths || null,
          improvements || null,
          requestedStatus,
        ]
      );
      const [rows] = await connection.execute(`${performanceSelect} WHERE pe.id = ?`, [result.insertId]);
      return rows[0];
    });

    res.status(201).json({ success: true, data: row, message: 'Evaluación registrada' });
  } catch (error) {
    sendControllerError(res, error, 'Error al registrar evaluación de desempeño');
  }
};

const updatePerformanceEvaluation = async (req, res) => {
  try {
    const { id } = req.params;
    const row = await withDbConnection(async (connection) => {
      await ensurePerformanceEvaluationsSchema(connection);
      const [existingRows] = await connection.execute('SELECT * FROM performance_evaluations WHERE id = ?', [id]);
      if (!existingRows.length) {
        throw new HttpError(404, 'Evaluación no encontrada');
      }
      const existing = existingRows[0];
      const normalizedRole = normalizeRole(req.user?.role);

      if (existing.status === 'approved') {
        throw new HttpError(400, 'Evaluación aprobada: no se puede modificar');
      }

      if (req.body.status != null && normalizeEvaluationStatus(req.body.status) !== existing.status) {
        throw new HttpError(400, 'Para enviar o aprobar usa el endpoint de estado');
      }

      if (existing.status === 'submitted' && !canApprovePerformanceEvaluation(normalizedRole)) {
        throw new HttpError(403, 'La evaluación enviada solo puede editarla quien aprueba');
      }

      await applyAuditContext(connection, req);
      await connection.execute(
        `UPDATE performance_evaluations
         SET project_id = ?, evaluation_type = ?, evaluation_date = ?, period_label = ?, score = ?, strengths = ?, improvements = ?, updated_at = NOW()
         WHERE id = ?`,
        [
          req.body.project_id == null ? existing.project_id : req.body.project_id,
          req.body.evaluation_type == null
            ? existing.evaluation_type
            : normalizeEvaluationType(req.body.evaluation_type),
          req.body.evaluation_date == null ? existing.evaluation_date : normalizeDateValue(req.body.evaluation_date),
          req.body.period_label == null ? existing.period_label : req.body.period_label,
          req.body.score == null ? existing.score : Number(req.body.score) || 0,
          req.body.strengths == null ? existing.strengths : req.body.strengths,
          req.body.improvements == null ? existing.improvements : req.body.improvements,
          id,
        ]
      );
      const [rows] = await connection.execute(`${performanceSelect} WHERE pe.id = ?`, [id]);
      return rows[0];
    });

    res.json({ success: true, data: row, message: 'Evaluación actualizada' });
  } catch (error) {
    sendControllerError(res, error, 'Error al actualizar evaluación de desempeño');
  }
};

const updatePerformanceEvaluationStatus = async (req, res) => {
  try {
    const { id } = req.params;
    const status = normalizeEvaluationStatus(req.body.status);
    const decisionNotes = normalizeNullableText(req.body.decision_notes, 5000);
    const normalizedRole = normalizeRole(req.user?.role);

    const row = await withDbConnection(async (connection) => {
      await ensurePerformanceEvaluationsSchema(connection);

      const [existingRows] = await connection.execute('SELECT * FROM performance_evaluations WHERE id = ?', [id]);
      if (!existingRows.length) {
        throw new HttpError(404, 'Evaluación no encontrada');
      }
      const existing = existingRows[0];

      if (status === 'submitted') {
        if (!canSubmitPerformanceEvaluation(normalizedRole)) {
          throw new HttpError(403, 'No tienes permiso para enviar evaluaciones');
        }
        if (existing.status !== 'draft') {
          throw new HttpError(409, 'Solo se pueden enviar evaluaciones en borrador');
        }
        await applyAuditContext(connection, req);
        await connection.execute(
          `UPDATE performance_evaluations
           SET status = 'submitted', updated_at = NOW()
           WHERE id = ?`,
          [id]
        );
      } else if (status === 'approved') {
        if (!canApprovePerformanceEvaluation(normalizedRole)) {
          throw new HttpError(403, 'No tienes permiso para aprobar evaluaciones');
        }
        if (existing.status !== 'submitted') {
          throw new HttpError(409, 'Solo se pueden aprobar evaluaciones enviadas');
        }
        await applyAuditContext(connection, req);
        await connection.execute(
          `UPDATE performance_evaluations
           SET status = 'approved', approver_user_id = ?, decided_at = NOW(), decision_notes = ?, updated_at = NOW()
           WHERE id = ?`,
          [req.user?.id || null, decisionNotes, id]
        );
      } else {
        throw new HttpError(400, 'Estado no permitido para evaluaciones');
      }

      const [rows] = await connection.execute(`${performanceSelect} WHERE pe.id = ?`, [id]);
      return rows[0];
    });

    res.json({
      success: true,
      data: row,
      message: status === 'submitted' ? 'Evaluación enviada a revisión' : 'Evaluación aprobada',
    });
  } catch (error) {
    sendControllerError(res, error, 'Error al actualizar estado de evaluación');
  }
};

module.exports = {
  ensurePerformanceEvaluationsSchema,
  listPerformanceEvaluations,
  createPerformanceEvaluation,
  updatePerformanceEvaluation,
  updatePerformanceEvaluationStatus,
};
