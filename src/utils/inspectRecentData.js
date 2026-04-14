require('dotenv').config();
const mysql = require('mysql2/promise');

async function main() {
  const connection = await mysql.createConnection({
    host: process.env.DB_HOST || 'localhost',
    port: process.env.DB_PORT || 3306,
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'skaler_db',
  });

  try {
    const [projects] = await connection.query(
      'SELECT id, name, status, ot_code, created_at FROM projects ORDER BY id DESC LIMIT 60'
    );
    const [employees] = await connection.query(
      'SELECT id, employee_name, identification_number, user_id FROM employees ORDER BY id DESC LIMIT 60'
    );
    const [users] = await connection.query(
      'SELECT id, email, name, role FROM users ORDER BY id DESC LIMIT 60'
    );

    console.log('PROJECTS');
    console.log(JSON.stringify(projects, null, 2));
    console.log('EMPLOYEES');
    console.log(JSON.stringify(employees, null, 2));
    console.log('USERS');
    console.log(JSON.stringify(users, null, 2));
  } finally {
    await connection.end();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
