const { pool } = require('../config/database');
const { ensureWarehouseShape } = require('../modules/warehouse/warehouse.service');

const auditedTables = [
  {
    tableName: 'users',
    entityType: 'users',
    columns: ['id', 'email', 'name', 'role', 'status', 'created_at', 'updated_at'],
    changedColumns: ['email', 'password', 'name', 'role', 'status'],
  },
  {
    tableName: 'projects',
    entityType: 'projects',
    columns: ['id', 'name', 'description', 'budget', 'start_date', 'end_date', 'actual_end_date', 'manager_id', 'status', 'ot_code', 'created_at', 'updated_at'],
    changedColumns: ['name', 'description', 'budget', 'start_date', 'end_date', 'actual_end_date', 'manager_id', 'status', 'ot_code'],
  },
  {
    tableName: 'employees',
    entityType: 'employees',
    columns: ['id', 'user_id', 'employee_name', 'identification_number', 'position', 'department', 'salary', 'hire_date', 'status', 'created_at', 'updated_at'],
    changedColumns: ['user_id', 'employee_name', 'identification_number', 'position', 'department', 'salary', 'hire_date', 'status'],
  },
  {
    tableName: 'activities',
    entityType: 'activities',
    columns: ['id', 'project_id', 'employee_id', 'title', 'description', 'date', 'activity_date', 'start_time', 'end_time', 'hours_worked', 'evidences', 'status', 'created_at', 'updated_at'],
    changedColumns: ['project_id', 'employee_id', 'title', 'description', 'date', 'activity_date', 'start_time', 'end_time', 'hours_worked', 'evidences', 'status'],
  },
  {
    tableName: 'labor_permissions',
    entityType: 'labor_permissions',
    columns: ['id', 'employee_id', 'permission_type', 'start_date', 'end_date', 'reason', 'status', 'created_at', 'updated_at'],
    changedColumns: ['employee_id', 'permission_type', 'start_date', 'end_date', 'reason', 'status'],
  },
  {
    tableName: 'attendance',
    entityType: 'attendance',
    columns: ['id', 'employee_id', 'user_id', 'project_id', 'check_in', 'check_out', 'location_latitude', 'location_longitude', 'photo_path', 'checkout_location_latitude', 'checkout_location_longitude', 'checkout_photo_path', 'attendance_date', 'created_at', 'updated_at'],
    changedColumns: ['employee_id', 'user_id', 'project_id', 'check_in', 'check_out', 'location_latitude', 'location_longitude', 'photo_path', 'checkout_location_latitude', 'checkout_location_longitude', 'checkout_photo_path', 'attendance_date'],
  },
  {
    tableName: 'project_collaborators',
    entityType: 'project_collaborators',
    columns: ['id', 'project_id', 'employee_id', 'created_at'],
    changedColumns: ['project_id', 'employee_id'],
  },
  {
    tableName: 'project_allowances',
    entityType: 'project_allowances',
    columns: ['id', 'project_id', 'leader_user_id', 'assigned_amount', 'created_at', 'updated_at'],
    changedColumns: ['project_id', 'leader_user_id', 'assigned_amount'],
  },
  {
    tableName: 'allowance_expenses',
    entityType: 'allowance_expenses',
    columns: ['id', 'allowance_id', 'amount', 'expense_date', 'notes', 'evidence_path', 'created_by', 'created_at'],
    changedColumns: ['allowance_id', 'amount', 'expense_date', 'notes', 'evidence_path', 'created_by'],
  },
  {
    tableName: 'allowance_requests',
    entityType: 'allowance_requests',
    columns: ['id', 'project_id', 'requester_user_id', 'responsible_user_id', 'approver_user_id', 'status', 'center_cost', 'work_order', 'client_name', 'activity_name', 'city', 'personnel_count', 'departure_date', 'return_date', 'outbound_route', 'return_route', 'transport_type', 'vehicle_required', 'vehicle_brand', 'vehicle_model', 'vehicle_plate', 'budget_transport', 'budget_local_transport', 'budget_lodging', 'budget_meals', 'budget_tolls', 'budget_fuel', 'budget_other', 'other_budget_label', 'total_requested', 'notes', 'decision_notes', 'decided_at', 'created_at', 'updated_at'],
    changedColumns: ['project_id', 'requester_user_id', 'responsible_user_id', 'approver_user_id', 'status', 'center_cost', 'work_order', 'client_name', 'activity_name', 'city', 'personnel_count', 'departure_date', 'return_date', 'outbound_route', 'return_route', 'transport_type', 'vehicle_required', 'vehicle_brand', 'vehicle_model', 'vehicle_plate', 'budget_transport', 'budget_local_transport', 'budget_lodging', 'budget_meals', 'budget_tolls', 'budget_fuel', 'budget_other', 'other_budget_label', 'total_requested', 'notes', 'decision_notes', 'decided_at'],
  },
  {
    tableName: 'project_material_items',
    entityType: 'project_material_items',
    columns: ['id', 'project_id', 'material_name', 'unit', 'assigned_quantity', 'unit_cost', 'created_at', 'updated_at'],
    changedColumns: ['project_id', 'material_name', 'unit', 'assigned_quantity', 'unit_cost'],
  },
  {
    tableName: 'material_consumptions',
    entityType: 'material_consumptions',
    columns: ['id', 'material_item_id', 'consumed_quantity', 'consumption_date', 'notes', 'evidence_path', 'created_by', 'created_at'],
    changedColumns: ['material_item_id', 'consumed_quantity', 'consumption_date', 'notes', 'evidence_path', 'created_by'],
  },
  {
    tableName: 'warehouse_assets',
    entityType: 'warehouse_assets',
    columns: ['id', 'asset_code', 'sku_code', 'legacy_item_code', 'asset_name', 'category_name', 'unit_measure', 'brand', 'serial_number', 'model', 'certification_note', 'event_date', 'work_order', 'client_name', 'dispatch_note', 'asset_status', 'lifecycle_status', 'audit_date', 'current_city', 'minimum_stock', 'current_stock', 'vehicle_plate', 'vehicle_type', 'insurance_due_date', 'soat_due_date', 'technical_due_date', 'technical_detail', 'notes', 'created_at', 'updated_at'],
    changedColumns: ['asset_code', 'sku_code', 'legacy_item_code', 'asset_name', 'category_name', 'unit_measure', 'brand', 'serial_number', 'model', 'certification_note', 'event_date', 'work_order', 'client_name', 'dispatch_note', 'asset_status', 'lifecycle_status', 'audit_date', 'current_city', 'minimum_stock', 'current_stock', 'vehicle_plate', 'vehicle_type', 'insurance_due_date', 'soat_due_date', 'technical_due_date', 'technical_detail', 'notes'],
  },
  {
    tableName: 'warehouse_asset_movements',
    entityType: 'warehouse_asset_movements',
    columns: ['id', 'asset_id', 'project_id', 'movement_type', 'movement_date', 'work_order', 'client_name', 'dispatch_note', 'evidence_path', 'quantity', 'serial_snapshot', 'delivery_signature_name', 'receiving_signature_name', 'vehicle_plate_snapshot', 'odometer_snapshot', 'fuel_level_snapshot', 'checklist_snapshot', 'status_snapshot', 'city_snapshot', 'responsible_user_id', 'receiver_user_id', 'notes', 'created_at', 'updated_at'],
    changedColumns: ['asset_id', 'project_id', 'movement_type', 'movement_date', 'work_order', 'client_name', 'dispatch_note', 'evidence_path', 'quantity', 'serial_snapshot', 'delivery_signature_name', 'receiving_signature_name', 'vehicle_plate_snapshot', 'odometer_snapshot', 'fuel_level_snapshot', 'checklist_snapshot', 'status_snapshot', 'city_snapshot', 'responsible_user_id', 'receiver_user_id', 'notes'],
  },
  {
    tableName: 'commercial_form_templates',
    entityType: 'commercial_form_templates',
    columns: ['id', 'code', 'name', 'description', 'fields_json', 'is_active', 'created_by', 'created_at', 'updated_at'],
    changedColumns: ['code', 'name', 'description', 'fields_json', 'is_active', 'created_by'],
  },
];

