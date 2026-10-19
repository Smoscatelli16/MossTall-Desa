// src/routes/authRoutes.ts
import { Router } from 'express';
import { register, login } from '../controllers/authController';
import { sendOtp, verifyOtp } from '../controllers/otpController';

const router = Router();

// Definimos las rutas generales
router.post('/register', register);
router.post('/login', login);

// Rutas de Verificación OTP vía WhatsApp (Brief #050)
router.post('/send-otp', sendOtp);
router.post('/verify-otp', verifyOtp);

export default router;