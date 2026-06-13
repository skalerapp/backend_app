const db = require('../../config/database');
const pool = db.pool;
const { applyAuditContext } = require('../../utils/auditContext');
const { normalizeRole } = require('../../middleware/auth.middleware');
const {
  ensureOperationalScopeShape,
  buildOperationalVisibilityFilter,
  canAccessProjectByOperationalScope,
} = require('../operationalScopes/operationalScopes.service');

const normalizeProjectStatus = (value) => {
  const raw = (value || '').toString().trim().toLowerCase();
  switch (raw) {
    case 'active':
    case 'activo':
      return 'active';
    case 'planning':
    case 'planificación':
    case 'planificacion':
      return 'planning';
    case 'paused':
    case 'pausado':
      return 'paused';
    case 'completed':
    case 'completado':
      return 'completed';
    case 'cancelled':
    case 'cancelado':
      return 'cancelled';
    case 'closed':
    case 'cerrado':
      return 'closed';
    default:
      return 'active';
  }
};

const otCodeFromProjectId = (projectId) => `OT${projectId}`;
const todayIsoDate = () => new Date().toISOString().slice(0, 10);
const isFinalStatus = (status) => ['completed', 'closed'].includes(status);

const ensureProjectCollaboratorsSchema = async (connection) => {
  await connection.execute(`
    CREATE TABLE IF NOT EXISTS project_collaborators (
      id INT AUTO_INCREMENT PRIMARY KEY,
      project_id INT NOT NULL,
      employee_id INT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY unique_employee (employee_id),
      KEY idx_project (project_id),
      CONSTRAINT fk_pc_project FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
      CONSTRAINT fk_pc_employee FOREIGN KEY (employee_id) REFERENCES employees(id) ON DELETE CASCADE
    )
  `);
};

const ensureProjectStatusSchema = async (connection) => {
  try {
    await connection.execute("ALTER TABLE projects MODIFY COLUMN status VARCHAR(30) NOT NULL DEFAULT 'active'");
  } catch (e) {}

  try {
    await connection.execute("UPDATE projects SET status = 'active' WHERE status IS NULL OR TRIM(status) = ''");
  } catch (e) {}
};

const ensureProjectOtSchema = async (connection) => {
  try {
    await connection.execute('ALTER TABLE projects ADD COLUMN ot_code VARCHAR(30) NULL');
  } catch (e) {}

  try {
    await connection.execute('CREATE UNIQUE INDEX uk_projects_ot_code ON projects (ot_code)');
  } catch (e) {}

  try {
    await connection.execute("UPDATE projects SET ot_code = CONCAT('OT', id) WHERE (ot_code IS NULL OR TRIM(ot_code) = '')");
  } catch (e) {}
};

const ensureProjectActualEndDateSchema = async (connection) => {
  try {
    await connection.execute('ALTER TABLE projects ADD COLUMN actual_end_date DATE NULL');
  } catch (e) {}
};

const ensureProjectMeterFieldsSchema = async (connection) => {
  try {
    await connection.execute('ALTER TABLE projects ADD COLUMN planned_area_m2 DECIMAL(12,2) NOT NULL DEFAULT 0.00');
  } catch (e) {}

  try {
    await connection.execute('ALTER TABLE projects ADD COLUMN planned_length_ml DECIMAL(12,2) NOT NULL DEFAULT 0.00');
  } catch (e) {}
};

const ensureProjectsSchema = async (connection) => {
  await ensureProjectStatusSchema(connection);
  await ensureProjectOtSchema(connection);
  await ensureProjectActualEndDateSchema(connection);
  await ensureProjectMeterFieldsSchema(connection);
  await ensureProjectCollaboratorsSchema(connection);
};

const getNextOtCode = async (req, res) => {
  try {
    const connection = await pool.getConnection();
    await ensureProjectOtSchema(connection);

    const [statusRows] = await connection.execute("SHOW TABLE STATUS LIKE 'projects'");
    const nextId = Number(statusRows?.[0]?.Auto_increment || 0);
    connection.release();

    if (!nextId || Number.isNaN(nextId)) {
      return res.status(500).json({
        success: false,
        message: 'No fue posible calcular la próxima OT',
      });
    }

    res.json({
      success: true,
      data: {
        nextProjectId: nextId,
        otCode: otCodeFromProjectId(nextId),
      },
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Error al calcular próxima OT',
      error: error.message,
    });
  }
};

