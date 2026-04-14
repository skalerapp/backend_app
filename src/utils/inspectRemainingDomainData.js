require('dotenv').config();
const mysql = require('mysql2/promise');

async function dump(connection, label, sql) {
  const [rows] = await connection.query(sql);
  console.log(label);
  console.log(JSON.stringify(rows, null, 2));
}

async function main() {
  const connection = await mysql.createConnection({
    host: process.env.DB_HOST || 'localhost',
    port: process.env.DB_PORT || 3306,
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'skaler_db',
  });

  try {
    await dump(connection, 'USERS', 'SELECT id,email,name,role FROM users ORDER BY id ASC');
    await dump(connection, 'PROJECTS', 'SELECT id,name,status,ot_code FROM projects ORDER BY id ASC');
    await dump(connection, 'EMPLOYEES_LAST', 'SELECT id,employee_name,identification_number,user_id FROM employees ORDER BY id DESC LIMIT 40');
    await dump(connection, 'ALLOWANCE_REQUESTS_LAST', 'SELECT id,requester_user_id,responsible_user_id,approver_user_id,project_id,status,created_at FROM allowance_requests ORDER BY id DESC LIMIT 40');
    await dump(connection, 'PROJECT_ALLOWANCES', 'SELECT id,project_id,leader_user_id,assigned_amount,created_at,updated_at FROM project_allowances ORDER BY id ASC');
    await dump(connection, 'ATTENDANCE_LAST', 'SELECT id,employee_id,user_id,project_id,attendance_date FROM attendance ORDER BY id DESC LIMIT 40');
    await dump(connection, 'ACTIVITIES_LAST', 'SELECT id,project_id,employee_id,description FROM activities ORDER BY id DESC LIMIT 40');
  } finally {
    await connection.end();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
