import { Request, Response } from 'express';
import prisma from '../lib/prisma';
import { AuthRequest } from '../middlewares/authMiddleware';

// Constantes Tarifarias de Neo Mandados (Misiones)
const BASE_FEE = 1500;       // Bajada de bandera / Costo fijo de despacho (ARS)
const PER_KM_RATE = 350;     // Tarifa por kilómetro recorrido (ARS)
const MIN_SHIPPING_COST = 2000; // Tarifa mínima garantizada (ARS)
const ROUTE_MULTIPLIER = 1.3;  // Factor de corrección (distancia lineal -> ruta urbana)

/**
 * Cálculo de distancia Haversine en kilómetros entre dos coordenadas GPS
 */
function calculateHaversineDistance(lat1: number, lon1: number, lat2: number, lon2: number): number {
    const R = 6371; // Radio de la Tierra en km
    const dLat = (lat2 - lat1) * (Math.PI / 180);
    const dLon = (lon2 - lon1) * (Math.PI / 180);
    
    const a = 
        Math.sin(dLat / 2) * Math.sin(dLat / 2) +
        Math.cos(lat1 * (Math.PI / 180)) * Math.cos(lat2 * (Math.PI / 180)) * 
        Math.sin(dLon / 2) * Math.sin(dLon / 2);
        
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    const straightDistance = R * c;

    // Se aplica el factor multiplicador para estimar el recorrido por calles reales
    return Math.round(straightDistance * ROUTE_MULTIPLIER * 100) / 100;
}

/**
 * POST /api/shipping/calculate-cost
 * Calcula el costo de envío dinámico entre el comercio (origen) y el comprador (destino)
 */
export const calculateShippingCost = async (req: Request, res: Response) => {
    try {
        const { storeId, originAddressId, destinationAddressId, destinationCoords } = req.body;

        let originLat: number | null = null;
        let originLng: number | null = null;
        let destLat: number | null = null;
        let destLng: number | null = null;

        // 1. Obtener Coordenadas de Origen (Tienda)
        if (storeId) {
            const store = await prisma.store.findUnique({
                where: { id: storeId },
                include: { address: true }
            });

            if (store?.address?.latitude && store?.address?.longitude) {
                originLat = store.address.latitude;
                originLng = store.address.longitude;
            }
        } else if (originAddressId) {
            const originAddr = await prisma.address.findUnique({ where: { id: originAddressId } });
            if (originAddr?.latitude && originAddr?.longitude) {
                originLat = originAddr.latitude;
                originLng = originAddr.longitude;
            }
        }

        // 2. Obtener Coordenadas de Destino (Comprador)
        if (destinationAddressId) {
            const destAddr = await prisma.address.findUnique({ where: { id: destinationAddressId } });
            if (destAddr?.latitude && destAddr?.longitude) {
                destLat = destAddr.latitude;
                destLng = destAddr.longitude;
            }
        } else if (destinationCoords?.latitude && destinationCoords?.longitude) {
            destLat = Number(destinationCoords.latitude);
            destLng = Number(destinationCoords.longitude);
        }

        // Validar que se hayan obtenido ambas coordenadas
        if (!originLat || !originLng || !destLat || !destLng) {
            return res.status(400).json({
                error: 'Coordenadas incompletas. Se requieren latitud y longitud válidas para origen y destino.'
            });
        }

        // 3. Calcular Distancia Estimada (Km)
        const distanceKm = calculateHaversineDistance(originLat, originLng, destLat, destLng);

        // 4. Aplicar Fórmula Tarifaria
        const distanceCost = distanceKm * PER_KM_RATE;
        const calculatedTotal = BASE_FEE + distanceCost;
        const finalShippingCost = Math.max(MIN_SHIPPING_COST, Math.round(calculatedTotal));

        // 5. Retornar Desglose para Checkout
        return res.json({
            distanceKm,
            baseFee: BASE_FEE,
            perKmRate: PER_KM_RATE,
            distanceCost: Math.round(distanceCost),
            totalShippingCost: finalShippingCost,
            currency: 'ARS',
            origin: { latitude: originLat, longitude: originLng },
            destination: { latitude: destLat, longitude: destLng }
        });

    } catch (error) {
        console.error('Error al calcular costo de envío:', error);
        return res.status(500).json({ error: 'Error interno al procesar la tarifa de envío.' });
    }
};

/**
 * POST /api/shipping/ready-for-pickup
 * Panel del Vendedor: Marca el paquete como listo y dispara la orden a Neo Mandados
 */