// Obtener todos los proyectos
const getProjects = async (req, res) => {
  try {
    const connection = await pool.getConnection();
    await ensureProjectCollaboratorsSchema(connection);
    await ensureProjectStatusSchema(connection);
    await ensureProjectOtSchema(connection);
    await ensureProjectActualEndDateSchema(connection);
    await ensureProjectMeterFieldsSchema(connection);
    await ensureOperationalScopeShape(connection);

    const normalizedRole = normalizeRole(req.user?.role);
    const visibility = buildOperationalVisibilityFilter({
      normalizedRole,
      userId: req.user?.id,
      projectAlias: 'p',
    });
    const where = visibility.clause ? `WHERE ${visibility.clause}` : '';

    const [projects] = await connection.execute(
      `SELECT p.*, COUNT(pc.employee_id) AS collaborator_count
       , MAX(u.name) AS manager_name
       FROM projects p
       LEFT JOIN project_collaborators pc ON p.id = pc.project_id
       LEFT JOIN users u ON p.manager_id = u.id
       ${where}
       GROUP BY p.id
       ORDER BY p.created_at DESC`,
      visibility.params
    );
    connection.release();

    res.json({
      success: true,
      data: projects
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Error al obtener proyectos',
      error: error.message
    });
  }
};

// Obtener proyecto por ID
const getProjectById = async (req, res) => {
  try {
    const { id } = req.params;
    const connection = await pool.getConnection();
    await ensureProjectCollaboratorsSchema(connection);
    await ensureProjectStatusSchema(connection);
    await ensureProjectOtSchema(connection);
    await ensureProjectActualEndDateSchema(connection);
    await ensureProjectMeterFieldsSchema(connection);
    await ensureOperationalScopeShape(connection);

    const normalizedRole = normalizeRole(req.user?.role);
    const visibility = buildOperationalVisibilityFilter({
      normalizedRole,
      userId: req.user?.id,
      projectAlias: 'p',
    });
    const visibilityClause = visibility.clause ? ` AND ${visibility.clause}` : '';

    const [projects] = await connection.execute(
      `SELECT p.*, COUNT(pc.employee_id) AS collaborator_count
       , MAX(u.name) AS manager_name
       FROM projects p
       LEFT JOIN project_collaborators pc ON p.id = pc.project_id
       LEFT JOIN users u ON p.manager_id = u.id
       WHERE p.id = ?
       ${visibilityClause}
       GROUP BY p.id`,
      [id, ...visibility.params]
    );
    connection.release();

    if (projects.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Proyecto no encontrado'
      });
    }

    res.json({
      success: true,
      data: projects[0]
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Error al obtener proyecto',
      error: error.message
    });
  }
};

// Crear nuevo proyecto
const createProject = async (req, res) => {
  try {
    const { name, description, budget, start_date, end_date, actual_end_date, manager_id, status, planned_area_m2, planned_length_ml } = req.body;

    if (!name || !budget) {
      return res.status(400).json({
        success: false,
        message: 'Nombre y presupuesto son requeridos'
      });
    }

    const connection = await pool.getConnection();
    await ensureProjectStatusSchema(connection);
    await ensureProjectOtSchema(connection);
    await ensureProjectActualEndDateSchema(connection);
    await ensureProjectMeterFieldsSchema(connection);

    const normalizedStatus = normalizeProjectStatus(status);
    const resolvedActualEndDate = isFinalStatus(normalizedStatus)
      ? (actual_end_date || todayIsoDate())
      : null;
    
    // Safe conversion of meter fields
    let resolvedPlannedArea = 0;
    if (planned_area_m2 !== undefined && planned_area_m2 !== null && planned_area_m2 !== '') {
      const parsed = parseFloat(planned_area_m2);
      resolvedPlannedArea = isNaN(parsed) ? 0 : Math.max(0, parsed);
    }
    
    let resolvedPlannedLength = 0;
    if (planned_length_ml !== undefined && planned_length_ml !== null && planned_length_ml !== '') {
      const parsed = parseFloat(planned_length_ml);
      resolvedPlannedLength = isNaN(parsed) ? 0 : Math.max(0, parsed);
    }
    
    await applyAuditContext(connection, req);
    const [result] = await connection.execute(
      'INSERT INTO projects (name, description, budget, start_date, end_date, actual_end_date, manager_id, status, planned_area_m2, planned_length_ml, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())',
      [name, description || null, budget, start_date || null, end_date || null, resolvedActualEndDate, manager_id || null, normalizedStatus, resolvedPlannedArea, resolvedPlannedLength]
    );

    const generatedOtCode = otCodeFromProjectId(result.insertId);
    await connection.execute('UPDATE projects SET ot_code = ? WHERE id = ?', [generatedOtCode, result.insertId]);
    connection.release();

    res.status(201).json({
      success: true,
      message: 'Proyecto creado exitosamente',
      projectId: result.insertId,
      otCode: generatedOtCode,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Error al crear proyecto',
      error: error.message
    });
  }
};

