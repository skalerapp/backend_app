const express = require('express');
const router = express.Router();
const controller = require('./allowances.controller');
const { verifyToken, verifyModuleAccess, verifyRole } = require('../../middleware/auth.middleware');

router.get('/', verifyToken, verifyModuleAccess('allowances', 'read'), controller.listAllowances);
router.get('/requests', verifyToken, verifyModuleAccess('allowances', 'read'), controller.listAllowanceRequests);
router.get('/project/:projectId', verifyToken, verifyModuleAccess('allowances', 'read'), controller.getAllowanceByProject);
router.post('/assign', verifyToken, verifyModuleAccess('allowances', 'create'), controller.assignAllowance);
router.post('/requests', verifyToken, verifyRole('leader', 'supervisor', 'coordinator_operations', 'commercial'), controller.createAllowanceRequest);
router.patch('/requests/:requestId/status', verifyToken, verifyRole('administrative', 'gerencial'), controller.updateAllowanceRequestStatus);
router.get('/project/:projectId/expenses', verifyToken, verifyModuleAccess('allowances', 'read'), controller.listExpensesByProject);
router.post('/project/:projectId/expenses', verifyToken, verifyModuleAccess('allowances', 'update'), controller.addExpense);
router.patch('/project/:projectId/expenses/:expenseId/request', verifyToken, verifyModuleAccess('allowances', 'update'), controller.reclassifyExpenseToRequest);

module.exports = router;
