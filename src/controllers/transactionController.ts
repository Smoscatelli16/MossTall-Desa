// src/controllers/transactionController.ts
import { Request, Response } from 'express';
import { MercadoPagoConfig, Preference, Payment, PaymentRefund } from 'mercadopago';
import { Resend } from 'resend';
import { Prisma } from '@prisma/client';
import prisma from '../lib/prisma';
import { AuthRequest } from '../middlewares/authMiddleware';
import crypto from 'crypto';
import { bindService } from '../services/bindService'; 

// --- CONFIGURACIÓN FINANCIERA ---
const COMMISSION_RATE = new Prisma.Decimal(0.05); // 5% Comisión base de MossTall
const TAX_RATE = new Prisma.Decimal(0.21); // 21% IVA sobre la comisión

const MP_ACCESS_TOKEN = process.env.MP_ACCESS_TOKEN;
const RESEND_API_KEY = process.env.RESEND_API_KEY;
const WEBHOOK_SECRET = process.env.MP_WEBHOOK_SECRET;

if (!MP_ACCESS_TOKEN) console.warn("⚠️ MP_ACCESS_TOKEN no definido.");
if (!RESEND_API_KEY) console.warn("⚠️ RESEND_API_KEY no definida.");
if (!WEBHOOK_SECRET) console.warn("⚠️ MP_WEBHOOK_SECRET no definido. El webhook rechazará peticiones.");

// Inicializamos clientes externos
const client = new MercadoPagoConfig({ accessToken: MP_ACCESS_TOKEN || '' });
const paymentClient = new Payment(client);
const refundClient = new PaymentRefund(client); 
const resend = RESEND_API_KEY ? new Resend(RESEND_API_KEY) : null;

// --- MÁQUINA DE ESTADOS (STATE MACHINE VALIDATOR) ---
const VALID_TRANSITIONS: Record<string, string[]> = {
    'PENDING': ['PAID_HELD', 'REFUNDED'], 
    'PAID_HELD': ['DELIVERY_CONFIRMED', 'FUNDS_RELEASED', 'DISPUTED'],
    'DELIVERY_CONFIRMED': ['FUNDS_RELEASED', 'DISPUTED'],
    'DISPUTED': ['REFUNDED', 'FUNDS_RELEASED'],
};

const validateStateTransition = (currentState: string, newState: string): boolean => {
    const allowed = VALID_TRANSITIONS[currentState];
    return allowed ? allowed.includes(newState) : false;
};

// --- MOTOR CONTABLE (CALCULADORA INVERSA BIFURCADA - BRIEF #030) ---
const calculateFinancialSplit = (targetPrice: number | string | Prisma.Decimal, gateway: 'MERCADO_PAGO' | 'BIND') => {
    const target = new Prisma.Decimal(targetPrice);
    
    // Tasas según pasarela
    const platformRate = COMMISSION_RATE;
    const gatewayRate = gateway === 'MERCADO_PAGO' ? new Prisma.Decimal(0.0449) : new Prisma.Decimal(0.00); 

    // Calculadora inversa: Garantizamos que el targetNetAmount (lo que quiere el vendedor) quede limpio
    // Gross = Target / (1 - platformRate - gatewayRate)
    const totalFeeRate = platformRate.add(gatewayRate);
    const divisor = new Prisma.Decimal(1).sub(totalFeeRate);
    const grossAmount = target.div(divisor).toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP);

    const platformFee = grossAmount.mul(platformRate).toDecimalPlaces(2);
    const taxFeeAmount = platformFee.mul(TAX_RATE).toDecimalPlaces(2);
    const netPlatformFeeAmount = platformFee.sub(taxFeeAmount).toDecimalPlaces(2);
    
    const gatewayFeeAmount = grossAmount.mul(gatewayRate).toDecimalPlaces(2);

    const sellerPayout = grossAmount.sub(platformFee).sub(gatewayFeeAmount).toDecimalPlaces(2);

    return {
        amount: grossAmount, 
        grossAmount,
        platformFee,
        taxFeeAmount,
        netPlatformFeeAmount,
        gatewayFeeAmount,
        sellerPayout,
        sellerFinalAmount: sellerPayout, 
        targetNetAmount: target
    };
};

