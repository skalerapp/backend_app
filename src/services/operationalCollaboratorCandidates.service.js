const { normalizeRole } = require('../middleware/auth.middleware');
const { ensureOperationalScopeShape } = require('../modules/operationalScopes/operationalScopes.service');

const normalizeEmployeeStatus = (statusValue) => (statusValue || '').toString().trim().toLowerCase();

const employeeSelect = `
  SELECT DISTINCT
    e.*,
    e.employee_name AS name,
    u.name AS app_user_name,
    u.email AS app_user_email,
    u.email AS email
`;

const employeeOrder = `
  ORDER BY COALESCE(e.employee_name, u.name, CONCAT('Colaborador #', e.id))
`;

const canSelectAnyActiveEmployee = (normalizedRole) => {
  return (
    normalizedRole === 'super_admin' ||
    normalizedRole === 'administrative' ||
    normalizedRole === 'coordinator_operations' ||
    normalizedRole === 'gerencial'
  );
};

const listOperationalCollaboratorCandidates = async (connection, { userId, role, includeEmployeeId = null }) => {
  await ensureOperationalScopeShape(connection);

  const normalizedRole = normalizeRole(role);

  if (canSelectAnyActiveEmployee(normalizedRole)) {
    const params = [];
    let statusClause = "LOWER(COALESCE(e.status, 'active')) = 'active'";
    if (includeEmployeeId) {
      statusClause = `(${statusClause} OR e.id = ?)`;
      params.push(includeEmployeeId);
    }

    const [result] = await connection.execute(
      `${employeeSelect}
       FROM employees e
       LEFT JOIN users u ON e.user_id = u.id
       WHERE ${statusClause}
       ${employeeOrder}`,
      params
    );

    return result;
  }

  if (normalizedRole === 'leader') {
    const params = [userId, userId, userId];
    let includeClause = '';
    if (includeEmployeeId) {
      includeClause = ' OR e.id = ?';
      params.push(includeEmployeeId);
    }

    const [result] = await connection.execute(
      `${employeeSelect}
       FROM employees e
       LEFT JOIN users u ON e.user_id = u.id
       LEFT JOIN project_collaborators pc ON pc.employee_id = e.id
       LEFT JOIN projects p ON p.id = pc.project_id
       WHERE (
         (e.user_id = ? AND LOWER(COALESCE(e.status, 'active')) = 'active')
         OR (
           LOWER(COALESCE(e.status, 'active')) = 'active'
           AND pc.id IS NOT NULL
           AND (
             p.manager_id = ?
             OR EXISTS (
               SELECT 1
               FROM operational_role_assignments ora
               WHERE ora.project_id = p.id
                 AND ora.user_id = ?
                 AND ora.role_scope = 'leader'
                 AND ora.is_active = 1
             )
           )
         )
         ${includeClause}
       )
       ${employeeOrder}`,
      params
    );

    return result;
  }

  if (normalizedRole === 'supervisor') {
    const params = [userId, userId];
    let includeClause = '';
    if (includeEmployeeId) {
      includeClause = ' OR e.id = ?';
      params.push(includeEmployeeId);
    }

    const [result] = await connection.execute(
      `${employeeSelect}
       FROM employees e
       LEFT JOIN users u ON e.user_id = u.id
       LEFT JOIN project_collaborators pc ON pc.employee_id = e.id
       LEFT JOIN projects p ON p.id = pc.project_id
       WHERE (
         (e.user_id = ? AND LOWER(COALESCE(e.status, 'active')) = 'active')
         OR (
           LOWER(COALESCE(e.status, 'active')) = 'active'
           AND pc.id IS NOT NULL
           AND EXISTS (
             SELECT 1
             FROM operational_role_assignments ora
             WHERE ora.project_id = p.id
               AND ora.user_id = ?
               AND ora.role_scope = 'supervisor'
               AND ora.is_active = 1
           )
         )
         ${includeClause}
       )
       ${employeeOrder}`,
      params
    );

    return result;
  }

  const params = [userId];
  if (includeEmployeeId) {
    params.push(includeEmployeeId);
    const [result] = await connection.execute(
      `${employeeSelect}
       FROM employees e
       LEFT JOIN users u ON e.user_id = u.id
       WHERE e.user_id = ? OR e.id = ?
       ${employeeOrder}`,
      params
    );

    return result.filter((row) => {
      if (includeEmployeeId && Number(row.id) === Number(includeEmployeeId)) {
        return true;
      }
      return normalizeEmployeeStatus(row.status) === 'active';
    });
  }

  const [result] = await connection.execute(
    `${employeeSelect}
     FROM employees e
     LEFT JOIN users u ON e.user_id = u.id
     WHERE e.user_id = ?
       AND LOWER(COALESCE(e.status, 'active')) = 'active'
     LIMIT 1`,
    params
  );

  return result;
};

const canAssignEmployeeInOperationalScope = async (connection, { userId, role, employeeId }) => {
  const normalizedRole = normalizeRole(role);

  if (canSelectAnyActiveEmployee(normalizedRole)) {
    return true;
  }

  const [ownRows] = await connection.execute(
    'SELECT id FROM employees WHERE user_id = ? LIMIT 1',
    [userId]
  );
  const ownEmployeeId = ownRows[0]?.id ?? null;
  if (ownEmployeeId != null && Number(ownEmployeeId) === Number(employeeId)) {
    return true;
  }

  if (normalizedRole !== 'leader' && normalizedRole !== 'supervisor') {
    return false;
  }

  const candidates = await listOperationalCollaboratorCandidates(connection, {
    userId,
    role: normalizedRole,
    includeEmployeeId: employeeId,
  });

  return candidates.some((row) => Number(row.id) === Number(employeeId));
};

module.exports = {
  canSelectAnyActiveEmployee,
  listOperationalCollaboratorCandidates,
  canAssignEmployeeInOperationalScope,
};
