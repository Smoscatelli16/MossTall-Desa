// src/routes/shippingRoutes.ts
import { Router } from 'express';
// CORREGIDO: authMiddleware exporta 'authMiddleware' (no existe 'authenticateToken' ni 'verifyToken')
import { authMiddleware } from '../middlewares/authMiddleware';
// BRIEF #056: Guardián de circuito abierto (devuelve 503 LOGISTICS_UNAVAILABLE si el CB está OPEN)
import { logisticsCircuitGuard } from '../middlewares/logisticsCircuitBreaker';
import {
  calculateShippingCost,
  markReadyForPickup,
  neoMandadosWebhook,
} from '../controllers/shippingController';

const router = Router();

// --- Rutas de Cotización (Requieren Usuario Autenticado) ---

// POST /api/shipping/calculate-cost - Calcula costo de envío antes del checkout.
// NOTA #056: Es un cálculo LOCAL (Haversine + tarifas), NO llama a Neo Mandados,
// por lo que NO se protege con el guardián: la tarifa nunca se degrada.
router.post('/calculate-cost', authMiddleware, calculateShippingCost);

// --- Flujo Interno (Vendedor -> Recolector) ---

// PATCH /api/shipping/ready-for-pickup - El vendedor marca el paquete listo
// BRIEF #056: Protegido con logisticsCircuitGuard. Si el Circuit Breaker está OPEN,
// responde 503 LOGISTICS_UNAVAILABLE sin ejecutar el controlador (degradación elegante).
router.patch('/ready-for-pickup', authMiddleware, logisticsCircuitGuard, markReadyForPickup);

// --- Webhook del Proveedor (Sin autenticación JWT: Neo Mandados no posee token) ---

// POST /api/shipping/webhook/neo-mandados - Callback de estados logísticos.
// En producción debe validarse firma criptográfica (x-neo-signature).
// No lleva authMiddleware ni circuitGuard: es entrada pasiva de eventos.
router.post('/webhook/neo-mandados', neoMandadosWebhook);

export default router;