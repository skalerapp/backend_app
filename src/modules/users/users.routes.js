const express = require('express');
const router = express.Router();
const userController = require('./users.controller');
const { verifyToken, verifyModuleAccess } = require('../../middleware/auth.middleware');

// Rutas de usuarios
router.get('/', verifyToken, verifyModuleAccess('users', 'read'), userController.getUsers);
router.post('/', verifyToken, verifyModuleAccess('users', 'create'), userController.createUser);
router.put('/:id', verifyToken, verifyModuleAccess('users', 'update'), userController.updateUser);

module.exports = router;
