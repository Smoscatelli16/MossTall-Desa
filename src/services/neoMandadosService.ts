// src/services/neoMandadosService.ts
// BRIEF #056 - TASK 56.1: Circuit Breaker + Health Check Pasivo para Neo Mandados
//
// Este módulo envuelve TODAS las llamadas salientes a la API de Neo Mandados.
// Registra latencia y errores en una ventana deslizante de 5 minutos y decide
// automáticamente si el proveedor está sano (CLOSED), caído (OPEN) o en prueba
// de recuperación (HALF_OPEN).
//
// MODO SIMULADO: Como todavía no existe contrato real con Neo Mandados, el
// servicio simula las respuestas por defecto. Se controla con variables de entorno:
//   NEO_MANDADOS_SIMULATION=true|false        (default: true)
//   NEO_MANDADOS_FORCE_FAILURE=true|false     (para PRUEBAS DE CAOS del brief)
//   NEO_MANDADOS_API_URL / NEO_MANDADOS_API_KEY (se usarán cuando haya API real)

import prisma from '../lib/prisma';

// --- Tipos y constantes del circuito ---

export type CircuitState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

interface CallRecord {
    timestamp: number;   // Momento de la llamada (ms epoch)
    latencyMs: number;   // Latencia medida de la respuesta
    failed: boolean;     // true si fue error de red, timeout o HTTP 5xx
    errorType?: string;  // Clasificación del error: NETWORK | TIMEOUT | HTTP_5XX | HTTP_4XX
}

const WINDOW_MS = 5 * 60 * 1000;      // Ventana deslizante de 5 minutos (health check pasivo)
const FAILURE_THRESHOLD = 3;          // 3 fallos consecutivos => OPEN (DoD del brief)
const CONSECUTIVE_WINDOW_MS = 1000;   // Los fallos deben ocurrir en menos de 1 segundo corrido
const RECOVERY_TIMEOUT_MS = 60 * 1000; // A los 60s en OPEN se pasa a HALF_OPEN automáticamente
const MAX_LATENCY_MS = 30000;         // Latencia > 30s se considera fallo (prueba de caos #2)

const SIMULATION_MODE = process.env.NEO_MANDADOS_SIMULATION !== 'false';
const API_URL = process.env.NEO_MANDADOS_API_URL || 'https://api.neomandados.com/v1';
const API_KEY = process.env.NEO_MANDADOS_API_KEY || '';

// --- Estado interno del circuito (singleton en memoria) ---

let circuitState: CircuitState = 'CLOSED';
let openedAt: number | null = null;              // Cuándo pasó a OPEN (para el timeout de 60s)
let halfOpenInFlight = false;                     // Evita concurrencia de pruebas en HALF_OPEN
const callWindow: CallRecord[] = [];              // Ventana deslizante de llamadas observadas
let consecutiveFailures = 0;                      // Contador de fallos consecutivos
let lastFailureAt: number | null = null;          // Timestamp del último fallo (para ventana de 1s)
let lastErrorInfo: { message: string; at: number } | null = null; // Último error para /status

// Callbacks registrados (el middleware inyecta la alerta PostHog sin crear dependencia circular)
type CircuitListener = (event: 'open' | 'closed', meta: Record<string, unknown>) => void;
const listeners: CircuitListener[] = [];

export const onCircuitTransition = (cb: CircuitListener) => listeners.push(cb);

// --- Funciones núcleo del Circuit Breaker ---

/** Poda la ventana deslizante: elimina registros más viejos que 5 minutos */
function pruneWindow(): void {
    const cutoff = Date.now() - WINDOW_MS;
    while (callWindow.length > 0 && callWindow[0].timestamp < cutoff) {
        callWindow.shift();
    }
}

/** Transición explícita a OPEN: bloquea llamadas automáticas y notifica */
function tripOpen(reason: string): void {
    if (circuitState === 'OPEN') return;
    circuitState = 'OPEN';
    openedAt = Date.now();
    console.error(`🔴 [NeoMandados CB] Circuito ABIERTO. Motivo: ${reason}`);

    // Notificar a los suscriptores (alerta PostHog logistics_circuit_open se dispara ahí)
    listeners.forEach((cb) =>
        cb('open', {
            reason,
            windowCalls: callWindow.length,
            failureRate: getFailureRate(),
            lastError: lastErrorInfo?.message ?? reason,
        })
    );
}

