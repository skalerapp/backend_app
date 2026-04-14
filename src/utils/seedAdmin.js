require('dotenv').config();

const { pool } = require('../config/database');
const { hashPassword } = require('./auth.utils');

const run = async () => {
  try {
    const connection = await pool.getConnection();

    const [rows] = await connection.execute('SELECT * FROM users WHERE email = ?', ['admin@skaler.com']);
    if (rows.length > 0) {
      console.log('ℹ️  Usuario admin ya existe');
      connection.release();
      process.exit(0);
    }

    const hashed = await hashPassword('admin123');
    const [res] = await connection.execute(
      'INSERT INTO users (email, password, name, role, created_at) VALUES (?, ?, ?, ?, NOW())',
      ['admin@skaler.com', hashed, 'Admin', 'super_admin']
    );

    console.log('✅ Usuario admin creado con id:', res.insertId);
    connection.release();
    process.exit(0);
  } catch (err) {
    console.error('❌ Error creando admin:', err.message);
    process.exit(1);
  }
};

run();
