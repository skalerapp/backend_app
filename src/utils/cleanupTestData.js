require('dotenv').config();
const fs = require('fs/promises');
const path = require('path');
const { pool } = require('../config/database');

const shouldApply = process.argv.includes('--apply');

const TEST_USER_WHERE = `
  (
    LOWER(email) REGEXP '^(leader|supervisor|employee1|employee2)\\\\.rbac\\\\.[0-9]+@skaler\\\\.com$'
    OR name REGEXP '(Leader|Supervisor|Employee1|Employee2) RBAC [0-9]+'
    OR LOWER(email) REGEXP '^(test|demo|prueba)([._-]|[0-9]).+@'
    OR name REGEXP '^(Usuario|User|Demo|Prueba|Test)( de)? (Prueba|Demo|Test)( [0-9]+)?$'
    OR LOWER(email) REGEXP '^(leader|supervisor)\\.(scope|audit|attendance|materials|allowances|activities)\\.[0-9]+@skaler\\.com$'
    OR LOWER(email) REGEXP '^employee(\\.activities)?\\.(scope|hidden)\\.[0-9]+@skaler\\.com$'
    OR LOWER(email) REGEXP '^(administrative\\.users|administrative\\.allowance|app\\.user|user\\.audit|leader\\.request|coordinator\\.request)\\.[0-9]+@skaler\\.com$'
    OR name REGEXP '^(Leader|Supervisor|Employee|Administrative|Usuario|Coordinator) (Scope|Audit|Attendance|Materials|Allowances|Activities|Users|App|Activity Scope|Activity Hidden|Allowance Request|Allowance Approval)( Editado)? [0-9]+$'
  )
  AND LOWER(email) <> 'admin@skaler.com'
`;

const TEST_PROJECT_WHERE = `
  (
    LOWER(name) IN ('test', 'demo', 'prueba')
    OR LOWER(name) = 'test project'
    OR name REGEXP '^Proyecto Test( [0-9]+)? [0-9]{10,}$'
    OR name REGEXP '^Proyecto Leader [0-9]+$'
    OR name REGEXP '^Proyecto General [0-9]+$'
    OR name REGEXP '^(Proyecto|Project) (Test|Demo|Prueba)( .*)?$'
    OR name REGEXP '^Proyecto (Viaticos|Viaticos Cerrado|Materiales|Evidencia API|Bloqueado|Scope|Scope Activity|Hidden Activity|Scope Attendance|Hidden Attendance|Alcance Viaticos|Sin Alcance Viaticos|Alcance Material|Sin Alcance Material)( [0-9]+)?$'
  )
`;

const TEST_EMPLOYEE_WHERE = `
  (
    (employee_name IS NULL AND identification_number IS NULL AND user_id IS NULL)
    OR employee_name REGEXP '^Colaborador Proyecto Test$'
    OR employee_name REGEXP '^Colaborador (Uno|Dos) [0-9]+$'
    OR employee_name REGEXP '^Colaborador (Test|Demo|Prueba)( .*)?$'
    OR employee_name REGEXP '^Colaborador (Hidden|Scope|Activity Hidden|Activity Scope) [0-9]+$'
    OR identification_number REGEXP '^PT-[0-9]+$'
    OR identification_number REGEXP '^CC-[0-9]+-[12]$'
    OR identification_number REGEXP '^(TEST|DEMO|PRUEBA|PR)-[0-9]+$'
    OR identification_number REGEXP '^(ATT|ACT)-[0-9]+-[12]$'
  )
`;

const TEST_ACTIVITY_WHERE = `
  (
    description IN ('Initial test activity', 'Actividad inicial RBAC', 'Actividad activa de prueba')
    OR description LIKE '%test activity%'
    OR description REGEXP '(actividad|activity) (test|demo|prueba)'
    OR description LIKE '%RBAC%'
    OR description LIKE '%scope%'
    OR description LIKE '%hidden%'
  )
`;