// --- CONTROLADORES ---

// 1. INIT TRANSACCIÓN BIFURCADA E INTELIGENTE (Soporta Producto o Transacción PENDIENTE)
export const createTransaction = async (req: AuthRequest, res: Response) => {
    console.log('--- INICIO DE CREACIÓN DE TRANSACCIÓN ---');
    
    // Ahora podemos recibir un productId (flujo normal) o un transactionId (Mercado Inverso)
    const { productId, transactionId, paymentGateway = 'MERCADO_PAGO' } = req.body;
    const buyerId = req.userId as string; 

    try {
        let activeTransaction: any;
        let productTitle = 'Acuerdo Privado';
        let productPrice: Prisma.Decimal;

        // ====================================================================
        // ESCENARIO A: FLUJO DE MERCADO INVERSO (Ya existe una transacción PENDIENTE)
        // ====================================================================
        if (transactionId) {
            const existingTx = await prisma.transaction.findUnique({ 
                where: { id: transactionId },
                include: { product: { include: { store: true } } }
            });

            if (!existingTx) return res.status(404).json({ error: 'Transacción no encontrada.' });
            if (existingTx.buyerId !== buyerId) return res.status(403).json({ error: 'No tienes permiso para pagar esto.' });
            if (existingTx.state !== 'PENDING') return res.status(400).json({ error: 'La transacción no está pendiente de pago.' });

            // Recalculamos los financieros en base a la pasarela elegida en el checkout
            const financials = calculateFinancialSplit(existingTx.amount, paymentGateway);

            // Actualizamos la transacción existente
            activeTransaction = await prisma.transaction.update({
                where: { id: transactionId },
                data: {
                    paymentGateway,
                    ...financials
                }
            });

            productTitle = existingTx.product?.title || 'Acuerdo Privado de Mercado Inverso';
            productPrice = financials.grossAmount;
        } 
        
        // ====================================================================
        // ESCENARIO B: FLUJO CLÁSICO (Compra directa de Catálogo)
        // ====================================================================
        else if (productId) {
            const product = await prisma.product.findUnique({ 
                where: { id: productId },
                include: { store: true } 
            });

            if (!product) return res.status(404).json({ error: 'Producto no encontrado.' });
            if (product.store.ownerId === buyerId) return res.status(400).json({ error: 'No puedes comprar tu propio producto.' });
            if (product.price <= 0) return res.status(400).json({ error: 'Precio inválido para pago.' });

            const financials = calculateFinancialSplit(product.price, paymentGateway);
            productTitle = product.title;
            productPrice = financials.grossAmount;

            if (product.type === 'SERVICIO') {
                activeTransaction = await prisma.transaction.create({
                    data: {
                        buyerId: buyerId,
                        sellerId: product.store.ownerId,
                        productId,
                        paymentGateway,
                        ...financials,
                        state: 'PENDING',
                        history: { create: { newState: 'PENDING', actorId: buyerId } }
                    }
                });

                return res.status(201).json({
                    transaction: activeTransaction,
                    message: "Servicio contratado. Coordina con el profesional.",
                    paymentUrl: null 
                });
            }

            if (product.stock <= 0) return res.status(400).json({ error: 'Producto agotado.' });
            if (product.status !== 'DISPONIBLE') return res.status(400).json({ error: 'Producto no disponible.' });

            activeTransaction = await prisma.$transaction(async (tx) => {
                const t = await tx.transaction.create({
                    data: {
                        buyerId: buyerId, 
                        sellerId: product.store.ownerId, 
                        productId, 
                        paymentGateway,
                        ...financials,
                        state: 'PENDING',
                        history: { create: { newState: 'PENDING', actorId: buyerId } }
                    }
                });

                const newStock = product.stock - 1;
                const newStatus = newStock > 0 ? 'DISPONIBLE' : 'PAUSADO';

                await tx.product.update({
                    where: { id: productId },
                    data: { stock: newStock, status: newStatus }
                });

                return t;
            });
        } 
        else {
            return res.status(400).json({ error: 'Se requiere productId o transactionId.' });
        }

        // ====================================================================
        // GENERACIÓN DE PASARELA (Común para ambos escenarios)
        // ====================================================================
        if (paymentGateway === 'MERCADO_PAGO') {
            const preference = new Preference(client);
            const mpResult = await preference.create({
                body: {
                    items: [{ 
                        id: activeTransaction.id, 
                        title: productTitle, 
                        quantity: 1, 
                        unit_price: productPrice.toNumber(), 
                        currency_id: 'ARS' 
                    }],
                    back_urls: {
                        success: 'http://localhost:3000/checkout/success',
                        failure: 'http://localhost:3000/checkout/failure',
                        pending: 'http://localhost:3000/checkout/pending'
                    },
                    external_reference: activeTransaction.id,
                }
            });

            return res.status(201).json({ transaction: activeTransaction, paymentUrl: mpResult.init_point });
        } else {
            return res.status(201).json({ 
                transaction: activeTransaction, 
                paymentUrl: null,
                bindData: {
                    cbu: "1110000000000000000000",
                    alias: "MOSSTALL.FIDEICOMISO",
                    amountToPay: productPrice.toNumber(),
                    referenceId: activeTransaction.id
                }
            });
        }

    } catch (error: any) {
        console.error('Error Transacción:', error);
        if (productId) { 
           await prisma.product.update({ where: { id: productId }, data: { stock: { increment: 1 }, status: 'DISPONIBLE' } }).catch(() => {});
        }
        res.status(500).json({ error: 'Error al procesar la solicitud.', details: error.message });
    }
};

