const express = require('express');
const router = express.Router();
const controller = require('./fleet.controller');
const { verifyToken, verifyModuleAccess } = require('../../middleware/auth.middleware');

router.get('/alerts', verifyToken, verifyModuleAccess('warehouse', 'read'), controller.listAlerts);
router.get('/units', verifyToken, verifyModuleAccess('warehouse', 'read'), controller.listUnits);
router.get('/units/:id', verifyToken, verifyModuleAccess('warehouse', 'read'), controller.getUnit);
router.post('/units', verifyToken, verifyModuleAccess('warehouse', 'create'), controller.createUnit);
router.put('/units/:id', verifyToken, verifyModuleAccess('warehouse', 'update'), controller.updateUnit);
router.get('/units/:id/maintenance', verifyToken, verifyModuleAccess('warehouse', 'read'), controller.listMaintenance);
router.post('/units/:id/maintenance', verifyToken, verifyModuleAccess('warehouse', 'create'), controller.createMaintenance);

module.exports = router;