async function tableExists(connection, tableName) {
  const [rows] = await connection.execute(
    `SELECT COUNT(*) AS c
     FROM information_schema.tables
     WHERE table_schema = DATABASE() AND table_name = ?`,
    [tableName]
  );
  return Number(rows[0]?.c || 0) > 0;
}

function uniqNumbers(items) {
  return [...new Set((items || []).map((v) => Number(v)).filter((v) => Number.isInteger(v) && v > 0))];
}

function placeholders(ids) {
  return ids.map(() => '?').join(',');
}

async function deleteByIds(connection, table, column, ids) {
  const cleanIds = uniqNumbers(ids);
  if (!cleanIds.length) return 0;
  const [result] = await connection.execute(
    `DELETE FROM ${table} WHERE ${column} IN (${placeholders(cleanIds)})`,
    cleanIds
  );
  return result.affectedRows || 0;
}

async function deleteFiles(filePaths) {
  let deleted = 0;
  for (const relativeFilePath of filePaths || []) {
    if (!relativeFilePath) continue;
    const absolutePath = path.resolve(__dirname, '..', relativeFilePath);
    try {
      await fs.unlink(absolutePath);
      deleted += 1;
    } catch (error) {
      if (error.code !== 'ENOENT') {
        console.warn(`No se pudo eliminar archivo huérfano: ${absolutePath} (${error.message})`);
      }
    }
  }
  return deleted;
}