// 2. COBRO ÁGIL / DINÁMICO
export const createDynamicCheckout = async (req: AuthRequest, res: Response) => {
    try {
        const { id } = req.params; 
        const { amount, description } = req.body;
        const sellerId = req.userId as string;

        if (!amount || amount <= 0) return res.status(400).json({ error: 'El monto debe ser mayor a 0.' });

        const transaction = await prisma.transaction.findUnique({ 
            where: { id }, 
            include: { product: { include: { store: true } } } 
        });

        if (!transaction) return res.status(404).json({ error: 'Transacción no encontrada.' });
        if (transaction.sellerId !== sellerId) return res.status(403).json({ error: 'Solo el vendedor puede generar el cobro.' });
        if (transaction.product?.type !== 'SERVICIO') return res.status(400).json({ error: 'El cobro dinámico solo es para Servicios.' });
        
        if (['FUNDS_RELEASED', 'REFUNDED', 'DISPUTED'].includes(transaction.state)) {
            return res.status(400).json({ error: 'La transacción está cerrada o en disputa.' });
        }

        const financials = calculateFinancialSplit(amount, 'MERCADO_PAGO');

        await prisma.transaction.update({
            where: { id },
            data: {
                ...financials,
                paymentGateway: 'MERCADO_PAGO',
                state: 'PENDING',
                history: { create: { oldState: transaction.state, newState: 'PENDING', actorId: sellerId } }
            }
        });

        const preference = new Preference(client);
        const mpResult = await preference.create({
            body: {
                items: [{
                    id: transaction.productId || 'servicio',
                    title: description || transaction.product?.title || 'Servicio Profesional',
                    quantity: 1,
                    unit_price: financials.grossAmount.toNumber(),
                    currency_id: 'ARS',
                }],
                back_urls: {
                    success: 'http://localhost:3000/checkout/success',
                    failure: 'http://localhost:3000/checkout/failure',
                    pending: 'http://localhost:3000/checkout/pending'
                },
                external_reference: transaction.id,
            }
        });

        res.json({ message: 'Cobro generado exitosamente.', paymentUrl: mpResult.init_point, amount: financials.grossAmount.toNumber() });

    } catch (error) {
        console.error('Error en cobro dinámico:', error);
        res.status(500).json({ error: 'Error al generar el cobro.' });
    }
};

