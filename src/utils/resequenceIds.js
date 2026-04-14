require('dotenv').config();
const { pool } = require('../config/database');
const { auditedTables, installAuditTriggers } = require('./installAuditTriggers');

const shouldApply = process.argv.includes('--apply');
const CHUNK_SIZE = 500;

const referenceMap = {
  users: [
    { table: 'employees', column: 'user_id' },
    { table: 'attendance', column: 'user_id' },
    { table: 'audit_logs', column: 'user_id' },
    { table: 'allowance_requests', column: 'requester_user_id' },
    { table: 'allowance_requests', column: 'responsible_user_id' },
    { table: 'allowance_requests', column: 'approver_user_id' },
    { table: 'project_allowances', column: 'leader_user_id' },
    { table: 'operational_role_assignments', column: 'user_id' },
    { table: 'projects', column: 'manager_id' },
    { table: 'evidence', column: 'uploaded_by' },
    { table: 'fleet_assignments', column: 'assigned_user_id' },
    { table: 'hse_corrective_actions', column: 'assigned_to' },
    { table: 'warehouse_movements', column: 'responsible_user_id' },
    { table: 'warehouse_movements', column: 'receiver_user_id' },
    { table: 'warehouse_asset_movements', column: 'responsible_user_id' },
    { table: 'warehouse_asset_movements', column: 'receiver_user_id' },
    { table: 'allowance_expenses', column: 'created_by' },
    { table: 'material_consumptions', column: 'created_by' },
  ],
  projects: [
    { table: 'activities', column: 'project_id' },
    { table: 'allowance_requests', column: 'project_id' },
    { table: 'attendance', column: 'project_id' },
    { table: 'budgets', column: 'project_id' },
    { table: 'evidence', column: 'project_id' },
    { table: 'expenses', column: 'project_id' },
    { table: 'fleet_assignments', column: 'project_id' },
    { table: 'hse_incidents', column: 'project_id' },
    { table: 'operational_role_assignments', column: 'project_id' },
    { table: 'project_allowances', column: 'project_id' },
    { table: 'project_collaborators', column: 'project_id' },
    { table: 'project_material_items', column: 'project_id' },
    { table: 'warehouse_movements', column: 'project_id' },
    { table: 'warehouse_asset_movements', column: 'project_id' },
  ],
  employees: [
    { table: 'activities', column: 'employee_id' },
    { table: 'attendance', column: 'employee_id' },
    { table: 'commercial_visits', column: 'employee_id' },
    { table: 'expenses', column: 'employee_id' },
    { table: 'hse_incidents', column: 'employee_id' },
    { table: 'hse_ppe', column: 'employee_id' },
    { table: 'hse_trainings', column: 'employee_id' },
    { table: 'labor_permissions', column: 'employee_id' },
    { table: 'project_collaborators', column: 'employee_id' },
  ],
  activities: [
    { table: 'evidence', column: 'activity_id' },
  ],
  project_allowances: [
    { table: 'allowance_expenses', column: 'allowance_id' },
  ],
  commercial_visits: [
    { table: 'commercial_forms', column: 'visit_id' },
  ],
  fleet: [
    { table: 'fleet_assignments', column: 'fleet_id' },
  ],
  hse_incidents: [
    { table: 'hse_corrective_actions', column: 'incident_id' },
  ],
  project_material_items: [
    { table: 'material_consumptions', column: 'material_item_id' },
  ],
  warehouse_materials: [
    { table: 'warehouse_movements', column: 'material_id' },
  ],
  warehouse_assets: [
    { table: 'warehouse_asset_movements', column: 'asset_id' },
  ],
};

const auditedEntityTypeByTable = new Map(
  auditedTables.map(({ tableName, entityType }) => [tableName, entityType])
);

function chunk(items, size) {
  const result = [];
  for (let index = 0; index < items.length; index += size) {
    result.push(items.slice(index, index + size));
  }
  return result;
}

async function fetchAutoIncrementTables(connection) {
  const [rows] = await connection.execute(
    `SELECT t.table_name AS tableName
     FROM information_schema.tables t
     INNER JOIN information_schema.columns c
       ON c.table_schema = t.table_schema
      AND c.table_name = t.table_name
     WHERE t.table_schema = DATABASE()
       AND t.table_type = 'BASE TABLE'
       AND c.column_name = 'id'
       AND c.extra LIKE '%auto_increment%'
     ORDER BY t.table_name ASC`
  );

  const tables = [];
  for (const row of rows) {
    const tableName = row.tableName;
    const [ids] = await connection.query(`SELECT id FROM \`${tableName}\` ORDER BY id ASC`);
    const maxId = ids.length ? Number(ids[ids.length - 1].id) : 0;
    const mappings = ids
      .map((item, index) => {
        const oldId = Number(item.id);
        const newId = index + 1;
        return {
          oldId,
          newId,
          tempId: maxId + ids.length + 1000000 + newId,
        };
      })
      .filter((item) => item.oldId !== item.newId);

    tables.push({
      tableName,
      rowCount: ids.length,
      maxId,
      nextId: ids.length + 1,
      gapCount: Math.max(maxId - ids.length, 0),
      mappings,
    });
  }

  return tables;
}

