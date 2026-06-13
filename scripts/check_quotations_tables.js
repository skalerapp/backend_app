(async ()=>{
  try{
    const { pool } = require('../src/config/database');
    const connection = await pool.getConnection();
    try{
      const [t1] = await connection.execute("SHOW TABLES LIKE 'commercial_quotations'");
      console.log('commercial_quotations:', t1.length ? 'exists' : 'missing');
      const [t2] = await connection.execute("SELECT * FROM counters WHERE name = ? LIMIT 1", ['quotation']).catch(()=>[[]]);
      console.log('counters.quotation:', t2.length ? JSON.stringify(t2[0]) : 'missing');
    }finally{
      connection.release();
      await pool.end();
    }
  }catch(err){
    console.error('error checking db:', err.message);
    process.exit(1);
  }
})();
