// src/middlewares/logisticsCircuitBreaker.ts
// BRIEF #056 - TASK 56.1: Middleware guardián de rutas logísticas.
//
// Cuando el circuito está OPEN, bloquea las llamadas automáticas ANTES de tocar
// el controller, devolviendo HTTP 503 con código estructurado LOGISTICS_UNAVAILABLE
// (contrato esperado por el frontend en Task 56.3).
//
// IMPORTANTE: este chequeo es 100% en memoria (<1ms), por lo que no agrega
// latencia perceptible al checkout (requisito: p95 < 50ms).

import { Response, NextFunction } from 'express';
import { isCallAllowed, getCircuitStatus } from '../services/neoMandadosService';
import { AuthRequest } from './authMiddleware';

export const logisticsCircuitGuard = (req: AuthRequest, res: Response, next: NextFunction) => {
    if (!isCallAllowed()) {
        const status = getCircuitStatus();
        // Respuesta estructurada: el frontend detecta por code === 'LOGISTICS_UNAVAILABLE'
        return res.status(503).json({
            code: 'LOGISTICS_UNAVAILABLE',
            message:
                'Estamos teniendo dificultades temporales con nuestro servicio de envíos. Tu pedido será procesado automáticamente al restablecerse el servicio.',
            retryAfterSeconds: 60, // Coincide con el timeout de recuperación HALF_OPEN
            circuit: {
                state: status.state,
                failureRatePct: status.failureRatePct,
                openedAt: status.openedAt,
            },
        });
    }
    next();
};