/** Transición a CLOSED tras probar con éxito en HALF_OPEN */
function closeCircuit(): void {
    const wasOpen = circuitState !== 'CLOSED';
    circuitState = 'CLOSED';
    openedAt = null;
    consecutiveFailures = 0;
    halfOpenInFlight = false;
    if (wasOpen) {
        console.log('🟢 [NeoMandados CB] Circuito CERRADO. Servicio logístico recuperado.');
        listeners.forEach((cb) => cb('closed', { recoveredAt: new Date().toISOString() }));
    }
}

/** Tasa de error de la ventana actual (para telemetría y alertas) */
export function getFailureRate(): number {
    pruneWindow();
    if (callWindow.length === 0) return 0;
    const failures = callWindow.filter((c) => c.failed).length;
    return Math.round((failures / callWindow.length) * 100);
}

/** Estado público del circuito para el endpoint admin /status (Task 56.4) */
export function getCircuitStatus() {
    pruneWindow();
    return {
        state: circuitState,
        simulationMode: SIMULATION_MODE,
        openedAt: openedAt ? new Date(openedAt).toISOString() : null,
        consecutiveFailures,
        windowSize: callWindow.length,
        failureRatePct: getFailureRate(),
        avgLatencyMs:
            callWindow.length > 0
                ? Math.round(callWindow.reduce((s, c) => s + c.latencyMs, 0) / callWindow.length)
                : 0,
        lastError: lastErrorInfo,
    };
}

/** ¿Se puede llamar al proveedor ahora mismo? (chequeo barato, sin latencia) */
export function isCallAllowed(): boolean {
    if (circuitState === 'CLOSED') return true;

    if (circuitState === 'OPEN') {
        // Transición automática OPEN -> HALF_OPEN tras 60 segundos
        if (openedAt && Date.now() - openedAt >= RECOVERY_TIMEOUT_MS) {
            circuitState = 'HALF_OPEN';
            halfOpenInFlight = false;
            console.log('🟡 [NeoMandados CB] Circuito en HALF_OPEN: probando recuperación...');
            return true; // Esta primera llamada es la sonda de recuperación
        }
        return false;
    }

    // HALF_OPEN: solo permite UNA llamada sonda a la vez
    return !halfOpenInFlight;
}

/** Registra el resultado de una llamada en la ventana deslizante y evalúa trip */
function recordOutcome(latencyMs: number, failed: boolean, errorType?: string, errorMessage?: string): void {
    pruneWindow();
    callWindow.push({ timestamp: Date.now(), latencyMs, failed, errorType });

    if (failed) {
        lastErrorInfo = { message: errorMessage || errorType || 'UNKNOWN_ERROR', at: Date.now() };

        // Resetear racha si el fallo anterior quedó fuera de la ventana de 1 segundo
        if (lastFailureAt && Date.now() - lastFailureAt > CONSECUTIVE_WINDOW_MS) {
            consecutiveFailures = 0;
        }
        consecutiveFailures += 1;
        lastFailureAt = Date.now();

        if (circuitState === 'HALF_OPEN') {
            // La sonda de recuperación falló: vuelve a OPEN inmediatamente
            circuitState = 'OPEN';
            openedAt = Date.now();
            halfOpenInFlight = false;
            console.warn('🔴 [NeoMandados CB] Sonda HALF_OPEN fallida. El circuito vuelve a OPEN.');
            listeners.forEach((cb) => cb('open', { reason: 'HALF_OPEN_PROBE_FAILED' }));
        } else if (consecutiveFailures >= FAILURE_THRESHOLD) {
            tripOpen(`${FAILURE_THRESHOLD} fallos consecutivos en <${CONSECUTIVE_WINDOW_MS}ms`);
        }
    } else {
        consecutiveFailures = 0;
        if (circuitState === 'HALF_OPEN') {
            // La sonda pasó: recuperación confirmada
            closeCircuit();
        }
    }
}

// --- Llamadas reales / simuladas al proveedor ---

interface CreateOrderResult {
    success: boolean;
    trackingNumber?: string;
    estimatedDeliveryMinutes?: number;
    errorType?: string;
    errorMessage?: string;
}

