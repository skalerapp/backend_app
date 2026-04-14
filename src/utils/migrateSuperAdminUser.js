const db = require('../config/database');

const pool = db.pool;

const parseOptions = () => {
  const args = process.argv.slice(2);
  const emailArg = args.find((arg) => arg.startsWith('--email='));

  return {
    apply: args.includes('--apply'),
    email: emailArg ? emailArg.split('=')[1]?.trim().toLowerCase() : 'admin@skaler.com',
  };
};

const run = async () => {
  const { apply, email } = parseOptions();
  let connection;

  try {
    connection = await pool.getConnection();

    const [rows] = await connection.execute(
      'SELECT id, email, role FROM users WHERE LOWER(email) = ? LIMIT 1',
      [email]
    );

    if (!rows.length) {
      console.log(`No se encontró usuario con email: ${email}`);
      return;
    }

    const user = rows[0];
    const currentRole = (user.role || '').toString().trim().toLowerCase();
    const targetRole = 'super_admin';

    console.log(`Usuario encontrado: id=${user.id}, email=${user.email}, role_actual=${currentRole || '(vacío)'}`);

    if (currentRole === targetRole) {
      console.log('El usuario ya tiene rol super_admin. No hay cambios.');
      return;
    }

    console.log(`Cambio propuesto: ${currentRole || '(vacío)'} -> ${targetRole}`);

    if (!apply) {
      console.log('Modo simulación. Para aplicar: npm run migrate:users:super-admin -- --apply');
      return;
    }

    await connection.beginTransaction();
    await connection.execute('UPDATE users SET role = ? WHERE id = ?', [targetRole, user.id]);
    await connection.commit();

    console.log('Migración aplicada: usuario actualizado a super_admin.');
  } catch (error) {
    if (connection) {
      try {
        await connection.rollback();
      } catch (_) {
      }
    }
    console.error('Error en migración super_admin:', error.message);
    process.exitCode = 1;
  } finally {
    if (connection) connection.release();
    await pool.end();
  }
};

run();
