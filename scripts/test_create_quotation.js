const controller = require('../src/modules/commercial/commercial.controller');

const makeRes = () => {
  return {
    status(code) { this._status = code; return this; },
    json(obj) { console.log('RESPONSE', this._status || 200, JSON.stringify(obj,null,2)); }
  };
};

(async ()=>{
  try{
    const req = {
      body: { visit_id: 1, budget: 1000000, observations: 'Prueba automática' },
      user: { id: 1, name: 'Prueba Usuario', role: 'administrative', canViewGps: true },
      headers: {},
      ip: '127.0.0.1'
    };
    const res = makeRes();
    await controller.createQuotation(req, res);
    process.exit(0);
  }catch(err){
    console.error('test error', err);
    process.exit(1);
  }
})();
