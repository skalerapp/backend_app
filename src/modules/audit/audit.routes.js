const express = require('express');
const router = express.Router();
const auditController = require('./audit.controller');
const { verifyToken, verifyModuleAccess } = require('../../middleware/auth.middleware');

router.get('/', verifyToken, verifyModuleAccess('audit', 'read'), auditController.listAuditLogs);

module.exports = router;