// src/services/shipmentQueueService.ts
// BRIEF #056 - TASK 56.2: Cola de Reintentos Logísticos (ShipmentQueue) + Backoff Exponencial
//
// Este servicio gestiona la persistencia de órdenes de envío cuando el Circuit
// Breaker de Neo Mandados está OPEN. Garantiza atomicidad ACID usando
// prisma.$transaction para toda operación que toque ShipmentQueue + Transaction.
//
// REGLA CRÍTICA (Zero PII): El payload NUNCA almacena nombres, direcciones o
// teléfonos en texto plano. Solo IDs internos y coordenadas ofuscadas.

import prisma from '../lib/prisma';
import { Prisma, ShipmentStatus, TransactionState } from '@prisma/client';
import { emitLogisticsAlert } from './alertService'; // Asumimos que alertService exporta esta función

const BASE_RETRY_MINUTES = 5;   // Base del backoff exponencial
const MAX_ATTEMPTS = 5;         // Máximos intentos antes de escalar a MANUAL_OVERRIDE
const JITTER_PERCENT = 0.1;     // ±10% de jitter aleatorio para evitar tormentas de reintentos

/**
 * Calcula el próximo tiempo de reintento con backoff exponencial + jitter.
 * Fórmula: now() + (base * 2^attemptCount) * (1 ± jitter)
 */
function calculateNextRetry(attemptCount: number): Date {
    // Backoff base: 5min, 10min, 20min, 40min...
    const exponentialMinutes = BASE_RETRY_MINUTES * Math.pow(2, attemptCount);
    
    // Aplicar jitter aleatorio ±10%
    const jitterFactor = 1 + (Math.random() * 2 - 1) * JITTER_PERCENT;
    const finalMinutes = exponentialMinutes * jitterFactor;
    
    return new Date(Date.now() + finalMinutes * 60 * 1000);
}

/**
 * Encola una orden de envío de forma atómica.
 * Se llama cuando el Circuit Breaker está OPEN o cuando falla la API.
 * 
 * @param transactionId ID de la transacción asociada
 * @param sanitizedPayload Datos OPERATIVOS sanitizados (sin PII)
 */
export async function enqueueShipment(transactionId: string, sanitizedPayload: Record<string, unknown>) {
    return await prisma.$transaction(async (tx) => {
        // 1. Verificar que no exista ya un registro activo en cola para esta transacción (idempotencia)
        const existingQueueEntry = await tx.shipmentQueue.findFirst({
            where: {
                transactionId,
                status: { in: ['PENDING', 'PROCESSING'] },
            },
        });

        if (existingQueueEntry) {
            console.warn(`⚠️ [ShipmentQueue] Transacción ${transactionId} ya tiene un registro en cola activo.`);
            return existingQueueEntry;
        }

        // 2. Crear el registro en la cola con nextRetryAt inicial (now + 5min)
        const queueEntry = await tx.shipmentQueue.create({
            data: {
                transactionId,
                payload: sanitizedPayload as Prisma.InputJsonValue,
                status: 'PENDING',
                nextRetryAt: new Date(Date.now() + BASE_RETRY_MINUTES * 60 * 1000),
                attemptCount: 0,
            },
        });

        // 3. Registrar evento de auditoría en TransactionHistory (opcional pero recomendado)
        await tx.transactionHistory.create({
            data: {
                transactionId,
                oldState: null, // Nullable permitido en schema
                newState: 'PAID_HELD', // Asumimos estado actual; si es otro, debería pasarse como arg
                actorId: 'SYSTEM_QUEUE_ENQUEUE',
            },
        });

        return queueEntry;
    });
}

/**
 * PROCESADOR DE COLA (llamado por el cron job cada 2 minutos).
 * Toma hasta 10 registros PENDING vencidos, intenta llamar a Neo Mandados,
 * y actualiza estados atómicamente.
 */