async function fetchTestCandidates(connection) {
  const [users] = await connection.execute(
    `SELECT id, email, name FROM users WHERE ${TEST_USER_WHERE} ORDER BY id ASC`
  );

  const [projects] = await connection.execute(
    `SELECT id, name FROM projects WHERE ${TEST_PROJECT_WHERE} ORDER BY id ASC`
  );

  const [employeesByPattern] = await connection.execute(
    `SELECT id, user_id, employee_name, identification_number
     FROM employees
     WHERE ${TEST_EMPLOYEE_WHERE}
     ORDER BY id ASC`
  );

  const userIds = uniqNumbers(users.map((u) => u.id));
  let employeesByUser = [];
  if (userIds.length) {
    const [rows] = await connection.execute(
      `SELECT id, user_id, employee_name, identification_number
       FROM employees
       WHERE user_id IN (${placeholders(userIds)})
       ORDER BY id ASC`,
      userIds
    );
    employeesByUser = rows;
  }

  const employees = uniqNumbers([...employeesByPattern, ...employeesByUser].map((e) => e.id));

  const [activitiesByPattern] = await connection.execute(
    `SELECT id, project_id, employee_id, description
     FROM activities
     WHERE ${TEST_ACTIVITY_WHERE}
     ORDER BY id ASC`
  );

  const projectIds = uniqNumbers(projects.map((p) => p.id));
  let activitiesByRelations = [];
  if (projectIds.length || employees.length) {
    const conditions = [];
    const params = [];
    if (projectIds.length) {
      conditions.push(`project_id IN (${placeholders(projectIds)})`);
      params.push(...projectIds);
    }
    if (employees.length) {
      conditions.push(`employee_id IN (${placeholders(employees)})`);
      params.push(...employees);
    }
    const [rows] = await connection.execute(
      `SELECT id, project_id, employee_id, description
       FROM activities
       WHERE ${conditions.join(' OR ')}
       ORDER BY id ASC`,
      params
    );
    activitiesByRelations = rows;
  }

  const activityIds = uniqNumbers([...activitiesByPattern, ...activitiesByRelations].map((a) => a.id));

  const [attendanceByPhoto] = await connection.execute(
    `SELECT id FROM attendance WHERE photo_path LIKE 'uploads/test-attendance%' ORDER BY id ASC`
  );

  let attendanceByRelations = [];
  if (projectIds.length || employees.length || userIds.length) {
    const conditions = [];
    const params = [];
    if (projectIds.length) {
      conditions.push(`project_id IN (${placeholders(projectIds)})`);
      params.push(...projectIds);
    }
    if (employees.length) {
      conditions.push(`employee_id IN (${placeholders(employees)})`);
      params.push(...employees);
    }
    if (userIds.length) {
      conditions.push(`user_id IN (${placeholders(userIds)})`);
      params.push(...userIds);
    }

    const [rows] = await connection.execute(
      `SELECT id FROM attendance WHERE ${conditions.join(' OR ')} ORDER BY id ASC`,
      params
    );
    attendanceByRelations = rows;
  }

  const attendanceIds = uniqNumbers([...attendanceByPhoto, ...attendanceByRelations].map((a) => a.id));

  const orphanProjectAllowanceIds = (await tableExists(connection, 'project_allowances'))
    ? uniqNumbers((await connection.execute(
      `SELECT pa.id
       FROM project_allowances pa
       LEFT JOIN projects p ON p.id = pa.project_id
       LEFT JOIN users u ON u.id = pa.leader_user_id
       WHERE p.id IS NULL
          OR (pa.leader_user_id IS NOT NULL AND u.id IS NULL)
       ORDER BY pa.id ASC`
    ))[0].map((row) => row.id))
    : [];

  const orphanAllowanceExpenseIds = (await tableExists(connection, 'allowance_expenses'))
    ? uniqNumbers((await connection.execute(
      `SELECT ae.id
       FROM allowance_expenses ae
       LEFT JOIN project_allowances pa ON pa.id = ae.allowance_id
       LEFT JOIN users u ON u.id = ae.created_by
       WHERE pa.id IS NULL
          OR (ae.created_by IS NOT NULL AND u.id IS NULL)
       ORDER BY ae.id ASC`
    ))[0].map((row) => row.id))
    : [];

  const orphanAllowanceRequestIds = (await tableExists(connection, 'allowance_requests'))
    ? uniqNumbers((await connection.execute(
      `SELECT ar.id
       FROM allowance_requests ar
       LEFT JOIN projects p ON p.id = ar.project_id
       LEFT JOIN users requester ON requester.id = ar.requester_user_id
       LEFT JOIN users responsible ON responsible.id = ar.responsible_user_id
       LEFT JOIN users approver ON approver.id = ar.approver_user_id
       WHERE p.id IS NULL
          OR requester.id IS NULL
          OR (ar.responsible_user_id IS NOT NULL AND responsible.id IS NULL)
          OR (ar.approver_user_id IS NOT NULL AND approver.id IS NULL)
       ORDER BY ar.id ASC`
    ))[0].map((row) => row.id))
    : [];

  const orphanProjectCollaboratorIds = (await tableExists(connection, 'project_collaborators'))
    ? uniqNumbers((await connection.execute(
      `SELECT pc.id
       FROM project_collaborators pc
       LEFT JOIN projects p ON p.id = pc.project_id
       LEFT JOIN employees e ON e.id = pc.employee_id
       WHERE p.id IS NULL OR e.id IS NULL
       ORDER BY pc.id ASC`
    ))[0].map((row) => row.id))
    : [];

  const orphanEvidenceRows = (await tableExists(connection, 'evidence'))
    ? (await connection.execute(
      `SELECT e.id, e.file_path
       FROM evidence e
       LEFT JOIN activities a ON a.id = e.activity_id
       LEFT JOIN projects p ON p.id = e.project_id
       LEFT JOIN users u ON u.id = e.uploaded_by
       WHERE (e.activity_id IS NOT NULL AND a.id IS NULL)
          OR (e.project_id IS NOT NULL AND p.id IS NULL)
          OR (e.uploaded_by IS NOT NULL AND u.id IS NULL)
       ORDER BY e.id ASC`
    ))[0]
    : [];

  const orphanEvidenceIds = uniqNumbers(orphanEvidenceRows.map((row) => row.id));
  const orphanEvidencePaths = [...new Set(orphanEvidenceRows.map((row) => row.file_path).filter(Boolean))];

  return {
    users,
    projects,
    employees,
    activityIds,
    attendanceIds,
    orphanProjectAllowanceIds,
    orphanAllowanceExpenseIds,
    orphanAllowanceRequestIds,
    orphanProjectCollaboratorIds,
    orphanEvidenceIds,
    orphanEvidencePaths,
  };
}

