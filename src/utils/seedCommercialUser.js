require('dotenv').config();

const { pool } = require('../config/database');
const { hashPassword } = require('./auth.utils');

const DEFAULT_EMAIL = process.env.COMMERCIAL_USER_EMAIL || 'commercial@skaler.com';
const DEFAULT_PASSWORD = process.env.COMMERCIAL_USER_PASSWORD || 'commercial123';
const DEFAULT_NAME = process.env.COMMERCIAL_USER_NAME || 'Asesor Comercial';

const run = async () => {
  let connection;
  try {
    connection = await pool.getConnection();

    const [rows] = await connection.execute(
      'SELECT id, email, name, role, status FROM users WHERE LOWER(email) = ? LIMIT 1',
      [DEFAULT_EMAIL.toLowerCase()],
    );

    const hashedPassword = await hashPassword(DEFAULT_PASSWORD);

    if (rows.length > 0) {
      const existing = rows[0];
      await connection.execute(
        `UPDATE users
         SET name = ?,
             password = ?,
             role = ?,
             status = ?,
             updated_at = NOW()
         WHERE id = ?`,
        [DEFAULT_NAME, hashedPassword, 'commercial', 'active', existing.id],
      );

      console.log(`ℹ️ Usuario comercial actualizado: ${DEFAULT_EMAIL} (id ${existing.id})`);
      return;
    }

    const [result] = await connection.execute(
      `INSERT INTO users (email, password, name, role, status, created_at)
       VALUES (?, ?, ?, ?, ?, NOW())`,
      [DEFAULT_EMAIL.toLowerCase(), hashedPassword, DEFAULT_NAME, 'commercial', 'active'],
    );

    console.log(`✅ Usuario comercial creado: ${DEFAULT_EMAIL} (id ${result.insertId})`);
  } catch (error) {
    console.error('❌ Error preparando usuario comercial:', error.message);
    process.exitCode = 1;
  } finally {
    connection?.release();
    await pool.end();
  }
};

run();