const { pool } = require('../config/database');

const backfillActivitiesLegacy = async () => {
  let connection;
  try {
    connection = await pool.getConnection();

    try {
      await connection.execute('ALTER TABLE activities ADD COLUMN title VARCHAR(255) NULL');
    } catch (e) {}
    try {
      await connection.execute('ALTER TABLE activities ADD COLUMN `date` DATE NULL');
    } catch (e) {}
    try {
      await connection.execute('ALTER TABLE activities ADD COLUMN activity_date DATE NULL');
    } catch (e) {}
    try {
      await connection.execute('ALTER TABLE activities ADD COLUMN start_time DATETIME NULL');
    } catch (e) {}
    try {
      await connection.execute('ALTER TABLE activities ADD COLUMN end_time DATETIME NULL');
    } catch (e) {}
    try {
      await connection.execute("ALTER TABLE activities ADD COLUMN status ENUM('planned','in_progress','completed','cancelled') DEFAULT 'planned'");
    } catch (e) {}
    try {
      await connection.execute("ALTER TABLE activities MODIFY COLUMN status ENUM('planned','in_progress','completed','cancelled') NOT NULL DEFAULT 'planned'");
    } catch (e) {}
    try {
      await connection.execute('ALTER TABLE activities ADD COLUMN hours_worked DECIMAL(10,2) DEFAULT 0');
    } catch (e) {}
    try {
      await connection.execute('ALTER TABLE activities ADD COLUMN evidences INT DEFAULT 0');
    } catch (e) {}

    await connection.execute(`
      UPDATE activities
      SET status = CASE LOWER(TRIM(COALESCE(status, '')))
        WHEN 'planificada' THEN 'planned'
        WHEN 'planned' THEN 'planned'
        WHEN 'en progreso' THEN 'in_progress'
        WHEN 'en_progreso' THEN 'in_progress'
        WHEN 'in progress' THEN 'in_progress'
        WHEN 'in-progress' THEN 'in_progress'
        WHEN 'in_progress' THEN 'in_progress'
        WHEN 'completada' THEN 'completed'
        WHEN 'completed' THEN 'completed'
        WHEN 'cancelada' THEN 'cancelled'
        WHEN 'canceled' THEN 'cancelled'
        WHEN 'cancelled' THEN 'cancelled'
        ELSE 'planned'
      END
    `);

    await connection.execute(`
      UPDATE activities
      SET title = COALESCE(NULLIF(TRIM(title), ''), NULLIF(TRIM(description), ''), CONCAT('Actividad #', id))
    `);

    await connection.execute("UPDATE activities SET `date` = DATE(created_at) WHERE `date` IS NULL OR `date` = '0000-00-00'");
    await connection.execute("UPDATE activities SET activity_date = DATE(created_at) WHERE activity_date IS NULL OR activity_date = '0000-00-00'");
    await connection.execute('UPDATE activities SET start_time = COALESCE(start_time, created_at, NOW())');

    await connection.execute(`
      UPDATE activities
      SET end_time = COALESCE(end_time, NOW())
      WHERE status IN ('completed', 'cancelled')
    `);

    await connection.execute(`
      UPDATE activities
      SET hours_worked = CASE
        WHEN start_time IS NOT NULL AND end_time IS NOT NULL THEN ROUND(TIMESTAMPDIFF(MINUTE, start_time, end_time) / 60, 2)
        ELSE COALESCE(hours_worked, 0)
      END
    `);

    try {
      await connection.execute(`
        UPDATE activities a
        LEFT JOIN (
          SELECT activity_id, COUNT(*) AS total
          FROM evidence
          WHERE activity_id IS NOT NULL
          GROUP BY activity_id
        ) ev ON ev.activity_id = a.id
        SET a.evidences = COALESCE(ev.total, 0)
      `);
    } catch (e) {
      console.log('ℹ️ Tabla evidence no disponible o sin relación activity_id; evidences quedó sin cambios.');
    }

    const [rows] = await connection.execute(
      'SELECT COUNT(*) AS total, SUM(CASE WHEN title IS NULL OR TRIM(title) = "" THEN 1 ELSE 0 END) AS without_title FROM activities'
    );

    console.log('✅ Backfill activities completado.');
    if (rows && rows[0]) {
      console.log(`📊 Total actividades: ${rows[0].total}, sin título: ${rows[0].without_title}`);
    }
  } catch (error) {
    console.error('❌ Error en backfill de activities:', error.message);
    process.exitCode = 1;
  } finally {
    if (connection) connection.release();
    await pool.end();
  }
};

backfillActivitiesLegacy();
