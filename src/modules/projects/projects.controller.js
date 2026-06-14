const db = require('../../config/database');
const { withDbConnection } = db;
const pool = db.pool;
const { applyAuditContext } = require('../../utils/auditContext');
const { HttpError, sendControllerError } = require('../../utils/httpError');
const { normalizeRole } = require('../../middleware/auth.middleware');
const {
  ensureOperationalScopeShape,
  buildOperationalVisibilityFilter,
  canAccessProjectByOperationalScope,
} = require('../operationalScopes/operationalScopes.service');
const { ensureHseSchema, getProjectHseSummary } = require('../hse/hse.controller');
const { ensureTasksSchema } = require('../tasks/tasks.controller');

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
    const nextId = await withDbConnection(async (connection) => {
      await ensureProjectOtSchema(connection);
      const [statusRows] = await connection.execute("SHOW TABLE STATUS LIKE 'projects'");
      return Number(statusRows?.[0]?.Auto_increment || 0);
    });

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
    sendControllerError(res, error, 'Error al calcular próxima OT');
  }
};

// Obtener todos los proyectos
const getProjects = async (req, res) => {
  let connection;
  try {
    connection = await pool.getConnection();
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

    res.json({
      success: true,
      data: projects
    });
  } catch (error) {
    sendControllerError(res, error, 'Error al obtener proyectos');
  } finally {
    connection?.release();
  }
};

// Obtener proyecto por ID
const getProjectById = async (req, res) => {
  let connection;
  try {
    const { id } = req.params;
    connection = await pool.getConnection();
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
    sendControllerError(res, error, 'Error al obtener proyecto');
  } finally {
    connection?.release();
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

    const result = await withDbConnection(async (connection) => {
      await ensureProjectStatusSchema(connection);
      await ensureProjectOtSchema(connection);
      await ensureProjectActualEndDateSchema(connection);
      await ensureProjectMeterFieldsSchema(connection);

      const normalizedStatus = normalizeProjectStatus(status);
      const resolvedActualEndDate = isFinalStatus(normalizedStatus)
        ? (actual_end_date || todayIsoDate())
        : null;

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
      const [insertResult] = await connection.execute(
        'INSERT INTO projects (name, description, budget, start_date, end_date, actual_end_date, manager_id, status, planned_area_m2, planned_length_ml, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())',
        [name, description || null, budget, start_date || null, end_date || null, resolvedActualEndDate, manager_id || null, normalizedStatus, resolvedPlannedArea, resolvedPlannedLength]
      );

      const generatedOtCode = otCodeFromProjectId(insertResult.insertId);
      await connection.execute('UPDATE projects SET ot_code = ? WHERE id = ?', [generatedOtCode, insertResult.insertId]);

      return {
        projectId: insertResult.insertId,
        otCode: generatedOtCode,
      };
    });

    res.status(201).json({
      success: true,
      message: 'Proyecto creado exitosamente',
      projectId: result.projectId,
      otCode: result.otCode,
    });
  } catch (error) {
    sendControllerError(res, error, 'Error al crear proyecto');
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

    await withDbConnection(async (connection) => {
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
        throw new HttpError(404, 'Proyecto no encontrado');
      }

      const existingStatus = normalizeProjectStatus(existingRows[0].status);
      const existingActualEndDate = existingRows[0].actual_end_date;

      if (isFinalStatus(existingStatus) && normalizedStatus !== existingStatus) {
        throw new HttpError(409, 'Este proyecto ya está finalizado y no permite cambiar su estado');
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
          throw new HttpError(409, `No se puede finalizar el proyecto: hay ${openActivities} actividad(es) sin cerrar/completar/cancelar`);
        }
      }

      const resolvedActualEndDate = isFinalStatus(normalizedStatus)
        ? (actual_end_date || existingActualEndDate || todayIsoDate())
        : null;

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
    });

    res.json({
      success: true,
      message: 'Proyecto actualizado'
    });
  } catch (error) {
    sendControllerError(res, error, 'Error al actualizar proyecto');
  }
};

