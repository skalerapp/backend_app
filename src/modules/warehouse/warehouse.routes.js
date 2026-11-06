const express = require('express');
const router = express.Router();
const controller = require('./warehouse.controller');
const { verifyToken, verifyModuleAccess } = require('../../middleware/auth.middleware');

router.get('/assets', verifyToken, verifyModuleAccess('warehouse', 'read'), controller.listAssets);
router.get('/dispatch-receivers', verifyToken, verifyModuleAccess('warehouse', 'read'), controller.listDispatchReceivers);
router.post('/assets', verifyToken, verifyModuleAccess('warehouse', 'create'), controller.createAsset);
router.put('/assets/:id', verifyToken, verifyModuleAccess('warehouse', 'update'), controller.updateAsset);
router.get('/assets/:id/edits', verifyToken, verifyModuleAccess('warehouse', 'read'), controller.listAssetEditHistory);
router.post('/assets/import', verifyToken, verifyModuleAccess('warehouse', 'create'), controller.importAssets);
router.get('/movements', verifyToken, verifyModuleAccess('warehouse', 'read'), controller.listMovements);
router.post('/movements', verifyToken, verifyModuleAccess('warehouse', 'create'), controller.createMovement);

router.get('/delivery-notes', verifyToken, verifyModuleAccess('warehouse', 'read'), controller.listRemisiones);
router.get('/delivery-notes/:id', verifyToken, verifyModuleAccess('warehouse', 'read'), controller.getRemision);
router.post('/delivery-notes', verifyToken, verifyModuleAccess('warehouse', 'create'), controller.createRemision);
router.patch('/delivery-notes/:id', verifyToken, verifyModuleAccess('warehouse', 'update'), controller.patchRemision);
router.post('/delivery-notes/:id/lines', verifyToken, verifyModuleAccess('warehouse', 'create'), controller.addRemisionLine);
router.post('/delivery-notes/:id/deliver', verifyToken, verifyModuleAccess('warehouse', 'update'), controller.deliverRemision);
router.post('/delivery-notes/:id/cancel', verifyToken, verifyModuleAccess('warehouse', 'update'), controller.cancelRemision);

module.exports = router;