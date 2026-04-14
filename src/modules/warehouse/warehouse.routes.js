const express = require('express');
const router = express.Router();
const controller = require('./warehouse.controller');
const { verifyToken, verifyModuleAccess } = require('../../middleware/auth.middleware');

router.get('/assets', verifyToken, verifyModuleAccess('warehouse', 'read'), controller.listAssets);
router.post('/assets', verifyToken, verifyModuleAccess('warehouse', 'create'), controller.createAsset);
router.post('/assets/import', verifyToken, verifyModuleAccess('warehouse', 'create'), controller.importAssets);
router.get('/movements', verifyToken, verifyModuleAccess('warehouse', 'read'), controller.listMovements);
router.post('/movements', verifyToken, verifyModuleAccess('warehouse', 'create'), controller.createMovement);

module.exports = router;