// Eliminar proyecto
const deleteProject = async (req, res) => {
  try {
    const { id } = req.params;

    await withDbConnection(async (connection) => {
      await applyAuditContext(connection, req);
      await connection.execute(
        'DELETE FROM projects WHERE id = ?',
        [id]
      );
    });

    res.json({
      success: true,
      message: 'Proyecto eliminado'
    });
  } catch (error) {
    sendControllerError(res, error, 'Error al eliminar proyecto');
  }
};

// Obtener colaboradores asignados a un proyecto
const getProjectCollaborators = async (req, res) => {
  try {
    const { id } = req.params;
    const rows = await withDbConnection(async (connection) => {
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
          throw new HttpError(403, 'No tienes acceso al proyecto solicitado');
        }
      }

      const [result] = await connection.execute(
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

      return result;
    });

    res.json({ success: true, data: rows });
  } catch (error) {
    sendControllerError(res, error, 'Error al obtener colaboradores del proyecto');
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

    const outcome = await withDbConnection(async (connection) => {
      await ensureProjectCollaboratorsSchema(connection);

      const [projectRows] = await connection.execute('SELECT id, name FROM projects WHERE id = ?', [id]);
      if (projectRows.length === 0) {
        throw new HttpError(404, 'Proyecto no encontrado');
      }

      const [employeeRows] = await connection.execute('SELECT id FROM employees WHERE id = ?', [employee_id]);
      if (employeeRows.length === 0) {
        throw new HttpError(404, 'Colaborador no encontrado');
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
          throw new HttpError(409, 'El colaborador ya está asignado a este proyecto');
        }

        const normalizedAssignedStatus = normalizeProjectStatus(assignedProject.project_status);
        const canReassign = ['cancelled', 'completed', 'closed', 'paused'].includes(normalizedAssignedStatus);
        if (canReassign) {
          await applyAuditContext(connection, req);
          await connection.execute(
            'UPDATE project_collaborators SET project_id = ?, created_at = NOW() WHERE employee_id = ?',
            [id, employee_id]
          );
          return {
            status: 200,
            message: 'Colaborador reasignado a un nuevo proyecto porque el anterior ya no está activo',
          };
        }

        throw new HttpError(409, `El colaborador ya está asignado al proyecto ${assignedProject.project_name}`);
      }

      await applyAuditContext(connection, req);
      await connection.execute(
        'INSERT INTO project_collaborators (project_id, employee_id, created_at) VALUES (?, ?, NOW())',
        [id, employee_id]
      );

      return {
        status: 201,
        message: 'Colaborador asignado al proyecto',
      };
    });

    res.status(outcome.status).json({ success: true, message: outcome.message });
  } catch (error) {
    sendControllerError(res, error, 'Error al asignar colaborador al proyecto');
  }
};