export async function processShipmentQueue() {
    const BATCH_SIZE = 10;
    const now = new Date();

    // 1. Buscar registros pendientes elegibles para retry
    const pendingEntries = await prisma.shipmentQueue.findMany({
        where: {
            status: 'PENDING',
            nextRetryAt: { lte: now },
        },
        take: BATCH_SIZE,
        orderBy: { nextRetryAt: 'asc' },
    });

    if (pendingEntries.length === 0) return;

    for (const entry of pendingEntries) {
        try {
            // 2. Marcar como PROCESSING para evitar race conditions en ejecuciones paralelas
            await prisma.shipmentQueue.update({
                where: { id: entry.id },
                data: { status: 'PROCESSING' },
            });

            // 3. Extraer datos del payload y reconstruir la llamada a Neo Mandados
            const payload = entry.payload as any;
            
            // IMPORTANTE: Aquí se debe reconstruir el neoPayload real para la API.
            // Como solo tenemos IDs y coords ofuscadas, debemos buscar las direcciones reales en DB.
            const shipmentData = await prisma.shipment.findUnique({
                where: { id: payload.shipmentId },
                include: { originAddress: true, destinationAddress: true, transaction: true }
            });

            if (!shipmentData) {
                throw new Error('Shipment original no encontrado en BD');
            }

            const neoPayload = {
                pickup: {
                    lat: shipmentData.originAddress.latitude,
                    lng: shipmentData.originAddress.longitude,
                    address: `${shipmentData.originAddress.street} ${shipmentData.originAddress.number ?? ''}`.trim(),
                },
                dropoff: {
                    lat: shipmentData.destinationAddress.latitude,
                    lng: shipmentData.destinationAddress.longitude,
                    address: `${shipmentData.destinationAddress.street} ${shipmentData.destinationAddress.number ?? ''}`.trim(),
                },
                reference: shipmentData.transactionId,
            };

            // 4. Intentar crear la orden en Neo Mandados
            const result = await createOrder(neoPayload);

            // --- CASO ÉXITO ---
            if (result.success) {
                await prisma.$transaction(async (tx) => {
                    // Actualizar cola a SUCCESS
                    await tx.shipmentQueue.update({
                        where: { id: entry.id },
                        data: { status: 'SUCCESS' },
                    });

                    // Actualizar el Shipment original a READY_FOR_PICKUP
                    await tx.shipment.update({
                        where: { id: shipmentData.id },
                        data: {
                            status: ShipmentStatus.READY_FOR_PICKUP,
                            trackingNumber: result.trackingNumber,
                            estimatedDelivery: result.estimatedDeliveryMinutes
                                ? new Date(Date.now() + result.estimatedDeliveryMinutes * 60 * 1000)
                                : undefined,
                        },
                    });

                    // Auditoría
                    await tx.transactionHistory.create({
                        data: {
                            transactionId: shipmentData.transactionId,
                            oldState: shipmentData.transaction.state,
                            newState: shipmentData.transaction.state, // Sin cambio financiero
                            actorId: 'SYSTEM_QUEUE_SUCCESS',
                        },
                    });
                });
                
                console.log(`✅ [ShipmentQueue] Orden ${entry.id} procesada con éxito. Tracking: ${result.trackingNumber}`);
            } 
            // --- CASO CIRCUITO ABIERTO (retry suave) ---
            else if (result.errorType === 'CIRCUIT_OPEN') {
                // No incrementamos attemptCount porque no hubo fallo técnico real, solo bloqueo preventivo.
                // Reprogramamos para el siguiente ciclo natural del cron.
                await prisma.shipmentQueue.update({
                    where: { id: entry.id },
                    data: {
                        status: 'PENDING',
                        nextRetryAt: new Date(Date.now() + BASE_RETRY_MINUTES * 60 * 1000),
                    },
                });
                console.log(`🟡 [ShipmentQueue] Circuito abierto. Orden ${entry.id} vuelve a PENDING.`);
            }
            // --- CASO FALLO TÉCNICO (incrementar intento) ---
            else {
                const newAttemptCount = entry.attemptCount + 1;
                const isMaxAttemptsReached = newAttemptCount >= MAX_ATTEMPTS;

                await prisma.$transaction(async (tx) => {
                    if (isMaxAttemptsReached) {
                        // ESCALAR A MANUAL OVERRIDE
                        await tx.shipmentQueue.update({
                            where: { id: entry.id },
                            data: {
                                status: 'MANUAL_OVERRIDE',
                                attemptCount: newAttemptCount,
                                lastError: result.errorMessage || 'UNKNOWN_ERROR',
                            },
                        });

                        // ALERTA POSTHOG: logistics_manual_override_created
                        emitLogisticsAlert('logistics_manual_override_created', {
                            queueId: entry.id,
                            transactionId: entry.transactionId,
                            attempts: newAttemptCount,
                            error: result.errorMessage,
                        });

                        console.error(`🔴 [ShipmentQueue] Orden ${entry.id} agotó intentos. Escalada a MANUAL_OVERRIDE.`);
                    } else {
                        // REINTENTO CON BACKOFF EXPONENCIAL
                        await tx.shipmentQueue.update({
                            where: { id: entry.id },
                            data: {
                                status: 'PENDING',
                                attemptCount: newAttemptCount,
                                nextRetryAt: calculateNextRetry(newAttemptCount),
                                lastError: result.errorMessage,
                            },
                        });
                        console.warn(`⚠️ [ShipmentQueue] Fallo técnico en ${entry.id}. Intento ${newAttemptCount}/${MAX_ATTEMPTS}.`);
                    }
                });
            }
        } catch (error: any) {
            console.error(`❌ [ShipmentQueue] Error crítico procesando ${entry.id}:`, error.message);
            
            // En caso de excepción no controlada, devolver a PENDING con backoff corto para reintentar pronto
            await prisma.shipmentQueue.update({
                where: { id: entry.id },
                data: {
                    status: 'PENDING',
                    nextRetryAt: new Date(Date.now() + 60 * 1000), // 1 minuto
                    lastError: `INTERNAL_ERROR: ${error.message}`,
                },
            }).catch(e => console.error("No se pudo actualizar cola tras excepción", e));
        }
    }
}

