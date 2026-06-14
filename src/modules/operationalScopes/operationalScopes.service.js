const { normalizeRole } = require('../../middleware/auth.middleware');
const {
  buildCommercialProjectVisibilityFilter,
  canAccessProjectAsCommercial,
} = require('../commercial/commercialVisibility.service');

const ensureOperationalScopeShape = async (connection) => {
  await connection.execute(`
    CREATE TABLE IF NOT EXISTS operational_role_assignments (
      id INT AUTO_INCREMENT PRIMARY KEY,
      project_id INT NOT NULL,
      user_id INT NOT NULL,
      role_scope ENUM('supervisor', 'leader') NOT NULL,
      is_active TINYINT(1) NOT NULL DEFAULT 1,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      UNIQUE KEY uk_assignment (project_id, user_id, role_scope),
      INDEX idx_project (project_id),
      INDEX idx_user_role_active (user_id, role_scope, is_active)
    )
  `);
};

const buildOperationalVisibilityFilter = ({ normalizedRole, userId, projectAlias = 'p', employeeUserExpression = null }) => {
  const role = normalizeRole(normalizedRole);

  if (role === 'leader') {
    const clauses = [
      `${projectAlias}.manager_id = ?`,
      `EXISTS (
        SELECT 1
        FROM operational_role_assignments ora
        WHERE ora.project_id = ${projectAlias}.id
          AND ora.user_id = ?
          AND ora.role_scope = ?
          AND ora.is_active = 1
      )`
    ];
    const params = [userId, userId, role];

    if (employeeUserExpression) {
      clauses.push(`${employeeUserExpression} = ?`);
      params.push(userId);
    }

    return {
      clause: `(${clauses.join(' OR ')})`,
      params,
    };
  }

  if (role === 'employee') {
    if (!employeeUserExpression) {
      return { clause: '1 = 0', params: [] };
    }
    return {
      clause: `${employeeUserExpression} = ?`,
      params: [userId],
    };
  }

  if (role === 'commercial') {
    return buildCommercialProjectVisibilityFilter(role, userId, projectAlias);
  }

  return { clause: null, params: [] };
};

const canAccessProjectByOperationalScope = async ({ connection, userId, role, projectId }) => {
  const normalizedRole = normalizeRole(role);

  if (
    normalizedRole === 'super_admin' ||
    normalizedRole === 'administrative' ||
    normalizedRole === 'coordinator_operations' ||
    normalizedRole === 'supervisor' ||
    normalizedRole === 'gerencial'
  ) {
    return true;
  }

  if (normalizedRole === 'commercial') {
    return canAccessProjectAsCommercial({ connection, userId, projectId });
  }

  if (normalizedRole !== 'leader') {
    return false;
  }

  const [rows] = await connection.execute(
    `SELECT id
     FROM projects
     WHERE id = ?
       AND manager_id = ?
     LIMIT 1`,
    [projectId, userId]
  );

  if (rows.length > 0) {
    return true;
  }

  const [assignmentRows] = await connection.execute(
    `SELECT id
     FROM operational_role_assignments
     WHERE user_id = ?
       AND role_scope = ?
       AND project_id = ?
       AND is_active = 1
     LIMIT 1`,
    [userId, normalizedRole, projectId]
  );

  return assignmentRows.length > 0;
};

module.exports = {
  ensureOperationalScopeShape,
  buildOperationalVisibilityFilter,
  canAccessProjectByOperationalScope,
};