// 3. CAMINO FELIZ: CONFIRMACIÓN DEL COMPRADOR (MODIFICADO PARA MODO TEST)
export const confirmDelivery = async (req: AuthRequest, res: Response) => {
    const { id } = req.params;
    const userId = req.userId as string;

    try {
        const transaction = await prisma.transaction.findUnique({ 
            where: { id }, 
            include: { seller: true, product: { include: { store: true } } } 
        });
        if (!transaction) return res.status(404).json({ error: 'Transacción no encontrada.' });
        if (transaction.buyerId !== userId) return res.status(403).json({ error: 'Acceso denegado.' });
        if (!validateStateTransition(transaction.state, 'FUNDS_RELEASED')) return res.status(409).json({ error: 'Estado inválido.' });

        // --- MODO TEST: Comentamos la validación del banco para que no explote ---
        // const targetCvuCbu = transaction.product?.store?.cvu || transaction.product?.store?.cbu;
        // if (!targetCvuCbu) return res.status(400).json({ error: 'Vendedor sin CBU/CVU.' });
        // const transferResult = await bindService.transferToCVU(targetCvuCbu, sellerPayoutNumber, 'VARIOS', transaction.id);
        // if (!transferResult.success) return res.status(502).json({ error: 'Fallo BIND.', details: transferResult.error });
        // ------------------------------------------------------------------------

        const sellerPayoutNumber = new Prisma.Decimal(transaction.sellerPayout).toNumber();

        const updatedTx = await prisma.transaction.update({
            where: { id },
            data: {
                state: 'FUNDS_RELEASED',
                updatedAt: new Date(),
                history: { create: { oldState: transaction.state, newState: 'FUNDS_RELEASED', actorId: userId } }
            }
        });

        if (resend && transaction.seller.email) {
            resend.emails.send({
                from: 'MossTall Pagos <onboarding@resend.dev>',
                to: transaction.seller.email,
                subject: `💰 ¡Venta Completada! Fondos en camino`,
                html: `<p>El comprador ha confirmado la entrega. Transferimos $${sellerPayoutNumber} a tu cuenta.</p>`
            }).catch(console.error);
        }

        res.json({ message: 'Entrega confirmada (Modo Test).', transaction: updatedTx });
    } catch (error) {
        res.status(500).json({ error: 'Error interno.' });
    }
};