async function applyCleanup(connection, candidate) {
  const summary = {};
  const projectIds = uniqNumbers(candidate.projects.map((p) => p.id));
  const userIds = uniqNumbers(candidate.users.map((u) => u.id));
  const employeeIds = uniqNumbers(candidate.employees);
  const activityIds = uniqNumbers(candidate.activityIds);
  const attendanceIds = uniqNumbers(candidate.attendanceIds);
  const orphanProjectAllowanceIds = uniqNumbers(candidate.orphanProjectAllowanceIds);
  const orphanAllowanceExpenseIds = uniqNumbers(candidate.orphanAllowanceExpenseIds);
  const orphanAllowanceRequestIds = uniqNumbers(candidate.orphanAllowanceRequestIds);
  const orphanProjectCollaboratorIds = uniqNumbers(candidate.orphanProjectCollaboratorIds);
  const orphanEvidenceIds = uniqNumbers(candidate.orphanEvidenceIds);
  const orphanEvidencePaths = [...new Set(candidate.orphanEvidencePaths || [])];
  let deletedEvidenceFiles = 0;

  await connection.beginTransaction();
  try {
    if (await tableExists(connection, 'allowance_expenses') && await tableExists(connection, 'project_allowances')) {
      let removedByOrphanAllowance = 0;
      if (projectIds.length) {
        const [allowanceRows] = await connection.execute(
          `SELECT id FROM project_allowances WHERE project_id IN (${placeholders(projectIds)})`,
          projectIds
        );
        const allowanceIds = uniqNumbers(allowanceRows.map((r) => r.id));
        removedByOrphanAllowance = allowanceIds.length
          ? await deleteByIds(connection, 'allowance_expenses', 'allowance_id', allowanceIds)
          : 0;
      }

      const removedByOrphanExpenseId = orphanAllowanceExpenseIds.length
        ? await deleteByIds(connection, 'allowance_expenses', 'id', orphanAllowanceExpenseIds)
        : 0;

      summary.allowance_expenses = removedByOrphanAllowance + removedByOrphanExpenseId;
    } else if (await tableExists(connection, 'allowance_expenses')) {
      summary.allowance_expenses = orphanAllowanceExpenseIds.length
        ? await deleteByIds(connection, 'allowance_expenses', 'id', orphanAllowanceExpenseIds)
        : 0;
    }

    if (await tableExists(connection, 'project_allowances')) {
      const removedByProject = projectIds.length
        ? await deleteByIds(connection, 'project_allowances', 'project_id', projectIds)
        : 0;
      const removedOrphans = orphanProjectAllowanceIds.length
        ? await deleteByIds(connection, 'project_allowances', 'id', orphanProjectAllowanceIds)
        : 0;
      summary.project_allowances = removedByProject + removedOrphans;
    }

    if (await tableExists(connection, 'allowance_requests')) {
      summary.allowance_requests = orphanAllowanceRequestIds.length
        ? await deleteByIds(connection, 'allowance_requests', 'id', orphanAllowanceRequestIds)
        : 0;
    }

    if (await tableExists(connection, 'material_consumptions') && await tableExists(connection, 'project_material_items')) {
      if (projectIds.length) {
        const [itemRows] = await connection.execute(
          `SELECT id FROM project_material_items WHERE project_id IN (${placeholders(projectIds)})`,
          projectIds
        );
        const itemIds = uniqNumbers(itemRows.map((r) => r.id));
        summary.material_consumptions = itemIds.length
          ? await deleteByIds(connection, 'material_consumptions', 'material_item_id', itemIds)
          : 0;
      } else {
        summary.material_consumptions = 0;
      }
    }

    if (await tableExists(connection, 'project_material_items')) {
      summary.project_material_items = projectIds.length
        ? await deleteByIds(connection, 'project_material_items', 'project_id', projectIds)
        : 0;
    }

    if (await tableExists(connection, 'operational_role_assignments')) {
      let removedByProject = 0;
      let removedByUser = 0;
      if (projectIds.length) {
        removedByProject = await deleteByIds(connection, 'operational_role_assignments', 'project_id', projectIds);
      }
      if (userIds.length) {
        removedByUser = await deleteByIds(connection, 'operational_role_assignments', 'user_id', userIds);
      }
      summary.operational_role_assignments = removedByProject + removedByUser;
    }

    if (await tableExists(connection, 'labor_permissions')) {
      summary.labor_permissions = employeeIds.length
        ? await deleteByIds(connection, 'labor_permissions', 'employee_id', employeeIds)
        : 0;
    }

    if (await tableExists(connection, 'attendance')) {
      summary.attendance = attendanceIds.length
        ? await deleteByIds(connection, 'attendance', 'id', attendanceIds)
        : 0;
    }

    if (await tableExists(connection, 'activities')) {
      summary.activities = activityIds.length
        ? await deleteByIds(connection, 'activities', 'id', activityIds)
        : 0;
    }

    if (await tableExists(connection, 'project_collaborators')) {
      let removedByProject = 0;
      let removedByEmployee = 0;
      let removedOrphans = 0;
      if (projectIds.length) {
        removedByProject = await deleteByIds(connection, 'project_collaborators', 'project_id', projectIds);
      }
      if (employeeIds.length) {
        removedByEmployee = await deleteByIds(connection, 'project_collaborators', 'employee_id', employeeIds);
      }
      if (orphanProjectCollaboratorIds.length) {
        removedOrphans = await deleteByIds(connection, 'project_collaborators', 'id', orphanProjectCollaboratorIds);
      }
      summary.project_collaborators = removedByProject + removedByEmployee + removedOrphans;
    }

    if (await tableExists(connection, 'evidence')) {
      summary.evidence = orphanEvidenceIds.length
        ? await deleteByIds(connection, 'evidence', 'id', orphanEvidenceIds)
        : 0;
    }

    if (await tableExists(connection, 'audit_logs')) {
      let removed = 0;

      if (userIds.length) {
        removed += await deleteByIds(connection, 'audit_logs', 'user_id', userIds);
      }

      if (projectIds.length) {
        const [result] = await connection.execute(
          `DELETE FROM audit_logs
           WHERE entity_type = 'projects'
             AND entity_id IN (${placeholders(projectIds)})`,
          projectIds
        );
        removed += result.affectedRows || 0;
      }

      if (employeeIds.length) {
        const [result] = await connection.execute(
          `DELETE FROM audit_logs
           WHERE entity_type = 'employees'
             AND entity_id IN (${placeholders(employeeIds)})`,
          employeeIds
        );
        removed += result.affectedRows || 0;
      }

      if (activityIds.length) {
        const [result] = await connection.execute(
          `DELETE FROM audit_logs
           WHERE entity_type = 'activities'
             AND entity_id IN (${placeholders(activityIds)})`,
          activityIds
        );
        removed += result.affectedRows || 0;
      }

      if (attendanceIds.length) {
        const [result] = await connection.execute(
          `DELETE FROM audit_logs
           WHERE entity_type = 'attendance'
             AND entity_id IN (${placeholders(attendanceIds)})`,
          attendanceIds
        );
        removed += result.affectedRows || 0;
      }

      if (orphanProjectAllowanceIds.length) {
        const [result] = await connection.execute(
          `DELETE FROM audit_logs
           WHERE entity_type = 'project_allowances'
             AND entity_id IN (${placeholders(orphanProjectAllowanceIds)})`,
          orphanProjectAllowanceIds
        );
        removed += result.affectedRows || 0;
      }

      if (orphanAllowanceExpenseIds.length) {
        const [result] = await connection.execute(
          `DELETE FROM audit_logs
           WHERE entity_type = 'allowance_expenses'
             AND entity_id IN (${placeholders(orphanAllowanceExpenseIds)})`,
          orphanAllowanceExpenseIds
        );
        removed += result.affectedRows || 0;
      }

      if (orphanAllowanceRequestIds.length) {
        const [result] = await connection.execute(
          `DELETE FROM audit_logs
           WHERE entity_type = 'allowance_requests'
             AND entity_id IN (${placeholders(orphanAllowanceRequestIds)})`,
          orphanAllowanceRequestIds
        );
        removed += result.affectedRows || 0;
      }

      if (orphanProjectCollaboratorIds.length) {
        const [result] = await connection.execute(
          `DELETE FROM audit_logs
           WHERE entity_type = 'project_collaborators'
             AND entity_id IN (${placeholders(orphanProjectCollaboratorIds)})`,
          orphanProjectCollaboratorIds
        );
        removed += result.affectedRows || 0;
      }

      if (orphanEvidenceIds.length) {
        const [result] = await connection.execute(
          `DELETE FROM audit_logs
           WHERE entity_type = 'evidence'
             AND entity_id IN (${placeholders(orphanEvidenceIds)})`,
          orphanEvidenceIds
        );
        removed += result.affectedRows || 0;
      }

      summary.audit_logs = removed;
    }

    if (await tableExists(connection, 'employees')) {
      summary.employees = employeeIds.length
        ? await deleteByIds(connection, 'employees', 'id', employeeIds)
        : 0;
    }

    if (await tableExists(connection, 'projects')) {
      summary.projects = projectIds.length
        ? await deleteByIds(connection, 'projects', 'id', projectIds)
        : 0;
    }

    if (await tableExists(connection, 'users')) {
      summary.users = userIds.length
        ? await deleteByIds(connection, 'users', 'id', userIds)
        : 0;
    }

    await connection.commit();
    deletedEvidenceFiles = await deleteFiles(orphanEvidencePaths);
    summary.evidence_files = deletedEvidenceFiles;
    return summary;
  } catch (error) {
    await connection.rollback();
    throw error;
  }
}

