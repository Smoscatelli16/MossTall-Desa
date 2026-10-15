// src/services/escrowDaemon.ts
import cron from 'node-cron';
import prisma from '../lib/prisma';
import { bindService } from './bindService';
import { Resend } from 'resend';
import { Prisma } from '@prisma/client';

const RESEND_API_KEY = process.env.RESEND_API_KEY;
const resend = RESEND_API_KEY ? new Resend(RESEND_API_KEY) : null;

// Ejecución horaria: Escanea a los 0 minutos de cada hora
cron.schedule('0 * * * *', async () => {
    console.log('🤖 [Escrow Daemon] Iniciando escaneo de transacciones vencidas...');
    
    try {
        // Límite de 72 horas hacia atrás
        const limitDate = new Date();
        limitDate.setHours(limitDate.getHours() - 72);

        // TASK 7.1: Buscar únicamente PAID_HELD. Esto ignora automáticamente DISPUTED
        const heldTransactions = await prisma.transaction.findMany({
            where: {
                state: 'PAID_HELD',
                updatedAt: { lte: limitDate }
            },
            include: {
                seller: true,
                product: { include: { store: true } }
            }
        });

        if (heldTransactions.length === 0) {
            console.log('🤖 [Escrow Daemon] Sin transacciones vencidas para procesar.');
            return;
        }

        console.log(`🤖 [Escrow Daemon] Encontradas ${heldTransactions.length} transacciones listas para liberación automática.`);

        for (const tx of heldTransactions) {
            try {
                // --- MODO TEST (Descomentar para producción con BIND) ---
                // const targetCvuCbu = tx.product?.store?.cvu || tx.product?.store?.cbu;
                // if (!targetCvuCbu) {
                //     console.error(`🚨 [Escrow Daemon] Tx ${tx.id}: Vendedor sin CBU/CVU destino. Requiere revisión manual.`);
                //     continue;
                // }
                // const transferResult = await bindService.transferToCVU(targetCvuCbu, sellerPayoutNumber, 'LIBERACION_ESCROW', tx.id);
                // if (!transferResult.success) throw new Error(transferResult.error);
                // --------------------------------------------------------

                const sellerPayoutNumber = new Prisma.Decimal(tx.sellerPayout).toNumber();

                await prisma.transaction.update({
                    where: { id: tx.id },
                    data: {
                        state: 'FUNDS_RELEASED',
                        updatedAt: new Date(),
                        history: { create: { oldState: tx.state, newState: 'FUNDS_RELEASED', actorId: 'SYSTEM_CRON' } }
                    }
                });

                // TASK 7.3: Notificación de Liberación Efectuada
                if (resend && tx.seller.email) {
                    resend.emails.send({
                        from: 'MossTall Pagos <onboarding@resend.dev>',
                        to: tx.seller.email,
                        subject: '🔓 Plazo Cumplido: Fondos liberados automáticamente',
                        html: `<p>El plazo de custodia de 72 horas ha finalizado sin recibir disputas. Hemos liberado $${sellerPayoutNumber} a favor de tu cuenta.</p>`
                    }).catch(err => console.error("Error correo daemon:", err));
                }

                console.log(`✅ [Escrow Daemon] Fondos liberados para Tx ${tx.id}`);
            } catch (err: any) {
                console.error(`❌ [Escrow Daemon] Fallo al liberar Tx ${tx.id}:`, err.message);
            }
        }
    } catch (error) {
        console.error('❌ [Escrow Daemon] Error crítico en la rutina:', error);
    }
});

export const startEscrowDaemon = () => {
    console.log('🛡️ Escrow Daemon de Mission Vende inicializado.');
};