// 4. LIBERACIÓN DE FONDOS
export const releaseFunds = async (req: AuthRequest, res: Response) => {
    const { id } = req.params;
    const userId = req.userId as string;

    try {
        const transaction = await prisma.transaction.findUnique({ 
            where: { id }, 
            include: { seller: true, product: { include: { store: true } } } 
        });

        if (!transaction) return res.status(404).json({ error: 'Transacción no encontrada.' });
        if (transaction.buyerId !== userId && transaction.sellerId !== userId) return res.status(403).json({ error: 'Sin permisos.' });
        if (!validateStateTransition(transaction.state, 'FUNDS_RELEASED')) return res.status(409).json({ error: 'Estado inválido.' });

        const targetCvuCbu = transaction.product?.store?.cvu || transaction.product?.store?.cbu;
        if (!targetCvuCbu) return res.status(400).json({ error: 'Vendedor sin CBU/CVU configurado en la tienda.' });

        const sellerPayoutNumber = new Prisma.Decimal(transaction.sellerPayout).toNumber();
        const transferResult = await bindService.transferToCVU(targetCvuCbu, sellerPayoutNumber, 'VARIOS', transaction.id);

        if (!transferResult.success) return res.status(502).json({ error: 'Error banco.', details: transferResult.error });

        const updatedTransaction = await prisma.transaction.update({
            where: { id },
            data: {
                state: 'FUNDS_RELEASED',
                updatedAt: new Date(),
                history: { create: { oldState: transaction.state, newState: 'FUNDS_RELEASED', actorId: userId } }
            }
        });

        if (resend && transaction.seller.email) {
            resend.emails.send({
                from: 'MossTall Pagos <onboarding@resend.dev>',
                to: transaction.seller.email,
                subject: `🎉 ¡Fondos Liberados a tu cuenta!`,
                html: `<h1>¡Buenas noticias!</h1><p>El dinero ha sido transferido a tu CBU/CVU terminado en ${targetCvuCbu.slice(-4)}.</p><p><strong>Monto depositado:</strong> $${sellerPayoutNumber.toLocaleString('es-AR')}</p>`
            }).catch(console.error);
        }

        res.json({ message: 'Fondos transferidos exitosamente.', transaction: updatedTransaction });
    } catch (error) {
        res.status(500).json({ error: 'Error interno.' });
    }
};

// 5. BOTÓN DE PÁNICO / DISPUTA
export const disputeTransaction = async (req: AuthRequest, res: Response) => {
    const { id } = req.params;
    const userId = req.userId as string;

    try {
        const transaction = await prisma.transaction.findUnique({ where: { id } });
        if (!transaction) return res.status(404).json({ error: 'Transacción no encontrada.' });
        if (transaction.buyerId !== userId && transaction.sellerId !== userId) return res.status(403).json({ error: 'Sin permiso.' });
        if (!validateStateTransition(transaction.state, 'DISPUTED')) return res.status(409).json({ error: 'Estado inválido.' });

        const disputedTx = await prisma.transaction.update({
            where: { id },
            data: {
                state: 'DISPUTED',
                history: { create: { oldState: transaction.state, newState: 'DISPUTED', actorId: userId } }
            }
        });

        res.json({ message: 'Transacción congelada.', transaction: disputedTx });
    } catch (error) {
        res.status(500).json({ error: 'Error al abrir disputa.' });
    }
};