const createOrReplaceTrigger = async (connection, triggerName, sql) => {
  await connection.query(`DROP TRIGGER IF EXISTS ${triggerName}`);
  await connection.query(sql);
};

const jsonObjectSql = (columns, alias) => {
  return `JSON_OBJECT(${columns.map((column) => `'${column}', ${alias}.${column}`).join(', ')})`;
};

const changedFieldsSql = (columns) => {
  if (!columns.length) {
    return 'JSON_ARRAY()';
  }

  return `JSON_MERGE_PRESERVE(JSON_ARRAY(), ${columns
    .map((column) => `IF(NOT (OLD.${column} <=> NEW.${column}), JSON_ARRAY('${column}'), JSON_ARRAY())`)
    .join(', ')})`;
};

const quotedArraySql = (columns) => `JSON_ARRAY(${columns.map((column) => `'${column}'`).join(', ')})`;

const createInsertTriggerSql = ({ tableName, entityType, columns, changedColumns }) => `
  CREATE TRIGGER trg_${tableName}_audit_insert
  AFTER INSERT ON ${tableName}
  FOR EACH ROW
  INSERT INTO audit_logs (user_id, action, entity_type, entity_id, old_values, new_values, changed_fields, ip_address)
  VALUES (
    @audit_user_id,
    'INSERT',
    '${entityType}',
    NEW.id,
    NULL,
    ${jsonObjectSql(columns, 'NEW')},
    ${quotedArraySql(changedColumns)},
    @audit_ip_address
  )`;

