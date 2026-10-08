// src/routes/userRoutes.ts
import { Router } from 'express';
import { 
    getDashboard, 
    getUserProfile, 
    updateUserProfile, 
    getPublicProfile,
    getBankingDetails,
    updateBankingDetails,
    getMyNeeds // <-- NUEVA FUNCIÓN IMPORTADA
} from '../controllers/userController';
import { authMiddleware } from '../middlewares/authMiddleware';

const router = Router();

// 1. DASHBOARD INTEGRAL
router.get('/user/dashboard', authMiddleware, getDashboard);

// 2. PERFIL PROFESIONAL (EDICIÓN)
router.get('/user/profile', authMiddleware, getUserProfile);
router.put('/user/profile', authMiddleware, updateUserProfile);

// 3. PERFIL PÚBLICO (VISTA CLIENTE)
router.get('/user/:userId/public-profile', getPublicProfile);

// 4. SISTEMA BANCARIO (CBU/CVU)
router.get('/user/banking', authMiddleware, getBankingDetails);
router.patch('/user/banking', authMiddleware, updateBankingDetails);

// 5. NUEVA RUTA: MIS PEDIDOS (MERCADO INVERSO)
router.get('/user/needs', authMiddleware, getMyNeeds);

export default router;