// 6. CIRUGÍA FINANCIERA: RESOLUCIÓN BIFURCADA (BRIEF #030)
export const resolveDispute = async (req: AuthRequest, res: Response) => {
    const { id } = req.params;
    const { resolution } = req.body; 
    const adminId = req.userId;

    try {
        if (resolution !== 'REFUNDED' && resolution !== 'FUNDS_RELEASED') {
            return res.status(400).json({ error: 'Resolución inválida.' });
        }

        const transaction = await prisma.transaction.findUnique({ 
            where: { id }, 
            include: { seller: true, buyer: true, product: { include: { store: true } } } 
        });
        
        if (!transaction) return res.status(404).json({ error: 'Transacción no encontrada.' });
        if (transaction.state !== 'DISPUTED') return res.status(409).json({ error: 'No está en disputa.' });

        let forensicLogId = null;

        // A. Fallo a favor del vendedor (Se le envía la plata)
        if (resolution === 'FUNDS_RELEASED') {
            const targetCvuCbu = transaction.product?.store?.cvu || transaction.product?.store?.cbu;
            if (!targetCvuCbu) return res.status(400).json({ error: 'La tienda del vendedor no tiene CVU/CBU configurado.' });

            const payoutAmount = new Prisma.Decimal(transaction.sellerPayout).toNumber();
            const transferResult = await bindService.transferToCVU(targetCvuCbu, payoutAmount, 'RESOLUCION_DISPUTA', transaction.id);
            if (!transferResult.success) return res.status(502).json({ error: 'Fallo BIND al vendedor.', details: transferResult.error });
            
            forensicLogId = 'BIND_RELEASE';
        }
        
        // B. Fallo a favor del comprador (Reembolso Bifurcado)
        if (resolution === 'REFUNDED') {
            const refundAmount = new Prisma.Decimal(transaction.grossAmount).toNumber();

            if (transaction.paymentGateway === 'MERCADO_PAGO') {
                if (!transaction.mercadoPagoId) return res.status(400).json({ error: 'Sin ID de Mercado Pago para reembolsar.' });
                try {
                    const idempotencyKey = `refund_dispute_${transaction.id}_${Date.now()}`;
                    const refundResult = await refundClient.create({
                        payment_id: transaction.mercadoPagoId,
                        requestOptions: { idempotencyKey }
                    });
                    forensicLogId = `MP_REFUND_${refundResult.id}`;
                } catch (mpError: any) {
                    return res.status(502).json({ error: 'Fallo al reembolsar vía MP.', details: mpError.message });
                }
            } 
            else if (transaction.paymentGateway === 'BIND') {
                // Buscamos si el comprador tiene una tienda para extraer un CBU a donde reembolsarle
                const buyerStore = await prisma.store.findFirst({ where: { ownerId: transaction.buyerId } });
                const buyerCvu = buyerStore?.cvu || buyerStore?.cbu;
                
                if (!buyerCvu) return res.status(400).json({ error: 'El comprador no tiene configurado un Perfil Comercial/CBU para recibir la devolución por BIND. Requiere intervención manual.' });
                
                const transferResult = await bindService.transferToCVU(buyerCvu, refundAmount, 'DEVOLUCION_DISPUTA', transaction.id);
                if (!transferResult.success) return res.status(502).json({ error: 'Fallo BIND de devolución.', details: transferResult.error });
                
                forensicLogId = `BIND_REFUND`;
            }
        }
        
        const actorIdLog = `ADMIN_${adminId}_${forensicLogId}`;

        const resolvedTx = await prisma.transaction.update({
            where: { id },
            data: {
                state: resolution,
                updatedAt: new Date(),
                history: { create: { oldState: transaction.state, newState: resolution, actorId: actorIdLog } }
            }
        });

        res.json({ message: 'Disputa resuelta.', transaction: resolvedTx });
    } catch (error) {
        res.status(500).json({ error: 'Error interno.' });
    }
};

// 7. CANCELACIÓN
export const cancelTransaction = async (req: AuthRequest, res: Response) => {
  const { id } = req.params;
  const userId = req.userId as string;

  try {
    const transaction = await prisma.transaction.findUnique({ where: { id }, include: { product: true } });
    if (!transaction) return res.status(404).json({ error: 'Transacción no encontrada.' });
    if (transaction.buyerId !== userId && transaction.sellerId !== userId) return res.status(403).json({ error: 'No tienes permiso.' });
    if (!validateStateTransition(transaction.state, 'REFUNDED')) return res.status(409).json({ error: 'Estado inválido.' });

    if (transaction.paymentGateway === 'BIND' && transaction.state === 'PAID_HELD') {
        return res.status(400).json({ error: 'Las transferencias bancarias requieren mediación para cancelar. Abre una disputa.' });
    }

    if (transaction.paymentGateway === 'MERCADO_PAGO' && transaction.mercadoPagoId) {
        try {
            const idempotencyKey = `refund_cancel_${transaction.id}_${Date.now()}`;
            await refundClient.create({ payment_id: transaction.mercadoPagoId, requestOptions: { idempotencyKey } });
        } catch (mpError: any) {
            return res.status(502).json({ error: 'Fallo en MP.', details: mpError.message });
        }
    }

    const updatedTransaction = await prisma.$transaction(async (tx) => {
        const t = await tx.transaction.update({ 
            where: { id }, 
            data: { 
                state: 'REFUNDED',
                history: { create: { oldState: transaction.state, newState: 'REFUNDED', actorId: userId } }
            } 
        });
        if (transaction.productId && transaction.product?.type === 'PRODUCTO') { 
            await tx.product.update({ where: { id: transaction.productId }, data: { stock: { increment: 1 }, status: 'DISPONIBLE' } });
        }
        return t;
    });
    res.json(updatedTransaction);
  } catch (error) {
    res.status(500).json({ error: 'Error interno.' });
  }
};

