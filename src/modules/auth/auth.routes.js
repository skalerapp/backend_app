const express = require('express');
const router = express.Router();
const { body } = require('express-validator');
const authController = require('./auth.controller');
const { verifyToken, verifyTokenForSessionStatus } = require('../../middleware/auth.middleware');

// Rutas de autenticación con validaciones
router.post('/register', [
	body('email').isEmail().withMessage('Email inválido'),
	body('password').isLength({ min: 6 }).withMessage('La contraseña debe tener al menos 6 caracteres'),
	body('name').notEmpty().withMessage('El nombre es requerido')
], authController.register);

router.post('/login', [
	body('email').notEmpty().withMessage('Email o usuario es requerido'),
	body('password').notEmpty().withMessage('La contraseña es requerida')
], authController.login);

router.post('/refresh-token', verifyToken, authController.refreshToken);
router.post('/logout', verifyToken, authController.logout);
router.post('/web-launch-ticket', verifyToken, authController.createTemporaryWebLaunch);
router.get('/web-launch/:ticket/status', authController.webLaunchTicketStatus);
router.get('/web-launch/:ticket', authController.previewWebLaunch);
router.post('/web-session/consume', authController.consumeTemporaryWebLaunch);
router.post('/session/heartbeat', verifyToken, authController.heartbeatSession);
router.get('/session/status', verifyTokenForSessionStatus, authController.sessionStatus);

module.exports = router;