async function main() {
  const connection = await pool.getConnection();
  try {
    const candidate = await fetchTestCandidates(connection);

    const overview = {
      users: candidate.users.length,
      projects: candidate.projects.length,
      employees: candidate.employees.length,
      activities: candidate.activityIds.length,
      attendance: candidate.attendanceIds.length,
      orphan_project_allowances: candidate.orphanProjectAllowanceIds.length,
      orphan_allowance_expenses: candidate.orphanAllowanceExpenseIds.length,
      orphan_allowance_requests: candidate.orphanAllowanceRequestIds.length,
      orphan_project_collaborators: candidate.orphanProjectCollaboratorIds.length,
      orphan_evidence: candidate.orphanEvidenceIds.length,
    };

    console.log('=== Limpieza de datos de prueba (preview) ===');
    console.log(JSON.stringify(overview, null, 2));

    if (candidate.users.length) {
      console.log('\nUsuarios de test detectados:');
      for (const u of candidate.users) console.log(`- [${u.id}] ${u.email} | ${u.name}`);
    }

    if (candidate.projects.length) {
      console.log('\nProyectos de test detectados:');
      for (const p of candidate.projects) console.log(`- [${p.id}] ${p.name}`);
    }

    if (!shouldApply) {
      console.log('\nModo simulación. Para aplicar cambios: npm run cleanup:test-data -- --apply');
      return;
    }

    const result = await applyCleanup(connection, candidate);
    console.log('\n✅ Limpieza aplicada. Filas eliminadas por tabla:');
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    console.error('❌ Error limpiando datos de prueba:', error.message);
    process.exitCode = 1;
  } finally {
    connection.release();
    await pool.end();
  }
}

main();