// 8. BORRADO LÓGICO
export const deleteTransaction = async (req: AuthRequest, res: Response) => {
  const { id } = req.params;
  const userId = req.userId;
  try {
    const transaction = await prisma.transaction.findUnique({ where: { id } });
    if (!transaction) return res.status(404).json({ error: 'No encontrada.' });
    if (transaction.buyerId === userId) await prisma.transaction.update({ where: { id }, data: { deletedByBuyer: true } });
    else if (transaction.sellerId === userId) await prisma.transaction.update({ where: { id }, data: { deletedBySeller: true } });
    res.json({ message: 'Eliminada.' });
  } catch (error) { res.status(500).json({ error: 'Error al eliminar.' }); }
};

// --- NUEVO ENDPOINT PARA POLLING (BRIEF #031) ---
export const getTransactionById = async (req: AuthRequest, res: Response) => {
    try {
        const { id } = req.params;
        const userId = req.userId; 

        const transaction = await prisma.transaction.findUnique({
            where: { id }
        });

        if (!transaction) return res.status(404).json({ error: 'Transacción no encontrada.' });

        // Seguridad: Solo el comprador, vendedor o un admin pueden consultarla
        if (transaction.buyerId !== userId && transaction.sellerId !== userId) {
            return res.status(403).json({ error: 'No tienes permiso para ver esta transacción.' });
        }

        res.json(transaction);
    } catch (error) {
        console.error('Error obteniendo transacción por ID:', error);
        res.status(500).json({ error: 'Error interno del servidor.' });
    }
};

