const db = require('../../config/database');
const { withDbConnection } = db;
const { applyAuditContext } = require('../../utils/auditContext');
const { HttpError, sendControllerError } = require('../../utils/httpError');

const normalizeEvaluationStatus = (value) => {
  const raw = (value || 'draft').toString().trim().toLowerCase();
  if (raw === 'submitted' || raw === 'enviada') return 'submitted';
  if (raw === 'approved' || raw === 'aprobada') return 'approved';
  return 'draft';
};

const normalizeDateValue = (value) => {
  if (value === null || value === undefined) return null;
  const text = value.toString().trim();
  if (text.length >= 10 && /^\d{4}-\d{2}-\d{2}/.test(text)) return text.substring(0, 10);
  return text || null;
};

const ensurePerformanceEvaluationsSchema = async (connection) => {
  await connection.execute(`
    CREATE TABLE IF NOT EXISTS performance_evaluations (
      id INT AUTO_INCREMENT PRIMARY KEY,
      employee_id INT NOT NULL,
      project_id INT NULL,
      evaluator_user_id INT NULL,
      evaluation_date DATE NOT NULL,
      period_label VARCHAR(80) NULL,
      score DECIMAL(4,2) NOT NULL DEFAULT 0,
      strengths TEXT NULL,
      improvements TEXT NULL,
      status VARCHAR(30) NOT NULL DEFAULT 'draft',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      INDEX idx_employee (employee_id),
      INDEX idx_project (project_id),
      INDEX idx_evaluation_date (evaluation_date)
    )
  `);
};

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
        `SELECT pe.*,
                COALESCE(u.name, e.employee_name, CONCAT('Colaborador #', e.id)) AS employee_name,
                p.name AS project_name,
                ev.name AS evaluator_name
         FROM performance_evaluations pe
         INNER JOIN employees e ON e.id = pe.employee_id
         LEFT JOIN users u ON u.id = e.user_id
         LEFT JOIN projects p ON p.id = pe.project_id
         LEFT JOIN users ev ON ev.id = pe.evaluator_user_id
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
    } = req.body;

    if (!employee_id || !evaluation_date) {
      throw new HttpError(400, 'employee_id y evaluation_date son requeridos');
    }

    const row = await withDbConnection(async (connection) => {
      await ensurePerformanceEvaluationsSchema(connection);
      await applyAuditContext(connection, req);
      const [result] = await connection.execute(
        `INSERT INTO performance_evaluations
         (employee_id, project_id, evaluator_user_id, evaluation_date, period_label, score, strengths, improvements, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          employee_id,
          project_id || null,
          req.user?.id || null,
          normalizeDateValue(evaluation_date),
          period_label || null,
          Number(score) || 0,
          strengths || null,
          improvements || null,
          normalizeEvaluationStatus(status),
        ]
      );
      const [rows] = await connection.execute('SELECT * FROM performance_evaluations WHERE id = ?', [result.insertId]);
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

      await applyAuditContext(connection, req);
      await connection.execute(
        `UPDATE performance_evaluations
         SET project_id = ?, evaluation_date = ?, period_label = ?, score = ?, strengths = ?, improvements = ?, status = ?, updated_at = NOW()
         WHERE id = ?`,
        [
          req.body.project_id == null ? existing.project_id : req.body.project_id,
          req.body.evaluation_date == null ? existing.evaluation_date : normalizeDateValue(req.body.evaluation_date),
          req.body.period_label == null ? existing.period_label : req.body.period_label,
          req.body.score == null ? existing.score : Number(req.body.score) || 0,
          req.body.strengths == null ? existing.strengths : req.body.strengths,
          req.body.improvements == null ? existing.improvements : req.body.improvements,
          req.body.status == null ? existing.status : normalizeEvaluationStatus(req.body.status),
          id,
        ]
      );
      const [rows] = await connection.execute('SELECT * FROM performance_evaluations WHERE id = ?', [id]);
      return rows[0];
    });

    res.json({ success: true, data: row, message: 'Evaluación actualizada' });
  } catch (error) {
    sendControllerError(res, error, 'Error al actualizar evaluación de desempeño');
  }
};

module.exports = {
  ensurePerformanceEvaluationsSchema,
  listPerformanceEvaluations,
  createPerformanceEvaluation,
  updatePerformanceEvaluation,
};
