const express = require('express');
const router = express.Router();
const controller = require('./operationalScopes.controller');
const { verifyToken, verifyModuleAccess } = require('../../middleware/auth.middleware');

router.get('/', verifyToken, verifyModuleAccess('operational_scopes', 'read'), controller.listOperationalAssignments);
router.post('/', verifyToken, verifyModuleAccess('operational_scopes', 'create'), controller.upsertOperationalAssignment);
router.delete('/:id', verifyToken, verifyModuleAccess('operational_scopes', 'delete'), controller.deleteOperationalAssignment);

module.exports = router;
