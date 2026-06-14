const express = require('express');
const router = express.Router();
const controller = require('./tasks.controller');
const { verifyToken, verifyModuleAccess } = require('../../middleware/auth.middleware');

router.get('/', verifyToken, verifyModuleAccess('tasks', 'read'), controller.listTasks);
router.post('/', verifyToken, verifyModuleAccess('tasks', 'create'), controller.createTask);
router.put('/:id', verifyToken, verifyModuleAccess('tasks', 'update'), controller.updateTask);
router.delete('/:id', verifyToken, verifyModuleAccess('tasks', 'delete'), controller.deleteTask);

module.exports = router;
