require('dotenv').config();

const fs = require('fs');
const path = require('path');
const db = require('../config/database');
const { normalizeRole } = require('../middleware/auth.middleware');

const pool = db.pool;

const parseOptions = () => {
  const args = process.argv.slice(2);
  const apply = args.includes('--apply');
  const fileIndex = args.indexOf('--file');
  const filePath = fileIndex >= 0 ? args[fileIndex + 1] : null;
  const positional = args.filter((item, index) => item !== '--apply' && item !== '--file' && index !== fileIndex + 1);
  const [targetRole, ...emails] = positional;

  return {
    apply,
    filePath,
    targetRole,
    emails,
  };
};

const readEmailsFromFile = (filePath) => {
  if (!filePath) {
    return [];
  }

  const fullPath = path.resolve(filePath);
  const content = fs.readFileSync(fullPath, 'utf8');
  return content
    .split(/\r?\n/)
    .map((line) => line.trim().toLowerCase())
    .filter((line) => line && !line.startsWith('#'));
};

const run = async () => {
  const { apply, filePath, targetRole, emails } = parseOptions();
  const normalizedRole = normalizeRole(targetRole || '');
  const allowedRoles = new Set([
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

  if (!allowedRoles.has(normalizedRole)) {
    console.error('Uso: node src/utils/assignRoleToUsersByEmail.js <rol> <email1> [email2 ...] [--file ruta.txt] [--apply]');
    console.error(`Rol inválido: ${targetRole || '(vacío)'}`);
    process.exit(1);
  }

  const targetEmails = [...emails.map((item) => item.trim().toLowerCase()), ...readEmailsFromFile(filePath)]
    .filter((item, index, array) => item && array.indexOf(item) == index);

  if (!targetEmails.length) {
    console.error('Debes indicar al menos un correo o un archivo con correos.');
    process.exit(1);
  }

  let connection;
  try {
    connection = await pool.getConnection();

    const placeholders = targetEmails.map(() => '?').join(', ');
    const [rows] = await connection.execute(
      `SELECT id, email, name, role, status FROM users WHERE LOWER(email) IN (${placeholders}) ORDER BY name ASC`,
      targetEmails,
    );

    const foundEmails = new Set(rows.map((row) => row.email.toString().trim().toLowerCase()));
    const missing = targetEmails.filter((email) => !foundEmails.has(email));

    console.log(`Rol destino: ${normalizedRole}`);
    console.log(`Correos recibidos: ${targetEmails.length}`);
    console.log(`Usuarios encontrados: ${rows.length}`);
    console.log(`Correos sin coincidencia: ${missing.length}`);

    if (missing.length) {
      for (const email of missing) {
        console.log(`- sin usuario: ${email}`);
      }
    }

    if (!rows.length) {
      return;
    }

    for (const row of rows) {
      console.log(`- ${row.email} | ${row.name} | ${row.role} -> ${normalizedRole}`);
    }

    if (!apply) {
      console.log('Modo simulación. Agrega --apply para guardar los cambios.');
      return;
    }

    await connection.beginTransaction();
    for (const row of rows) {
      await connection.execute('UPDATE users SET role = ? WHERE id = ?', [normalizedRole, row.id]);
    }
    await connection.commit();
    console.log(`Usuarios actualizados: ${rows.length}`);
  } catch (error) {
    if (connection) {
      try {
        await connection.rollback();
      } catch (_) {}
    }
    console.error('Error asignando rol por correo:', error.message);
    process.exitCode = 1;
  } finally {
    if (connection) connection.release();
    await pool.end();
  }
};

if (require.main === module) {
  run();
}

module.exports = {
  parseOptions,
  readEmailsFromFile,
  run,
};