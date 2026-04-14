const db = require('../../config/database');
const pool = db.pool;
const path = require('path');

const ensureEvidenceShape = async (connection) => {
  await connection.execute(`
    CREATE TABLE IF NOT EXISTS evidence (
      id INT AUTO_INCREMENT PRIMARY KEY,
      activity_id INT NULL,
      project_id INT NULL,
      module_type VARCHAR(50) NOT NULL DEFAULT 'general',
      file_path VARCHAR(500) NOT NULL,
      file_name VARCHAR(255) NOT NULL,
      file_size INT NOT NULL,
      uploaded_by INT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_activity (activity_id),
      INDEX idx_project (project_id),
      INDEX idx_module (module_type)
    )
  `);

  try {
    await connection.execute('ALTER TABLE evidence MODIFY COLUMN activity_id INT NULL');
  } catch (e) {
    // ignore if already nullable or DB restrictions apply
  }

  try {
    await connection.execute('ALTER TABLE evidence ADD COLUMN project_id INT NULL');
  } catch (e) {
    // ignore if column already exists
  }
};

const uploadEvidence = async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ success: false, message: 'Archivo no proporcionado' });
    }

    const { activity_id, project_id, module_type } = req.body;
    const uploadedBy = req.user && req.user.id ? req.user.id : null;

    // Ruta relativa para almacenar en BD
    const relativePath = path.relative(path.join(__dirname, '../../'), req.file.path).replace(/\\/g, '/');

    const connection = await pool.getConnection();
    await ensureEvidenceShape(connection);
    const [result] = await connection.execute(
      'INSERT INTO evidence (activity_id, project_id, module_type, file_path, file_name, file_size, uploaded_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, NOW())',
      [activity_id || null, project_id || null, module_type || 'general', relativePath, req.file.originalname, req.file.size, uploadedBy]
    );
    connection.release();

    res.status(201).json({
      success: true,
      message: 'Evidencia subida correctamente',
      evidenceId: result.insertId,
      file: {
        path: relativePath,
        name: req.file.originalname,
        size: req.file.size
      }
    });
  } catch (err) {
    res.status(err.status || 500).json({
      success: false,
      message: err.message || 'Error subiendo evidencia',
      error: err.message,
    });
  }
};

const listEvidence = async (req, res) => {
  try {
    const { activity_id, project_id, module_type } = req.query;
    const conditions = [];
    const params = [];

    if (activity_id) {
      conditions.push('activity_id = ?');
      params.push(activity_id);
    }
    if (module_type) {
      conditions.push('module_type = ?');
      params.push(module_type);
    }
    if (project_id) {
      conditions.push('project_id = ?');
      params.push(project_id);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    const connection = await pool.getConnection();
    await ensureEvidenceShape(connection);
    const [rows] = await connection.execute(`SELECT * FROM evidence ${where} ORDER BY created_at DESC`, params);
    connection.release();

    res.json({ success: true, data: rows });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Error listando evidencias', error: err.message });
  }
};

module.exports = {
  uploadEvidence,
  listEvidence,
  ensureEvidenceShape
};
