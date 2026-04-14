const express = require('express');
const router = express.Router();
const laborPermissionsController = require('./laborPermissions.controller');
const { verifyToken, verifyModuleAccess } = require('../../middleware/auth.middleware');

router.get('/', verifyToken, verifyModuleAccess('labor_permissions', 'read'), laborPermissionsController.getLaborPermissions);
router.get('/:id', verifyToken, verifyModuleAccess('labor_permissions', 'read'), laborPermissionsController.getLaborPermissionById);
router.post('/', verifyToken, verifyModuleAccess('labor_permissions', 'create'), laborPermissionsController.createLaborPermission);
router.put('/:id', verifyToken, verifyModuleAccess('labor_permissions', 'update'), laborPermissionsController.updateLaborPermission);
router.delete('/:id', verifyToken, verifyModuleAccess('labor_permissions', 'delete'), laborPermissionsController.deleteLaborPermission);

module.exports = router;