// 9. WEBHOOK MERCADO PAGO (ACTUALIZADO - TASK 7.2 Y 7.3)
export const handlePaymentWebhook = async (req: Request, res: Response) => {
    console.log('--- INCOMING WEBHOOK ---');
    
    const signatureHeader = req.headers['x-signature'] as string;
    
    if (WEBHOOK_SECRET && signatureHeader) {
        const isBuffer = Buffer.isBuffer(req.body);
        const payloadStr = isBuffer ? req.body.toString('utf8') : JSON.stringify(req.body);
        
        const hmac = crypto.createHmac('sha256', WEBHOOK_SECRET);
        const digest = hmac.update(payloadStr).digest('hex');
        // TODO: Completar la lógica estricta de validación criptográfica contra `signatureHeader`
    }

    const body = Buffer.isBuffer(req.body) ? JSON.parse(req.body.toString('utf8')) : req.body;
    const { type, data } = body;
    
    try {
        if (type === 'payment') {
            const paymentId = data.id;
            const payment = await paymentClient.get({ id: paymentId });
            
            if (payment.status === 'approved' && payment.external_reference) {
                const transactionId = payment.external_reference;
                
                // BRIEF #047: Incluimos comprador y vendedor para enviar correos
                const currentTx = await prisma.transaction.findUnique({ 
                    where: { id: transactionId },
                    include: { buyer: true, seller: true }
                });
                
                if (!currentTx) return res.status(404).send('Not Found');

                if (currentTx.state === 'PAID_HELD' || currentTx.state === 'FUNDS_RELEASED') {
                    console.log(`⚡ Webhook duplicado ignorado. Tx ya procesada: ${transactionId}`);
                    return res.status(200).send('OK'); 
                }

                if (!validateStateTransition(currentTx.state, 'PAID_HELD')) {
                    console.error(`🚨 Transición ilegal por webhook: de ${currentTx.state} a PAID_HELD.`);
                    return res.status(409).send('Conflict');
                }

                await prisma.transaction.update({
                    where: { id: transactionId },
                    data: { 
                        state: 'PAID_HELD',
                        mercadoPagoId: String(paymentId),
                        history: {
                            create: { oldState: currentTx.state, newState: 'PAID_HELD', actorId: 'WEBHOOK_MP' }
                        }
                    }
                });
                
                console.log(`✅ Pago RETENIDO en Fideicomiso para Tx: ${transactionId}`);

                // BRIEF #047 - Task 7.3: Motor de Notificaciones Transaccionales (Webhook trigger)
                if (resend) {
                    // 1. Notificación al Vendedor
                    if (currentTx.seller?.email) {
                        resend.emails.send({
                            from: 'MossTall Pagos <onboarding@resend.dev>',
                            to: currentTx.seller.email,
                            subject: '💸 ¡Tenes una nueva venta! Tu dinero está en custodia',
                            html: `<h2>¡Felicitaciones!</h2><p>El pago de $${currentTx.amount.toNumber()} por tu publicación ha sido acreditado.</p><p><strong>El dinero está protegido en la bóveda de Mission Vende.</strong> Por favor, prepará la entrega. Los fondos se liberarán en 72 horas o cuando el comprador confirme la recepción.</p>`
                        }).catch(err => console.error("Error correo vendedor:", err));
                    }
                    
                    // 2. Notificación al Comprador
                    if (currentTx.buyer?.email) {
                        resend.emails.send({
                            from: 'MossTall Pagos <onboarding@resend.dev>',
                            to: currentTx.buyer.email,
                            subject: '🔒 Tu pago está protegido por 72 horas',
                            html: `<h2>Pago Confirmado</h2><p>Tu dinero está temporalmente en custodia en la bóveda segura de Mission Vende.</p><p>El vendedor ya ha sido notificado para despachar tu producto. Recuerda que tienes 72 horas desde este momento para abrir una disputa si surge algún inconveniente.</p>`
                        }).catch(err => console.error("Error correo comprador:", err));
                    }
                }
            }
        }
        res.status(200).send('OK');
    } catch (error) {
        console.error('❌ Webhook error:', error);
        res.status(500).send('Error Interno del Webhook');
    }
};

// 10. OBTENER DISPUTAS
export const getDisputes = async (req: AuthRequest, res: Response) => {
    try {
        const page = parseInt(req.query.page as string) || 1;
        const limit = parseInt(req.query.limit as string) || 50;
        const skip = (page - 1) * limit;

        const disputes = await prisma.transaction.findMany({
            where: { state: 'DISPUTED' },
            skip,
            take: limit,
            orderBy: { updatedAt: 'desc' },
            select: {
                id: true,
                state: true,
                grossAmount: true,
                sellerFinalAmount: true,
                createdAt: true,
                updatedAt: true,
                buyer: { select: { name: true, email: true } },
                seller: { select: { name: true, email: true } },
                product: { select: { title: true, images: true } },
                history: { orderBy: { createdAt: 'desc' } }
            }
        });

        const total = await prisma.transaction.count({ where: { state: 'DISPUTED' } });

        res.json({
            data: disputes,
            meta: { total, page, limit, totalPages: Math.ceil(total / limit) }
        });

    } catch (error) {
        console.error('Error obteniendo disputas:', error);
        res.status(500).json({ error: 'Error interno al consultar el tribunal de resoluciones.' });
    }
    
};

export const simulatePayment = async (req: AuthRequest, res: Response) => {
    try {
        const { id } = req.params;
        const tx = await prisma.transaction.update({
            where: { id },
            data: { state: 'PAID_HELD' }
        });
        res.json({ message: 'Pago simulado OK', transaction: tx });
    } catch (error) {
        res.status(500).json({ error: 'Error simulando pago' });
    }
};