// Actualizar proyecto
const updateProject = async (req, res) => {
  try {
    const { id } = req.params;
    const { name, description, budget, start_date, end_date, actual_end_date, status, manager_id, planned_area_m2, planned_length_ml } = req.body;

    if (!name || !budget) {
      return res.status(400).json({
        success: false,
        message: 'Nombre y presupuesto son requeridos',
      });
    }

    const connection = await pool.getConnection();
    await ensureProjectStatusSchema(connection);
    await ensureProjectOtSchema(connection);
    await ensureProjectActualEndDateSchema(connection);
    await ensureProjectMeterFieldsSchema(connection);

    const normalizedStatus = normalizeProjectStatus(status);
    const [existingRows] = await connection.execute(
      'SELECT status, actual_end_date FROM projects WHERE id = ?',
      [id]
    );

    if (existingRows.length === 0) {
      connection.release();
      return res.status(404).json({
        success: false,
        message: 'Proyecto no encontrado',
      });
    }

    const existingStatus = normalizeProjectStatus(existingRows[0].status);
    const existingActualEndDate = existingRows[0].actual_end_date;

    if (isFinalStatus(existingStatus) && normalizedStatus !== existingStatus) {
      connection.release();
      return res.status(409).json({
        success: false,
        message: 'Este proyecto ya está finalizado y no permite cambiar su estado',
      });
    }

    if (!isFinalStatus(existingStatus) && isFinalStatus(normalizedStatus)) {
      const [openActivitiesRows] = await connection.execute(
        `SELECT COUNT(*) AS total
         FROM activities
         WHERE project_id = ?
           AND LOWER(TRIM(COALESCE(status, ''))) NOT IN ('completed', 'completado', 'closed', 'cerrado', 'cancelled', 'cancelado')`,
        [id]
      );

      const openActivities = Number(openActivitiesRows?.[0]?.total || 0);
      if (openActivities > 0) {
        connection.release();
        return res.status(409).json({
          success: false,
          message: `No se puede finalizar el proyecto: hay ${openActivities} actividad(es) sin cerrar/completar/cancelar`,
        });
      }
    }

    const resolvedActualEndDate = isFinalStatus(normalizedStatus)
      ? (actual_end_date || existingActualEndDate || todayIsoDate())
      : null;
    
    // Safe conversion of meter fields
    let resolvedPlannedArea = 0;
    if (planned_area_m2 !== undefined && planned_area_m2 !== null && planned_area_m2 !== '') {
      const parsed = parseFloat(planned_area_m2);
      resolvedPlannedArea = isNaN(parsed) ? 0 : Math.max(0, parsed);
    }
    
    let resolvedPlannedLength = 0;
    if (planned_length_ml !== undefined && planned_length_ml !== null && planned_length_ml !== '') {
      const parsed = parseFloat(planned_length_ml);
      resolvedPlannedLength = isNaN(parsed) ? 0 : Math.max(0, parsed);
    }

    await applyAuditContext(connection, req);
    await connection.execute(
      'UPDATE projects SET name = ?, description = ?, budget = ?, start_date = ?, end_date = ?, actual_end_date = ?, status = ?, manager_id = ?, planned_area_m2 = ?, planned_length_ml = ?, updated_at = NOW() WHERE id = ?',
      [name, description || null, budget, start_date || null, end_date || null, resolvedActualEndDate, normalizedStatus, manager_id || null, resolvedPlannedArea, resolvedPlannedLength, id]
    );
    connection.release();

    res.json({
      success: true,
      message: 'Proyecto actualizado'
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Error al actualizar proyecto',
      error: error.message
    });
  }
};

// Eliminar proyecto
const deleteProject = async (req, res) => {
  try {
    const { id } = req.params;

    const connection = await pool.getConnection();
    await applyAuditContext(connection, req);
    await connection.execute(
      'DELETE FROM projects WHERE id = ?',
      [id]
    );
    connection.release();

    res.json({
      success: true,
      message: 'Proyecto eliminado'
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Error al eliminar proyecto',
      error: error.message
    });
  }
};

