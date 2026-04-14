const express = require('express');
const router = express.Router();
const activityController = require('./activities.controller');
const { verifyToken, verifyModuleAccess } = require('../../middleware/auth.middleware');

// Rutas de actividades
router.get('/', verifyToken, verifyModuleAccess('activities', 'read'), activityController.getActivities);
router.get('/:id', verifyToken, verifyModuleAccess('activities', 'read'), activityController.getActivityById);
router.post('/', verifyToken, verifyModuleAccess('activities', 'create'), activityController.createActivity);
router.put('/:id', verifyToken, verifyModuleAccess('activities', 'update'), activityController.updateActivity);
router.delete('/:id', verifyToken, verifyModuleAccess('activities', 'delete'), activityController.deleteActivity);

module.exports = router;