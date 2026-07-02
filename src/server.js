require('dotenv').config();
const express = require('express');
const cors = require('cors');
const morgan = require('morgan');
const path = require('path');
const { UPLOAD_ROOT, ensureUploadRoot } = require('./utils/uploadPaths');

ensureUploadRoot();

const parseCorsOrigins = () => {
  const rawOrigins = [
    process.env.CORS_ORIGINS,
    process.env.FRONTEND_URL,
    process.env.WEB_APP_URL,
    process.env.DASHBOARD_URL,
  ]
      .filter((value) => value != null)
      .join(',');

  const allowed = rawOrigins
      .split(',')
      .map((item) => item.toString().trim().replace(/\/$/, ''))
      .filter((item) => item.length > 0);

  return [...new Set(allowed)];
};

const normalizeOrigin = (origin) => origin.toString().trim().replace(/\/$/, '');

const isLocalDevOrigin = (origin) => {
  try {
    const parsed = new URL(origin);
    return parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1';
  } catch (_) {
    return false;
  }
};

const allowedOrigins = parseCorsOrigins();

// Importar rutas
const authRoutes = require('./modules/auth/auth.routes');
const projectRoutes = require('./modules/projects/projects.routes');
const employeeRoutes = require('./modules/employees/employees.routes');
const userRoutes = require('./modules/users/users.routes');
const activityRoutes = require('./modules/activities/activities.routes');
const laborPermissionsRoutes = require('./modules/laborPermissions/laborPermissions.routes');
const attendanceRoutes = require('./modules/attendance/attendance.routes');
const allowancesRoutes = require('./modules/allowances/allowances.routes');
const materialsRoutes = require('./modules/materials/materials.routes');
const warehouseRoutes = require('./modules/warehouse/warehouse.routes');
const operationalScopesRoutes = require('./modules/operationalScopes/operationalScopes.routes');
const auditRoutes = require('./modules/audit/audit.routes');
const commercialRoutes = require('./modules/commercial/commercial.routes');
const hseRoutes = require('./modules/hse/hse.routes');
const tasksRoutes = require('./modules/tasks/tasks.routes');
const performanceRoutes = require('./modules/performance/performance.routes');
// const operativeRoutes = require('./modules/operative/operative.routes');

const app = express();

// Middlewares
app.use(cors({
  origin(origin, callback) {
    if (!origin) {
      return callback(null, true);
    }

    const normalizedOrigin = normalizeOrigin(origin);
    if (
      allowedOrigins.length === 0 ||
      allowedOrigins.includes(normalizedOrigin) ||
      isLocalDevOrigin(normalizedOrigin)
    ) {
      return callback(null, true);
    }
    return callback(new Error('Origen no permitido por CORS'));
  },
  credentials: true,
}));
app.use(morgan('dev'));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use('/uploads', express.static(UPLOAD_ROOT));

// Endpoint de prueba sin autenticación
app.get('/api/health', (req, res) => {
  res.json({ success: true, message: 'Backend funcionando' });
});

const appRoutes = require('./modules/app/app.routes');
app.use('/api/app', appRoutes);

app.get('/api/health/db', async (req, res) => {
  let connection;
  try {
    const { pool } = require('./config/database');
    connection = await pool.getConnection();
    await connection.query('SELECT 1');
    res.json({
      success: true,
      message: 'Base de datos conectada',
      pool: {
        connectionLimit: pool.config?.connectionLimit,
        activeConnections: pool.pool?._allConnections?.length ?? null,
        idleConnections: pool.pool?._freeConnections?.length ?? null,
        queuedRequests: pool.pool?._connectionQueue?.length ?? null,
      },
    });
  } catch (error) {
    res.status(503).json({
      success: false,
      message: 'No se pudo conectar a la base de datos',
      error: error?.message || String(error),
    });
  } finally {
    if (connection) {
      connection.release();
    }
  }
});

// Rutas
app.use('/api/auth', authRoutes);
app.use('/api/projects', projectRoutes);
app.use('/api/employees', employeeRoutes);
app.use('/api/activities', activityRoutes);
app.use('/api/labor-permissions', laborPermissionsRoutes);
app.use('/api/attendance', attendanceRoutes);
app.use('/api/allowances', allowancesRoutes);
app.use('/api/materials', materialsRoutes);
app.use('/api/warehouse', warehouseRoutes);
app.use('/api/operational-scopes', operationalScopesRoutes);
app.use('/api/audit-logs', auditRoutes);
app.use('/api/users', userRoutes);
app.use('/api/commercial', commercialRoutes);
app.use('/api/hse', hseRoutes);
app.use('/api/tasks', tasksRoutes);
app.use('/api/performance-evaluations', performanceRoutes);
const evidenceRoutes = require('./modules/evidence/evidence.routes');
app.use('/api/evidence', evidenceRoutes);
// app.use('/api/operative', operativeRoutes);

// Manejo de errores
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(err.status || 500).json({
    success: false,
    message: err.message || 'Error interno del servidor',
    error: process.env.NODE_ENV === 'development' ? err : {}
  });
});

const PORT = process.env.PORT || 3000;

const runAttendanceIdentityBackfill = () => {
  const { withDbConnection } = require('./config/database');
  const {
    ensureAttendanceShape,
    backfillAttendanceIdentity,
  } = require('./modules/attendance/attendance.controller');

  withDbConnection(async (connection) => {
    await ensureAttendanceShape(connection);
    const result = await backfillAttendanceIdentity(connection);
    const total = (result.employeeIdsFilled ?? 0) + (result.userIdsFilled ?? 0);
    if (total > 0) {
      console.log(`✅ Asistencia: ${result.employeeIdsFilled} employee_id y ${result.userIdsFilled} user_id normalizados`);
    }
  }).catch((error) => {
    console.warn('⚠️ No se pudo normalizar identidad de asistencia al iniciar:', error.message);
  });
};

// Solo iniciar el listener si no estamos en entorno de test.
if (process.env.NODE_ENV !== 'test') {
  const server = app.listen(PORT, () => {
    console.log(`🚀 Servidor SKALER ejecutándose en puerto ${PORT}`);
    console.log(`📍 Ambiente: ${process.env.NODE_ENV}`);
    runAttendanceIdentityBackfill();
  });

  server.on('error', (error) => {
    if (error && error.code === 'EADDRINUSE') {
      console.error(`El puerto ${PORT} ya está en uso. Ya existe otra instancia del backend ejecutándose.`);
      process.exit(1);
    }

    console.error('No fue posible iniciar el servidor:', error && error.stack ? error.stack : error);
    process.exit(1);
  });
}

module.exports = app;