async function tableExists(connection, tableName) {
  const [rows] = await connection.execute(
    `SELECT COUNT(*) AS c
     FROM information_schema.tables
     WHERE table_schema = DATABASE() AND table_name = ?`,
    [tableName]
  );
  return Number(rows[0]?.c || 0) > 0;
}

async function dropAuditTriggers(connection) {
  for (const { tableName } of auditedTables) {
    await connection.query(`DROP TRIGGER IF EXISTS trg_${tableName}_audit_insert`);
    await connection.query(`DROP TRIGGER IF EXISTS trg_${tableName}_audit_update`);
    await connection.query(`DROP TRIGGER IF EXISTS trg_${tableName}_audit_delete`);
  }
}

async function updateColumnWithMappings(connection, tableName, columnName, mappings, fromKey, toKey, extraWhere = '', extraParams = []) {
  if (!mappings.length) return 0;

  let affectedRows = 0;
  for (const group of chunk(mappings, CHUNK_SIZE)) {
    const whenParams = [];
    const inParams = [];
    for (const mapping of group) {
      whenParams.push(mapping[fromKey], mapping[toKey]);
      inParams.push(mapping[fromKey]);
    }

    const whereClause = extraWhere ? ` AND ${extraWhere}` : '';
    const [result] = await connection.execute(
      `UPDATE \`${tableName}\`
       SET \`${columnName}\` = CASE \`${columnName}\`
         ${group.map(() => 'WHEN ? THEN ?').join(' ')}
         ELSE \`${columnName}\`
       END
       WHERE \`${columnName}\` IN (${group.map(() => '?').join(',')})${whereClause}`,
      [...whenParams, ...inParams, ...extraParams]
    );

    affectedRows += result.affectedRows || 0;
  }

  return affectedRows;
}

async function updateAuditEntityIds(connection, tableName, mappings, fromKey, toKey) {
  if (!(await tableExists(connection, 'audit_logs'))) return 0;

  const entityType = auditedEntityTypeByTable.get(tableName);
  if (!entityType || !mappings.length) return 0;

  return updateColumnWithMappings(
    connection,
    'audit_logs',
    'entity_id',
    mappings,
    fromKey,
    toKey,
    'entity_type = ?',
    [entityType]
  );
}

async function applyPhase(connection, tables, fromKey, toKey) {
  const summary = [];

  for (const table of tables) {
    if (!table.mappings.length) continue;

    const result = { table: table.tableName, updatedIds: 0, updatedRefs: 0, updatedAuditEntityIds: 0 };
    result.updatedIds = await updateColumnWithMappings(connection, table.tableName, 'id', table.mappings, fromKey, toKey);

    for (const reference of referenceMap[table.tableName] || []) {
      if (!(await tableExists(connection, reference.table))) continue;
      result.updatedRefs += await updateColumnWithMappings(
        connection,
        reference.table,
        reference.column,
        table.mappings,
        fromKey,
        toKey
      );
    }

    result.updatedAuditEntityIds = await updateAuditEntityIds(connection, table.tableName, table.mappings, fromKey, toKey);
    summary.push(result);
  }

  return summary;
}

async function applyReset(connection, tables) {
  for (const table of tables) {
    await connection.query(`ALTER TABLE \`${table.tableName}\` AUTO_INCREMENT = ${Math.max(table.nextId, 1)}`);
  }
}

function buildPreview(tables) {
  return tables.map((table) => ({
    tableName: table.tableName,
    rowCount: table.rowCount,
    maxId: table.maxId,
    gapCount: table.gapCount,
    willChange: table.mappings.length,
    sample: table.mappings.slice(0, 10).map((mapping) => `${mapping.oldId}->${mapping.newId}`),
    nextId: table.nextId,
  }));
}

async function main() {
  const connection = await pool.getConnection();
  let triggersDropped = false;

  try {
    const tables = await fetchAutoIncrementTables(connection);
    const preview = buildPreview(tables);

    console.log('=== Resequencia de IDs (preview) ===');
    console.log(JSON.stringify(preview, null, 2));

    if (!shouldApply) {
      console.log('\nModo simulación. Para aplicar cambios: npm run resequence:ids -- --apply');
      return;
    }

    await dropAuditTriggers(connection);
    triggersDropped = true;
    await connection.query('SET FOREIGN_KEY_CHECKS = 0');
    await connection.beginTransaction();

    try {
      const tempPhase = await applyPhase(connection, tables, 'oldId', 'tempId');
      const finalPhase = await applyPhase(connection, tables, 'tempId', 'newId');
      await applyReset(connection, tables);
      await connection.commit();

      console.log('\n✅ IDs resecuenciados correctamente.');
      console.log(JSON.stringify({ tempPhase, finalPhase }, null, 2));
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      await connection.query('SET FOREIGN_KEY_CHECKS = 1');
    }

    await installAuditTriggers({ connection });
    triggersDropped = false;
  } catch (error) {
    console.error('❌ Error resecuenciando IDs:', error.message);
    process.exitCode = 1;
  } finally {
    if (triggersDropped) {
      try {
        await installAuditTriggers({ connection });
      } catch (error) {
        console.error('❌ Error reinstalando triggers de auditoría:', error.message);
        process.exitCode = 1;
      }
    }

    connection.release();
    await pool.end();
  }
}

main();