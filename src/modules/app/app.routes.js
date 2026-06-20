const express = require('express');
const appController = require('./app.controller');

const router = express.Router();

router.get('/version', appController.getAppVersionInfo);

module.exports = router;