export const markReadyForPickup = async (req: AuthRequest, res: Response) => {
    try {
        const userId = req.userId;
        const { shipmentId } = req.body;

        if (!shipmentId) return res.status(400).json({ error: 'El ID del envío es obligatorio.' });

        // Verificar propiedad de la transacción por parte del vendedor
        const shipment = await prisma.shipment.findUnique({
            where: { id: shipmentId },
            include: { transaction: true, originAddress: true, destinationAddress: true }
        });

        if (!shipment) return res.status(404).json({ error: 'Envío no encontrado.' });
        if (shipment.transaction.sellerId !== userId) {
            return res.status(403).json({ error: 'No tienes permiso para despachar esta orden.' });
        }

        if (shipment.status !== 'PENDING' && shipment.status !== 'PREPARING') {
            return res.status(400).json({ error: 'El envío ya fue despachado o está en un estado inválido.' });
        }

        // --- INTEGRACIÓN API NEO MANDADOS (Simulada para MVP) ---
        // Aquí se haría un POST real a la API de la logística (ej. https://api.neomandados.com/v1/orders)
        // enviando originAddress y destinationAddress.
        const simulatedTrackingNumber = `NEO-${Date.now().toString().slice(-6)}-${Math.floor(Math.random() * 1000)}`;

        const updatedShipment = await prisma.shipment.update({
            where: { id: shipmentId },
            data: { 
                status: 'READY_FOR_PICKUP',
                trackingNumber: simulatedTrackingNumber
            }
        });

        res.json({ message: 'Orden despachada con éxito. Un cadete está en camino.', shipment: updatedShipment });
    } catch (error) {
        console.error('Error al marcar envío como listo:', error);
        res.status(500).json({ error: 'Error interno al despachar la orden.' });
    }
};

/**
 * POST /api/shipping/webhook/neo-mandados
 * Webhook Receptor: Actualiza el estado logístico y libera el Fideicomiso al entregar
 */
export const neoMandadosWebhook = async (req: Request, res: Response) => {
    try {
        // En producción: Validar firma criptográfica (ej. req.headers['x-neo-signature'])
        const { trackingNumber, externalStatus } = req.body;

        if (!trackingNumber || !externalStatus) {
            return res.status(400).json({ error: 'Faltan parámetros requeridos por el webhook.' });
        }

        const shipment = await prisma.shipment.findUnique({
            where: { trackingNumber },
            include: { transaction: true }
        });

        if (!shipment) return res.status(404).json({ error: 'Tracking number no registrado en el ecosistema.' });

        // Mapeo del estado externo de Neo Mandados a nuestra máquina de estados
        let newStatus = shipment.status;
        if (externalStatus === 'DRIVER_ASSIGNED' || externalStatus === 'IN_ROUTE') newStatus = 'IN_TRANSIT';
        if (externalStatus === 'DELIVERED') newStatus = 'DELIVERED';
        if (externalStatus === 'CANCELED' || externalStatus === 'FAILED') newStatus = 'FAILED';

        if (newStatus === shipment.status) {
            return res.json({ message: 'Estado sin cambios procesables.' });
        }

        // Transacción Atómica: Sincroniza logística y finanzas sin riesgo de desfasaje
        await prisma.$transaction(async (tx) => {
            // 1. Actualizar tracking logístico
            await tx.shipment.update({
                where: { id: shipment.id },
                data: { status: newStatus }
            });

            // 2. Ejecutar liberación del Escrow si el paquete fue entregado con éxito
            if (newStatus === 'DELIVERED' && shipment.transaction.state === 'PAID_HELD') {
                
                await tx.transaction.update({
                    where: { id: shipment.transaction.id },
                    data: { state: 'FUNDS_RELEASED' }
                });

                // Registrar en la pista de auditoría contable
                await tx.transactionHistory.create({
                    data: {
                        transactionId: shipment.transaction.id,
                        oldState: 'PAID_HELD',
                        newState: 'FUNDS_RELEASED',
                        actorId: 'WEBHOOK_NEO_MANDADOS'
                    }
                });

                // NOTA TÉCNICA FINANCIERA: 
                // En este punto es donde el backend detonaría la llamada HTTP a BIND (transferencia saliente)
                // o a Mercado Pago (captura de reserva) para enviar el dinero real al CBU del vendedor.
            }
        });

        res.json({ message: 'Webhook procesado. Estados sincronizados correctamente.' });
    } catch (error) {
        console.error('Error en webhook de logística:', error);
        res.status(500).json({ error: 'Error interno al procesar el webhook.' });
    }
};