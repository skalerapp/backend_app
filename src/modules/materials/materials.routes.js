const express = require('express');
const router = express.Router();
const controller = require('./materials.controller');
const { verifyToken, verifyModuleAccess } = require('../../middleware/auth.middleware');

router.get('/', verifyToken, verifyModuleAccess('materials', 'read'), controller.listMaterialItems);
router.get('/project/:projectId', verifyToken, verifyModuleAccess('materials', 'read'), controller.listProjectMaterials);
router.post('/assign', verifyToken, verifyModuleAccess('materials', 'create'), controller.assignMaterial);
router.get('/project/:projectId/consumptions', verifyToken, verifyModuleAccess('materials', 'read'), controller.listConsumptionsByProject);
router.post('/project/:projectId/consume', verifyToken, verifyModuleAccess('materials', 'update'), controller.registerConsumption);

module.exports = router;
