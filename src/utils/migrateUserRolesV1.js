const db = require('../config/database');
const { normalizeRole } = require('../middleware/auth.middleware');

const pool = db.pool;

const OFFICIAL_ROLES = new Set([
  'super_admin',
  'administrative',
  'coordinator_operations',
  'supervisor',
  'leader',
  'employee',
  'warehouse_logistics',
  'commercial',
  'gerencial',
]);

const parseOptions = () => {
  const args = process.argv.slice(2);
  return {
    apply: args.includes('--apply'),
  };
};

const run = async () => {
  const { apply } = parseOptions();
  let connection;

  try {
    connection = await pool.getConnection();

    const [rows] = await connection.execute('SELECT id, role FROM users ORDER BY id ASC');

    const updates = [];
    const unknowns = [];

    for (const row of rows) {
      const currentRole = (row.role || '').toString();
      const normalized = normalizeRole(currentRole);
      const alreadyOfficial = currentRole === normalized;

      if (!OFFICIAL_ROLES.has(normalized)) {
        if (!alreadyOfficial) {
          unknowns.push({
            id: row.id,
            currentRole,
            normalized,
          });
        }
        continue;
      }

      if (!alreadyOfficial) {
        updates.push({
          id: row.id,
          from: currentRole,
          to: normalized,
        });
      }
    }

    console.log(`Usuarios analizados: ${rows.length}`);
    console.log(`Cambios detectados: ${updates.length}`);

    if (unknowns.length > 0) {
      console.log(`Roles desconocidos detectados (sin cambio automático): ${unknowns.length}`);
      for (const item of unknowns) {
        console.log(`- user_id=${item.id}: "${item.currentRole}" -> "${item.normalized}" (NO OFICIAL)`);
      }
    }

    if (updates.length === 0) {
      console.log('No hay cambios que aplicar.');
      return;
    }

    for (const item of updates) {
      console.log(`- user_id=${item.id}: "${item.from}" -> "${item.to}"`);
    }

    if (!apply) {
      console.log('Modo simulación. Para aplicar cambios usa: npm run migrate:users:roles:v1 -- --apply');
      return;
    }

    await connection.beginTransaction();
    for (const item of updates) {
      await connection.execute('UPDATE users SET role = ? WHERE id = ?', [item.to, item.id]);
    }
    await connection.commit();

    console.log(`Migración aplicada correctamente. Usuarios actualizados: ${updates.length}`);
  } catch (error) {
    if (connection) {
      try {
        await connection.rollback();
      } catch (_) {
      }
    }
    console.error('Error en migración de roles:', error.message);
    process.exitCode = 1;
  } finally {
    if (connection) connection.release();
    await pool.end();
  }
};

run();
