require('dotenv').config();

const mysql = require('mysql2/promise');
const { closeDatabase } = require('../config/database');
const { ensureUsersRoleSchema } = require('../modules/users/users.controller');
const { ensureEmployeeSchema } = require('../modules/employees/employees.controller');
const { ensureProjectsSchema } = require('../modules/projects/projects.controller');
const { ensureActivitiesSchema } = require('../modules/activities/activities.controller');
const { ensureAttendanceShape } = require('../modules/attendance/attendance.controller');
const { ensureLaborPermissionsTable } = require('../modules/laborPermissions/laborPermissions.controller');
const { ensureEvidenceShape } = require('../modules/evidence/evidence.controller');
const { ensureAllowancesShape } = require('../modules/allowances/allowances.controller');
const { ensureMaterialsShape } = require('../modules/materials/materials.controller');
const { ensureOperationalScopeShape } = require('../modules/operationalScopes/operationalScopes.service');
const { ensureCommercialSchema } = require('../modules/commercial/commercial.controller');
const { ensureWarehouseShape } = require('../modules/warehouse/warehouse.service');
const { installAuditTriggers } = require('./installAuditTriggers');

const dbName = process.env.DB_NAME || 'skaler_db';

const connectionConfig = {
  host: process.env.DB_HOST || 'localhost',
  port: Number(process.env.DB_PORT || 3306),
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '',
  database: dbName,
};

const listCurrentTables = async (connection) => {
  const [rows] = await connection.query(
    `SELECT table_name AS tableName
     FROM information_schema.tables
     WHERE table_schema = DATABASE() AND table_type = 'BASE TABLE'
     ORDER BY table_name ASC`
  );

  return rows.map((row) => row.tableName);
};

const runStep = async (label, action) => {
  console.log(`→ ${label}`);
  await action();
};

const ensureCurrentSchema = async ({ connection: providedConnection, installAudit = true } = {}) => {
  let connection = providedConnection;
  let ownsConnection = false;

  try {
    if (!connection) {
      connection = await mysql.createConnection(connectionConfig);
      ownsConnection = true;
    }

    await runStep('Normalizando usuarios', async () => ensureUsersRoleSchema(connection));
    await runStep('Normalizando empleados', async () => ensureEmployeeSchema(connection));
    await runStep('Normalizando proyectos', async () => ensureProjectsSchema(connection));
    await runStep('Creando alcances operativos', async () => ensureOperationalScopeShape(connection));
    await runStep('Normalizando actividades', async () => ensureActivitiesSchema(connection));
    await runStep('Normalizando asistencia', async () => ensureAttendanceShape(connection));
    await runStep('Normalizando permisos laborales', async () => ensureLaborPermissionsTable(connection));
    await runStep('Normalizando evidencias', async () => ensureEvidenceShape(connection));
    await runStep('Creando viaticos', async () => ensureAllowancesShape(connection));
    await runStep('Creando materiales', async () => ensureMaterialsShape(connection));
    await runStep('Creando comercial', async () => ensureCommercialSchema(connection));
    await runStep('Creando almacen', async () => ensureWarehouseShape(connection));

    if (installAudit) {
      await runStep('Instalando auditoria', async () => installAuditTriggers({ connection }));
    }

    return listCurrentTables(connection);
  } finally {
    if (ownsConnection && connection) {
      await connection.end();
    }
  }
};

if (require.main === module) {
  ensureCurrentSchema()
    .then((tables) => {
      console.log(`✅ Esquema actual sincronizado en ${dbName}`);
      console.log(`✅ Tablas base actuales: ${tables.length}`);
      console.log(tables.join('\n'));
    })
    .catch((error) => {
      console.error(`❌ Error sincronizando esquema actual: ${error.message}`);
      process.exitCode = 1;
    })
    .finally(async () => {
      await closeDatabase();
    });
}

module.exports = {
  ensureCurrentSchema,
  listCurrentTables,
};