/** Ejecuta la llamada HTTP REAL a Neo Mandados (se activará con NEO_MANDADOS_SIMULATION=false) */
async function realCreateOrder(payload: Record<string, unknown>): Promise<{ ok: boolean; body?: any; status?: number }> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), MAX_LATENCY_MS);

    try {
        const res = await fetch(`${API_URL}/orders`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${API_KEY}`,
            },
            body: JSON.stringify(payload),
            signal: controller.signal,
        });
        const body = await res.json().catch(() => ({}));
        return { ok: res.ok, body, status: res.status };
    } finally {
        clearTimeout(timeout);
    }
}

/** Simulación determinista para desarrollo y PRUEBAS DE CAOS del Brief #056 */
async function simulatedCreateOrder(): Promise<{ ok: boolean; body?: any; status?: number }> {
    // Fuerza de fallo total: simula "Neo Mandados retorna 500 durante 10 minutos"
    if (process.env.NEO_MANDADOS_FORCE_FAILURE === 'true') {
        await sleep(80);
        return { ok: false, status: 500, body: { error: 'SIMULATED_UPSTREAM_500' } };
    }
    // Fuerza de degradación: simula "latencia > 30s" (aborta por timeout => lo marcamos como fallo)
    if (process.env.NEO_MANDADOS_FORCE_LATENCY === 'true') {
        await sleep(MAX_LATENCY_MS + 1000);
        return { ok: false, status: 0, body: { error: 'SIMULATED_TIMEOUT' } };
    }
    // Modo normal simulado: latencia baja y éxito con tracking sintético
    await sleep(50 + Math.floor(Math.random() * 150));
    return {
        ok: true,
        status: 201,
        body: {
            trackingNumber: `NEO-${Date.now().toString().slice(-6)}-${Math.floor(Math.random() * 1000)}`,
            estimatedDeliveryMinutes: 45,
        },
    };
}

function sleep(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
}

/**
 * FUNCIÓN PÚBLICA: Ordenar un retiro/entrega a Neo Mandados.
 * Protegida por el Circuit Breaker. Si el circuito está OPEN, NO realiza la
 * llamada y devuelve CIRCUIT_OPEN para que el llamador encole (Task 56.2).
 *
 * @param payload Datos OPERATIVOS de la orden (NO se persisten acá; el caller
 *                debe sanitizar antes de encolar — Zero PII Rule #056)
 */
export async function createOrder(payload: Record<string, unknown>): Promise<CreateOrderResult> {
    // 1. Gate del circuit breaker (sin costo de latencia: chequeos en memoria)
    if (!isCallAllowed()) {
        return {
            success: false,
            errorType: 'CIRCUIT_OPEN',
            errorMessage: 'El proveedor logístico está indisponible (circuito abierto).',
        };
    }

    // En HALF_OPEN, marcar que esta llamada es la sonda exclusiva
    if (circuitState === 'HALF_OPEN') halfOpenInFlight = true;

    const start = Date.now();
    try {
        const result = SIMULATION_MODE
            ? await simulatedCreateOrder()
            : await realCreateOrder(payload);

        const latencyMs = Date.now() - start;

        // Timeout o latencia excesiva => se registra como fallo (prueba de caos #2)
        const timedOut = latencyMs >= MAX_LATENCY_MS;
        const failed = !result.ok || timedOut;
        const errorType = failed
            ? timedOut
                ? 'TIMEOUT'
                : (result.status ?? 0) >= 500
                  ? 'HTTP_5XX'
                  : 'HTTP_4XX'
            : undefined;

        recordOutcome(latencyMs, failed, errorType, failed ? `HTTP_${result.status ?? 'NET'} (lat ${latencyMs}ms)` : undefined);

        if (failed) {
            return {
                success: false,
                errorType,
                errorMessage: `Neo Mandados respondió con fallo (${errorType}, status ${result.status}).`,
            };
        }

        return {
            success: true,
            trackingNumber: result.body?.trackingNumber,
            estimatedDeliveryMinutes: result.body?.estimatedDeliveryMinutes,
        };
    } catch (err: any) {
        // Errores de red / abort de fetch caen acá
        const latencyMs = Date.now() - start;
        const isTimeout = err?.name === 'AbortError';
        recordOutcome(latencyMs, true, isTimeout ? 'TIMEOUT' : 'NETWORK', err?.message);
        return {
            success: false,
            errorType: isTimeout ? 'TIMEOUT' : 'NETWORK',
            errorMessage: err?.message || 'Fallo de red contra Neo Mandados.',
        };
    }
}

/**
 * HEALTH CHECK PASIVO (complementario):
 * El brief define el health check como pasivo (basado en tráfico real).
 * Esta función solo expone estadísticas agregadas, jamás hace llamadas extra
 * que puedan añadir latencia al checkout (requisito: Core Web Vitals intactos).
 */
export function getPassiveHealthSnapshot() {
    pruneWindow();
    const recent = callWindow.slice(-20);
    return {
        state: circuitState,
        sampleSize: recent.length,
        failureRatePct: getFailureRate(),
        p95LatencyMs: recent.length
            ? [...recent].sort((a, b) => a.latencyMs - b.latencyMs)[Math.floor(recent.length * 0.95)]?.latencyMs ?? 0
            : 0,
    };
}