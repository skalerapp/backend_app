const express = require('express');
const router = express.Router();
const commercialController = require('./commercial.controller');
const { verifyToken, verifyModuleAccess } = require('../../middleware/auth.middleware');

router.get('/form-templates', verifyToken, verifyModuleAccess('commercial', 'read'), commercialController.getCommercialFormTemplates);
router.get('/summary', verifyToken, verifyModuleAccess('commercial', 'read'), commercialController.getCommercialSummary);
router.get('/board', verifyToken, verifyModuleAccess('commercial', 'read'), commercialController.getCommercialBoard);
router.get('/client-history', verifyToken, verifyModuleAccess('commercial', 'read'), commercialController.getCommercialClientHistory);
router.get('/clients', verifyToken, verifyModuleAccess('commercial', 'read'), commercialController.listCommercialClients);
router.get('/clients/:id', verifyToken, verifyModuleAccess('commercial', 'read'), commercialController.getCommercialClientById);
router.get('/visits/:id/nearby-places', verifyToken, verifyModuleAccess('commercial', 'read'), commercialController.getVisitNearbyPlaces);
router.get('/visits', verifyToken, verifyModuleAccess('commercial', 'read'), commercialController.getCommercialVisits);
router.get('/opportunities', verifyToken, verifyModuleAccess('commercial', 'read'), commercialController.getCommercialOpportunities);
router.post('/form-templates', verifyToken, verifyModuleAccess('commercial', 'create'), commercialController.createCommercialFormTemplate);
router.post('/visits', verifyToken, verifyModuleAccess('commercial', 'create'), commercialController.createCommercialVisit);
router.post('/clients', verifyToken, verifyModuleAccess('commercial', 'create'), commercialController.createCommercialClient);
router.put('/clients/:id', verifyToken, verifyModuleAccess('commercial', 'update'), commercialController.updateCommercialClient);
router.put('/form-templates/:id', verifyToken, verifyModuleAccess('commercial', 'update'), commercialController.updateCommercialFormTemplate);
router.put('/visits/:id', verifyToken, verifyModuleAccess('commercial', 'update'), commercialController.updateCommercialVisit);
router.post('/opportunities', verifyToken, verifyModuleAccess('commercial', 'create'), commercialController.createCommercialOpportunity);
router.put('/opportunities/:id', verifyToken, verifyModuleAccess('commercial', 'update'), commercialController.updateCommercialOpportunity);
router.post('/quotations', verifyToken, verifyModuleAccess('commercial', 'create'), commercialController.createQuotation);
router.get('/quotations', verifyToken, verifyModuleAccess('commercial', 'read'), commercialController.listQuotations);
router.get('/quotations/:id', verifyToken, verifyModuleAccess('commercial', 'read'), commercialController.getQuotationById);
router.patch('/quotations/:id/approve', verifyToken, verifyModuleAccess('commercial', 'update'), commercialController.approveQuotation);

module.exports = router;