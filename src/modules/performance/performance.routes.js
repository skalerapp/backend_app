const express = require('express');
const router = express.Router();
const controller = require('./performance.controller');
const { verifyToken, verifyModuleAccess } = require('../../middleware/auth.middleware');

router.get('/', verifyToken, verifyModuleAccess('performance', 'read'), controller.listPerformanceEvaluations);
router.post('/', verifyToken, verifyModuleAccess('performance', 'create'), controller.createPerformanceEvaluation);
router.put('/:id', verifyToken, verifyModuleAccess('performance', 'update'), controller.updatePerformanceEvaluation);

module.exports = router;
