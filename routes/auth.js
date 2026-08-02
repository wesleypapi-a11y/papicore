const express = require('express');
const authController = require('../controllers/authController');
const { requireAuth } = require('../middlewares/auth');

const router = express.Router();

router.post('/login', authController.login);
router.get('/me', requireAuth, authController.me);

module.exports = router;
