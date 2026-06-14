async function withConnection(pool, callback) {
  const connection = await pool.getConnection();
  try {
    return await callback(connection);
  } finally {
    connection.release();
  }
}

module.exports = {
  withConnection,
};
