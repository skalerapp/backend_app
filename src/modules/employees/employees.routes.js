const express = require('express');
const router = express.Router();
const employeeController = require('./employees.controller');
const { verifyToken, verifyModuleAccess } = require('../../middleware/auth.middleware');

// Rutas de empleados
router.get('/', verifyToken, verifyModuleAccess('employees', 'read'), employeeController.getEmployees);
router.get('/:id', verifyToken, verifyModuleAccess('employees', 'read'), employeeController.getEmployeeById);
router.post('/', verifyToken, verifyModuleAccess('employees', 'create'), employeeController.createEmployee);
router.put('/:id', verifyToken, verifyModuleAccess('employees', 'update'), employeeController.updateEmployee);
router.delete('/:id', verifyToken, verifyModuleAccess('employees', 'delete'), employeeController.deleteEmployee);

module.exports = router;