const getProjectConsolidatedHistory = async (req, res) => {
  try {
    const { id } = req.params;
    const projectId = Number(id);
    if (!Number.isFinite(projectId)) {
      throw new HttpError(400, 'ID de proyecto inválido');
    }

    const data = await withDbConnection(async (connection) => {
      await ensureProjectsSchema(connection);
      await ensureOperationalScopeShape(connection);
      await ensureHseSchema(connection);
      await ensureTasksSchema(connection);

      const [projectRows] = await connection.execute(
        `SELECT p.*, u.name AS manager_name
         FROM projects p
         LEFT JOIN users u ON u.id = p.manager_id
         WHERE p.id = ?
         LIMIT 1`,
        [projectId]
      );
      if (!projectRows.length) {
        throw new HttpError(404, 'Proyecto no encontrado');
      }

      const canAccess = await canAccessProjectByOperationalScope({
        connection,
        userId: req.user?.id,
        role: normalizeRole(req.user?.role),
        projectId,
      });
      if (!canAccess) {
        throw new HttpError(403, 'No tienes acceso a este proyecto');
      }

      const [activityRows] = await connection.execute(
        `SELECT a.id, a.status, a.description, a.start_time, a.end_time, a.executed_area_m2, a.executed_length_ml,
                a.updated_at, e.employee_name AS employee_name
         FROM activities a
         LEFT JOIN employees e ON e.id = a.employee_id
         WHERE a.project_id = ?
         ORDER BY COALESCE(a.updated_at, a.start_time, a.end_time) DESC
         LIMIT 20`,
        [projectId]
      );

      const [attendanceRows] = await connection.execute(
        `SELECT a.id, a.check_in, a.check_out, a.location_latitude, a.location_longitude,
                COALESCE(u.name, e.employee_name) AS employee_name
         FROM attendance a
         LEFT JOIN employees e ON e.id = a.employee_id
         LEFT JOIN users u ON u.id = a.user_id
         WHERE a.project_id = ?
         ORDER BY a.check_in DESC
         LIMIT 20`,
        [projectId]
      );

      const [warehouseRows] = await connection.execute(
        `SELECT wm.id, wm.movement_type, wm.quantity, wm.movement_date,
                COALESCE(receiver.name, wm.receiving_signature_name) AS receiver_name,
                wa.asset_name, wa.asset_code
         FROM warehouse_asset_movements wm
         LEFT JOIN warehouse_assets wa ON wa.id = wm.asset_id
         LEFT JOIN users receiver ON receiver.id = wm.receiver_user_id
         WHERE wm.project_id = ?
         ORDER BY wm.movement_date DESC, wm.id DESC
         LIMIT 20`,
        [projectId]
      );

      const [materialRows] = await connection.execute(
        `SELECT id, material_name, unit, assigned_quantity, unit_cost,
                (assigned_quantity * unit_cost) AS line_total
         FROM project_material_items
         WHERE project_id = ?
         ORDER BY material_name ASC`,
        [projectId]
      );

      const [allowanceRows] = await connection.execute(
        `SELECT pa.assigned_amount,
                COALESCE(SUM(ae.amount), 0) AS spent_amount,
                COUNT(ae.id) AS expense_count
         FROM project_allowances pa
         LEFT JOIN allowance_expenses ae ON ae.allowance_id = pa.id
         WHERE pa.project_id = ?
         GROUP BY pa.id, pa.assigned_amount
         LIMIT 1`,
        [projectId]
      );

      const [commercialVisitRows] = await connection.execute(
        `SELECT id, client_name, visit_date, status, expense_amount, summary, outcome
         FROM commercial_visits
         WHERE project_id = ?
         ORDER BY visit_date DESC
         LIMIT 10`,
        [projectId]
      );

      const [commercialOpportunityRows] = await connection.execute(
        `SELECT COUNT(*) AS total FROM commercial_opportunities WHERE project_id = ?`,
        [projectId]
      );

      const [activitySummaryRows] = await connection.execute(
        `SELECT
           COUNT(*) AS total,
           SUM(CASE WHEN LOWER(TRIM(COALESCE(status, ''))) IN ('completed', 'completada') THEN 1 ELSE 0 END) AS completed
         FROM activities
         WHERE project_id = ?`,
        [projectId]
      );

      const [taskSummaryRows] = await connection.execute(
        `SELECT
           COUNT(*) AS total,
           SUM(CASE WHEN LOWER(TRIM(COALESCE(status, ''))) = 'completed' THEN 1 ELSE 0 END) AS completed
         FROM operational_tasks
         WHERE project_id = ?`,
        [projectId]
      );

      const [productivityRows] = await connection.execute(
        `SELECT time_category, check_in, check_out
         FROM attendance
         WHERE project_id = ? AND check_in IS NOT NULL AND check_out IS NOT NULL`,
        [projectId]
      );

      let productiveHours = 0;
      let unproductiveHours = 0;
      for (const row of productivityRows) {
        const category = (row.time_category || 'productive').toString().toLowerCase();
        const hours = Math.max(0, (new Date(row.check_out).getTime() - new Date(row.check_in).getTime()) / (1000 * 60 * 60));
        if (category === 'unproductive' || category === 'improductivo') unproductiveHours += hours;
        else productiveHours += hours;
      }
      const totalHours = productiveHours + unproductiveHours;
      const productivityRate = totalHours <= 0 ? 0 : Math.round((productiveHours / totalHours) * 100);

      const materialsCostTotal = materialRows.reduce(
        (sum, row) => sum + Number(row.line_total || 0),
        0
      );

      const allowance = allowanceRows[0] || {};
      const activitySummary = activitySummaryRows[0] || {};
      const taskSummary = taskSummaryRows[0] || {};
      const hseSummary = await getProjectHseSummary(connection, projectId);

      const timeline = [
        ...activityRows.map((row) => ({
          type: 'activity',
          date: row.updated_at || row.start_time || row.end_time,
          title: row.description || `Actividad #${row.id}`,
          subtitle: row.employee_name,
          status: row.status,
        })),
        ...attendanceRows.map((row) => ({
          type: 'attendance',
          date: row.check_in,
          title: 'Asistencia registrada',
          subtitle: row.employee_name,
          status: row.check_out ? 'completed' : 'open',
        })),
        ...warehouseRows.map((row) => ({
          type: 'warehouse',
          date: row.movement_date,
          title: `${row.movement_type || 'movimiento'} · ${row.asset_name || row.asset_code || 'Activo'}`,
          subtitle: row.receiver_name,
          status: row.movement_type,
        })),
        ...commercialVisitRows.map((row) => ({
          type: 'commercial_visit',
          date: row.visit_date,
          title: `Visita · ${row.client_name || 'Cliente'}`,
          subtitle: row.outcome || row.summary,
          status: row.status,
        })),
      ]
        .filter((item) => item.date)
        .sort((left, right) => new Date(right.date).getTime() - new Date(left.date).getTime())
        .slice(0, 30);

      return {
        project: projectRows[0],
        summary: {
          activities_total: Number(activitySummary.total || 0),
          activities_completed: Number(activitySummary.completed || 0),
          attendance_records: attendanceRows.length,
          warehouse_movements: warehouseRows.length,
          materials_items: materialRows.length,
          materials_cost_total: materialsCostTotal,
          allowance_assigned: Number(allowance.assigned_amount || 0),
          allowance_spent: Number(allowance.spent_amount || 0),
          allowance_expense_count: Number(allowance.expense_count || 0),
          commercial_visits: commercialVisitRows.length,
          commercial_opportunities: Number(commercialOpportunityRows[0]?.total || 0),
          tasks_total: Number(taskSummary.total || 0),
          tasks_completed: Number(taskSummary.completed || 0),
          productive_hours: Number(productiveHours.toFixed(2)),
          unproductive_hours: Number(unproductiveHours.toFixed(2)),
          productivity_rate: productivityRate,
          ...hseSummary,
        },
        timeline,
        sections: {
          activities: activityRows,
          attendance: attendanceRows,
          warehouse_movements: warehouseRows,
          materials: materialRows,
          commercial_visits: commercialVisitRows,
          hse: hseSummary,
        },
      };
    });

    res.json({ success: true, data });
  } catch (error) {
    sendControllerError(res, error, 'Error al obtener historial consolidado del proyecto');
  }
};

// Quitar colaborador de proyecto
const removeCollaboratorFromProject = async (req, res) => {
  try {
    const { id, employeeId } = req.params;

    await withDbConnection(async (connection) => {
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
        throw new HttpError(409, 'No se puede remover: el colaborador tiene actividades activas en este proyecto');
      }

      await applyAuditContext(connection, req);
      await connection.execute(
        'DELETE FROM project_collaborators WHERE project_id = ? AND employee_id = ?',
        [id, employeeId]
      );
    });

    res.json({ success: true, message: 'Colaborador removido del proyecto' });
  } catch (error) {
    sendControllerError(res, error, 'Error al remover colaborador del proyecto');
  }
};

module.exports = {
  getProjects,
  getProjectById,
  getProjectConsolidatedHistory,
  createProject,
  updateProject,
  getNextOtCode,
  deleteProject,
  getProjectCollaborators,
  assignCollaboratorToProject,
  removeCollaboratorFromProject,
  ensureProjectsSchema
};
