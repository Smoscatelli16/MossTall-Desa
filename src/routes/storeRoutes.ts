// src/routes/storeRoutes.ts
import { Router } from 'express';
import { getStores, getMyStores, getStoreById, createStore, updateStore } from '../controllers/storeController';
import { authMiddleware } from '../middlewares/authMiddleware';

const router = Router();

// Rutas Públicas
router.get('/stores', getStores);
router.get('/stores/:id', getStoreById); // <-- ESTA ES LA RUTA QUE FALTA O NO SE GUARDÓ

// Rutas Protegidas
router.get('/user/stores', authMiddleware, getMyStores);
router.post('/stores', authMiddleware, createStore);
router.patch('/stores/:id', authMiddleware, updateStore);

export default router;