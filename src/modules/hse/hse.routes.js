const express = require('express');
const router = express.Router();
const controller = require('./hse.controller');
const { verifyToken, verifyModuleAccess } = require('../../middleware/auth.middleware');

router.get('/summary', verifyToken, verifyModuleAccess('hse', 'read'), controller.getHseDashboardSummary);
router.get('/trainings', verifyToken, verifyModuleAccess('hse', 'read'), controller.listTrainings);
router.post('/trainings', verifyToken, verifyModuleAccess('hse', 'create'), controller.createTraining);

router.get('/epp-deliveries', verifyToken, verifyModuleAccess('hse', 'read'), controller.listEppDeliveries);
router.post('/epp-deliveries', verifyToken, verifyModuleAccess('hse', 'create'), controller.createEppDelivery);

router.get('/incidents', verifyToken, verifyModuleAccess('hse', 'read'), controller.listIncidents);
router.post('/incidents', verifyToken, verifyModuleAccess('hse', 'create'), controller.createIncident);

router.get('/unsafe-reports', verifyToken, verifyModuleAccess('hse', 'read'), controller.listUnsafeReports);
router.post('/unsafe-reports', verifyToken, verifyModuleAccess('hse', 'create'), controller.createUnsafeReport);

router.get('/corrective-actions', verifyToken, verifyModuleAccess('hse', 'read'), controller.listCorrectiveActions);
router.post('/corrective-actions', verifyToken, verifyModuleAccess('hse', 'create'), controller.createCorrectiveAction);
router.patch('/corrective-actions/:id', verifyToken, verifyModuleAccess('hse', 'update'), controller.updateCorrectiveAction);

module.exports = router;
