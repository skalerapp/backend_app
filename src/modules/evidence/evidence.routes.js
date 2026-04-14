const express = require('express');
const router = express.Router();
const evidenceController = require('./evidence.controller');
const { verifyToken } = require('../../middleware/auth.middleware');
const upload = require('../../middleware/upload.middleware');

// Subir evidencia (multipart/form-data) campo `file`
router.post('/upload', verifyToken, upload.single('file'), evidenceController.uploadEvidence);

// Listar evidencias (opcional query: activity_id, module_type)
router.get('/', verifyToken, evidenceController.listEvidence);

module.exports = router;
