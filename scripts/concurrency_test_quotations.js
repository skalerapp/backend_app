const jwt = require('jsonwebtoken');
const fetch = globalThis.fetch || require('node-fetch');
const os = require('os');

const SECRET = process.env.JWT_SECRET || 'your_super_secret_jwt_key_here';
const URL = process.env.TEST_URL || 'http://localhost:3000/api/commercial/quotations';
const PARALLEL = Number(process.argv[2]) || 50;

const makeToken = (userId = 1000) => jwt.sign({ id: userId, name: `ConcTest ${userId}`, role: 'administrative' }, SECRET);

(async ()=>{
  console.log(`Running concurrency test: ${PARALLEL} parallel requests to ${URL}`);
  const token = makeToken(9999);
  const tasks = [];
  for (let i=0;i<PARALLEL;i++){
    const body = { visit_id: 1, budget: Math.floor(Math.random()*1000000), observations: `concurrency ${i}` };
    tasks.push(fetch(URL, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer '+token }, body: JSON.stringify(body) })
      .then(async (r)=>{
        const txt = await r.text();
        try{ return { status: r.status, json: JSON.parse(txt) }; } catch(e){ return { status: r.status, text: txt }; }
      }).catch(e=>({ error: e.message })));
  }

  const results = await Promise.all(tasks);
  const success = results.filter(r=>r && r.status === 201 && r.json && r.json.data).map(r=>r.json.data.quotation_number);
  const failures = results.filter(r=>!(r && r.status === 201));

  const counts = {};
  for (const q of success) counts[q] = (counts[q]||0)+1;
  const duplicates = Object.entries(counts).filter(([,v])=>v>1);

  console.log('Total requests:', PARALLEL);
  console.log('Successful creations:', success.length);
  console.log('Failures:', failures.length);
  if (duplicates.length) {
    console.warn('Duplicates detected:', duplicates);
  } else {
    console.log('No duplicate quotation_numbers detected.');
  }

  // print some sample successes
  console.log('Sample created IDs:', success.slice(0,10));

  if (failures.length) console.log('Sample failures:', failures.slice(0,5));

  process.exit(0);
})();
