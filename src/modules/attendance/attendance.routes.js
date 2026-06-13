const express = require('express');
const router = express.Router();
const attendanceController = require('./attendance.controller');
const { verifyToken, verifyModuleAccess } = require('../../middleware/auth.middleware');

router.get('/export/report', verifyToken, verifyModuleAccess('attendance', 'read'), attendanceController.exportAttendanceReport);
router.get('/', verifyToken, verifyModuleAccess('attendance', 'read'), attendanceController.getAttendance);
router.get('/:id', verifyToken, verifyModuleAccess('attendance', 'read'), attendanceController.getAttendanceById);
router.post('/check-in', verifyToken, verifyModuleAccess('attendance', 'create'), attendanceController.checkInAttendance);
router.put('/:id/check-out', verifyToken, verifyModuleAccess('attendance', 'update'), attendanceController.checkOutAttendance);

module.exports = router;
