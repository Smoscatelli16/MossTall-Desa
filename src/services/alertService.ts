// src/services/alertService.ts
// BRIEF #056 - TASK 56.4: Auditoría y Alertas Proactivas vía PostHog (server-side)
//
// Emite eventos críticos de resiliencia logística hacia PostHog usando REST API
// (capture server-side). No rompe el build si POSTHOG_PROJECT_KEY no está configurado.
//
// EVENTOS DEFINIDOS (documentados para wiki interna):
//   logistics_circuit_open           -> Alerta inmediata de caída del proveedor
//   logistics_circuit_closed         -> Recuperación confirmada del servicio
//   logistics_queue_overflow         -> Más de 20 pedidos en cola (saturación)
//   logistics_manual_override_created-> Agotados 5 intentos: requiere operador humano

const POSTHOG_HOST = process.env.POSTHOG_HOST || 'https://us.i.posthog.com';
const POSTHOG_PROJECT_KEY = process.env.POSTHOG_PROJECT_KEY || '';

// Identificador de "sistema" para eventos que no pertenecen a un usuario real
const SYSTEM_DISTINCT_ID = 'system:logistics-daemon';

/** Envío fire-and-forget: nunca bloquea ni ensucia el flujo transaccional */
async function capture(eventName: string, properties: Record<string, unknown>, distinctId: string = SYSTEM_DISTINCT_ID): Promise<void> {
    if (!POSTHOG_PROJECT_KEY) {
        // Sin clave configurada: degradar silenciosamente a log local
        console.log(`📊 [PostHog:OFFLINE] ${eventName}`, JSON.stringify(properties));
        return;
    }

    try {
        await fetch(`${POSTHOG_HOST}/capture/`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                api_key: POSTHOG_PROJECT_KEY,
                event: eventName,
                distinct_id: distinctId,
                properties: { ...properties, $lib: 'mission-vende-backend' },
            }),
        });
    } catch (err: any) {
        // Las alertas NUNCA pueden tumbar una operación de negocio
        console.error('⚠️ [AlertService] No se pudo emitir evento PostHog:', err?.message);
    }
}

// --- Eventos específicos del Brief #056 ---

export const alertLogisticsCircuitOpen = (meta: Record<string, unknown>) =>
    capture('logistics_circuit_open', { severity: 'CRITICAL', ...meta });

export const alertLogisticsCircuitClosed = (meta: Record<string, unknown> = {}) =>
    capture('logistics_circuit_closed', { severity: 'INFO', ...meta });

export const alertLogisticsQueueOverflow = (queueSize: number) =>
    capture('logistics_queue_overflow', { severity: 'WARNING', queueSize, threshold: 20 });

export const alertManualOverrideCreated = (entry: { id: string; transactionId: string; attempts: number; lastError?: string }) =>
    capture('logistics_manual_override_created', {
        severity: 'CRITICAL',
        queueEntryId: entry.id,
        transactionId: entry.transactionId,
        attemptsExhausted: entry.attempts,
        lastError: entry.lastError,
    });