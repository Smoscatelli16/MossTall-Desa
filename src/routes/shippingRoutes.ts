import { Router } from 'express';
import { 
    calculateShippingCost, 
    markReadyForPickup, 
    neoMandadosWebhook 
} from '../controllers/shippingController';
import { verifyToken } from '../middlewares/authMiddleware';

const router = Router();

// Endpoint público para consulta de tarifa en tiempo real desde el Checkout
router.post('/calculate-cost', calculateShippingCost);

// Endpoint protegido (Vendedor): Cambia estado logístico a READY_FOR_PICKUP
router.post('/ready-for-pickup', verifyToken, markReadyForPickup);

// Webhook de Neo Mandados (Público para el partner logístico, valida payload internamente)
router.post('/webhook/neo-mandados', neoMandadosWebhook);

export default router;