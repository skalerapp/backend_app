require('dotenv').config();

const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');

const dbName = process.env.DB_NAME || 'skaler_db';
const outputPath = path.join(__dirname, '../../..', 'database', 'schema.sql');

const connectionConfig = {
  host: process.env.DB_HOST || 'localhost',
  port: Number(process.env.DB_PORT || 3306),
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '',
  database: dbName,
};

const preferredOrder = [
  'users',
  'projects',
  'employees',
  'activities',
  'labor_permissions',
  'budgets',
  'expenses',
  'attendance',
  'evidence',
  'warehouse_materials',
  'warehouse_movements',
  'fleet',
  'fleet_assignments',
  'commercial_visits',
  'commercial_forms',
  'commercial_form_templates',
  'hse_trainings',
  'hse_ppe',
  'hse_incidents',
  'hse_corrective_actions',
  'role_permissions',
  'audit_logs',
  'operational_role_assignments',
  'project_collaborators',
  'project_allowances',
  'allowance_requests',
  'allowance_expenses',
  'project_material_items',
  'material_consumptions',
  'commercial_opportunities',
  'warehouse_assets',
  'warehouse_asset_movements',
];

const sortTables = (tableNames) => {
  const preferred = preferredOrder.filter((name) => tableNames.includes(name));
  const remaining = tableNames
    .filter((name) => !preferredOrder.includes(name))
    .sort((left, right) => left.localeCompare(right));

  return [...preferred, ...remaining];
};

const cleanCreateStatement = (statement) => {
  return statement
    .replace(/ AUTO_INCREMENT=\d+/g, '')
    .replace(/\s+$/g, '');
};

const exportCurrentSchema = async () => {
  const connection = await mysql.createConnection(connectionConfig);

  try {
    const [tableRows] = await connection.query(
      `SELECT table_name AS tableName
       FROM information_schema.tables
       WHERE table_schema = DATABASE() AND table_type = 'BASE TABLE'`
    );

    const tableNames = sortTables(tableRows.map((row) => row.tableName));
    const sections = [
      '-- =====================================================',
      '-- SKALER - Base de Datos Principal',
      '-- Esquema exportado desde la base local actual',
      '-- =====================================================',
      '',
    ];

    for (const tableName of tableNames) {
      const [rows] = await connection.query(`SHOW CREATE TABLE \`${tableName}\``);
      const createStatement = cleanCreateStatement(rows[0]['Create Table']);
      sections.push(`-- Tabla: ${tableName}`);
      sections.push(`${createStatement};`);
      sections.push('');
    }

    fs.writeFileSync(outputPath, `${sections.join('\n')}\n`, 'utf8');
    console.log(`✅ schema.sql exportado con ${tableNames.length} tablas en ${outputPath}`);
    return { tableNames, outputPath };
  } finally {
    await connection.end();
  }
};

if (require.main === module) {
  exportCurrentSchema().catch((error) => {
    console.error(`❌ Error exportando esquema actual: ${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = {
  exportCurrentSchema,
};