// Obtener colaboradores asignados a un proyecto
const getProjectCollaborators = async (req, res) => {
  try {
    const { id } = req.params;
    const connection = await pool.getConnection();
    await ensureProjectCollaboratorsSchema(connection);
    await ensureOperationalScopeShape(connection);

    const normalizedRole = normalizeRole(req.user?.role);
    if (normalizedRole === 'leader' || normalizedRole === 'supervisor') {
      const hasProjectAccess = await canAccessProjectByOperationalScope({
        connection,
        userId: req.user.id,
        role: normalizedRole,
        projectId: Number(id),
      });

      if (!hasProjectAccess) {
        connection.release();
        return res.status(403).json({
          success: false,
          message: 'No tienes acceso al proyecto solicitado',
        });
      }
    }

    const [rows] = await connection.execute(
      `SELECT
        pc.id AS collaborator_assignment_id,
        e.*,
        e.employee_name AS name,
        u.name AS app_user_name,
        u.email AS app_user_email,
        u.email AS email
      FROM project_collaborators pc
      INNER JOIN employees e ON pc.employee_id = e.id
      LEFT JOIN users u ON e.user_id = u.id
      WHERE pc.project_id = ?
      ORDER BY e.created_at DESC`,
      [id]
    );
    connection.release();

    res.json({ success: true, data: rows });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Error al obtener colaboradores del proyecto',
      error: error.message
    });
  }
};

// Asignar colaborador a proyecto
const assignCollaboratorToProject = async (req, res) => {
  try {
    const { id } = req.params;
    const { employee_id } = req.body;

    if (!employee_id) {
      return res.status(400).json({ success: false, message: 'employee_id es requerido' });
    }

    const connection = await pool.getConnection();
    await ensureProjectCollaboratorsSchema(connection);

    const [projectRows] = await connection.execute('SELECT id, name FROM projects WHERE id = ?', [id]);
    if (projectRows.length === 0) {
      connection.release();
      return res.status(404).json({ success: false, message: 'Proyecto no encontrado' });
    }

    const [employeeRows] = await connection.execute('SELECT id FROM employees WHERE id = ?', [employee_id]);
    if (employeeRows.length === 0) {
      connection.release();
      return res.status(404).json({ success: false, message: 'Colaborador no encontrado' });
    }

    const [existing] = await connection.execute(
      `SELECT pc.project_id, p.name AS project_name, p.status AS project_status
       FROM project_collaborators pc
       INNER JOIN projects p ON pc.project_id = p.id
       WHERE pc.employee_id = ?
       LIMIT 1`,
      [employee_id]
    );

    if (existing.length > 0) {
      const assignedProject = existing[0];
      if (parseInt(assignedProject.project_id, 10) === parseInt(id, 10)) {
        connection.release();
        return res.status(409).json({
          success: false,
          message: 'El colaborador ya está asignado a este proyecto'
        });
      }

      const normalizedAssignedStatus = normalizeProjectStatus(assignedProject.project_status);
      const canReassign = ['cancelled', 'completed', 'closed', 'paused'].includes(normalizedAssignedStatus);
      if (canReassign) {
        await applyAuditContext(connection, req);
        await connection.execute(
          'UPDATE project_collaborators SET project_id = ?, created_at = NOW() WHERE employee_id = ?',
          [id, employee_id]
        );
        connection.release();
        return res.status(200).json({
          success: true,
          message: 'Colaborador reasignado a un nuevo proyecto porque el anterior ya no está activo'
        });
      }

      connection.release();
      return res.status(409).json({
        success: false,
        message: `El colaborador ya está asignado al proyecto ${assignedProject.project_name}`
      });
    }

    await applyAuditContext(connection, req);
    await connection.execute(
      'INSERT INTO project_collaborators (project_id, employee_id, created_at) VALUES (?, ?, NOW())',
      [id, employee_id]
    );
    connection.release();

    res.status(201).json({ success: true, message: 'Colaborador asignado al proyecto' });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Error al asignar colaborador al proyecto',
      error: error.message
    });
  }
};

// Quitar colaborador de proyecto
const removeCollaboratorFromProject = async (req, res) => {
  try {
    const { id, employeeId } = req.params;
    const connection = await pool.getConnection();
    await ensureProjectCollaboratorsSchema(connection);

    const [activeActivities] = await connection.execute(
      `SELECT id
       FROM activities
       WHERE project_id = ?
         AND employee_id = ?
         AND (status IS NULL OR status NOT IN ('completed', 'cancelled'))
       LIMIT 1`,
      [id, employeeId]
    );

    if (activeActivities.length > 0) {
      connection.release();
      return res.status(409).json({
        success: false,
        message: 'No se puede remover: el colaborador tiene actividades activas en este proyecto'
      });
    }

    await applyAuditContext(connection, req);
    await connection.execute(
      'DELETE FROM project_collaborators WHERE project_id = ? AND employee_id = ?',
      [id, employeeId]
    );
    connection.release();

    res.json({ success: true, message: 'Colaborador removido del proyecto' });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Error al remover colaborador del proyecto',
      error: error.message
    });
  }
};

module.exports = {
  getProjects,
  getProjectById,
  createProject,
  updateProject,
  getNextOtCode,
  deleteProject,
  getProjectCollaborators,
  assignCollaboratorToProject,
  removeCollaboratorFromProject,
  ensureProjectsSchema
};
