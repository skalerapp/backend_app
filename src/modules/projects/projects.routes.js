const express = require('express');
const router = express.Router();
const projectController = require('./projects.controller');
const { verifyToken, verifyModuleAccess } = require('../../middleware/auth.middleware');

// Rutas de proyectos
router.get('/', verifyToken, verifyModuleAccess('projects', 'read'), projectController.getProjects);
router.get('/next-ot', verifyToken, verifyModuleAccess('projects', 'create'), projectController.getNextOtCode);
router.get('/:id', verifyToken, verifyModuleAccess('projects', 'read'), projectController.getProjectById);
router.get('/:id/consolidated-history', verifyToken, verifyModuleAccess('projects', 'read'), projectController.getProjectConsolidatedHistory);
router.get('/:id/collaborators', verifyToken, verifyModuleAccess('projects', 'read'), projectController.getProjectCollaborators);
router.post('/', verifyToken, verifyModuleAccess('projects', 'create'), projectController.createProject);
router.post('/:id/collaborators', verifyToken, verifyModuleAccess('projects', 'update'), projectController.assignCollaboratorToProject);
router.put('/:id', verifyToken, verifyModuleAccess('projects', 'update'), projectController.updateProject);
router.delete('/:id/collaborators/:employeeId', verifyToken, verifyModuleAccess('projects', 'update'), projectController.removeCollaboratorFromProject);
router.delete('/:id', verifyToken, verifyModuleAccess('projects', 'delete'), projectController.deleteProject);

module.exports = router;