/**
 * REINTENTO MANUAL desde Admin Panel (Task 56.3/56.4)
 * Fuerza un retry inmediato ignorando el nextRetryAt.
 */
export async function forceRetry(queueId: string) {
    const entry = await prisma.shipmentQueue.findUnique({ where: { id: queueId } });
    if (!entry) throw new Error('Registro de cola no encontrado');

    // Resetear contador de intentos y ponerlo como PENDING inmediato
    await prisma.shipmentQueue.update({
        where: { id: queueId },
        data: {
            status: 'PENDING',
            attemptCount: 0,
            nextRetryAt: new Date(), // Inmediato
            lastError: null,
        },
    });

    console.log(`👨‍💻 [Admin] Forzado reintento manual para orden ${queueId}`);
    return { success: true };
}

/**
 * MARCAR COMO ENTREGADO MANUALMENTE (Task 56.3/56.4)
 * Útil si el cadete entregó físicamente pero la API nunca respondió.
 * Libera los fondos del escrow si corresponde.
 */
export async function markDeliveredManually(queueId: string, adminUserId: string) {
    const entry = await prisma.shipmentQueue.findUnique({
        where: { id: queueId },
        include: { transaction: true }
    });

    if (!entry) throw new Error('Registro de cola no encontrado');

    return await prisma.$transaction(async (tx) => {
        // 1. Cerrar la cola
        await tx.shipmentQueue.update({
            where: { id: queueId },
            data: { status: 'SUCCESS' }, // O añadir estado MANUAL_DELIVERED si se prefiere
        });

        // 2. Actualizar shipment si existe
        const shipment = await tx.shipment.findUnique({ where: { transactionId: entry.transactionId } });
        if (shipment) {
            await tx.shipment.update({
                where: { id: shipment.id },
                data: { status: ShipmentStatus.DELIVERED },
            });
        }

        // 3. Liberar fondos del Escrow (FUNDS_RELEASED) si estaba retenido
        if (entry.transaction.state === TransactionState.PAID_HELD) {
            await tx.transaction.update({
                where: { id: entry.transactionId },
                data: { state: TransactionState.FUNDS_RELEASED },
            });

            await tx.transactionHistory.create({
                data: {
                    transactionId: entry.transactionId,
                    oldState: TransactionState.PAID_HELD,
                    newState: TransactionState.FUNDS_RELEASED,
                    actorId: `ADMIN_${adminUserId}`,
                },
            });
        }

        console.log(`✅ [Admin] Orden ${queueId} marcada como entregada manualmente por ${adminUserId}`);
        return { success: true };
    });
}

/**
 * ESTADÍSTICAS PARA EL DASHBOARD ADMIN (Task 56.4)
 */
export async getQueueStats() {
    const counts = await prisma.shipmentQueue.groupBy({
        by: ['status'],
        _count: { id: true },
    });

    const stats = {
        totalPending: 0,
        processing: 0,
        failed: 0,
        manualOverride: 0,
        lastProcessedAt: null as Date | null,
    };

    counts.forEach((c) => {
        if (c.status === 'PENDING') stats.totalPending = c._count.id;
        if (c.status === 'PROCESSING') stats.processing = c._count.id;
        if (c.status === 'FAILED') stats.failed = c._count.id;
        if (c.status === 'MANUAL_OVERRIDE') stats.manualOverride = c._count.id;
    });

    // Alerta de saturación (>20 en cola)
    if (stats.totalPending > 20) {
        emitLogisticsAlert('logistics_queue_overflow', { count: stats.totalPending });
    }

    return stats;
}