const createUpdateTriggerSql = ({ tableName, entityType, columns, changedColumns }) => `
  CREATE TRIGGER trg_${tableName}_audit_update
  AFTER UPDATE ON ${tableName}
  FOR EACH ROW
  INSERT INTO audit_logs (user_id, action, entity_type, entity_id, old_values, new_values, changed_fields, ip_address)
  VALUES (
    @audit_user_id,
    'UPDATE',
    '${entityType}',
    NEW.id,
    ${jsonObjectSql(columns, 'OLD')},
    ${jsonObjectSql(columns, 'NEW')},
    ${changedFieldsSql(changedColumns)},
    @audit_ip_address
  )`;

const createDeleteTriggerSql = ({ tableName, entityType, columns, changedColumns }) => `
  CREATE TRIGGER trg_${tableName}_audit_delete
  BEFORE DELETE ON ${tableName}
  FOR EACH ROW
  INSERT INTO audit_logs (user_id, action, entity_type, entity_id, old_values, new_values, changed_fields, ip_address)
  VALUES (
    @audit_user_id,
    'DELETE',
    '${entityType}',
    OLD.id,
    ${jsonObjectSql(columns, 'OLD')},
    NULL,
    ${quotedArraySql(changedColumns)},
    @audit_ip_address
  )`;

const ensureAuditLogShape = async (connection) => {
  await connection.query(`
    CREATE TABLE IF NOT EXISTS audit_logs (
      id INT PRIMARY KEY AUTO_INCREMENT,
      user_id INT NULL,
      action VARCHAR(100) NOT NULL,
      entity_type VARCHAR(50) NULL,
      entity_id INT NULL,
      old_values JSON NULL,
      new_values JSON NULL,
      changed_fields JSON NULL,
      ip_address VARCHAR(45) NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_user (user_id),
      INDEX idx_date (created_at),
      INDEX idx_entity_lookup (entity_type, entity_id)
    )
  `);

  try {
    await connection.query('ALTER TABLE audit_logs ADD COLUMN changed_fields JSON NULL AFTER new_values');
  } catch (_) {}

  try {
    await connection.query('CREATE INDEX idx_entity_lookup ON audit_logs (entity_type, entity_id)');
  } catch (_) {}
};

const installAuditTriggers = async ({ connection: providedConnection } = {}) => {
  let connection = providedConnection;
  const ownsConnection = !connection;

  try {
    if (!connection) {
      connection = await pool.getConnection();
    }

    await ensureAuditLogShape(connection);
    await ensureWarehouseShape(connection);

    for (const table of auditedTables) {
      await createOrReplaceTrigger(connection, `trg_${table.tableName}_audit_insert`, createInsertTriggerSql(table));
      await createOrReplaceTrigger(connection, `trg_${table.tableName}_audit_update`, createUpdateTriggerSql(table));
      await createOrReplaceTrigger(connection, `trg_${table.tableName}_audit_delete`, createDeleteTriggerSql(table));
    }

    console.log(`✅ Triggers de auditoría instalados para ${auditedTables.map((item) => item.tableName).join(', ')}.`);
    console.log('ℹ️ audit_logs.changed_fields registra qué columnas cambiaron.');
      console.log('ℹ️ audit_logs.user_id e ip_address ahora toman @audit_user_id y @audit_ip_address desde la sesión MySQL.');
  } catch (error) {
    console.error('❌ Error instalando triggers de auditoría:', error.message);
    process.exitCode = 1;
  } finally {
    if (ownsConnection && connection) connection.release();
    if (ownsConnection) await pool.end();
  }
};

if (require.main === module) {
  installAuditTriggers();
}

module.exports = {
  auditedTables,
  ensureAuditLogShape,
  installAuditTriggers,
};
