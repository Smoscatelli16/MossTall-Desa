// src/index.ts
import express, { Express, Request, Response } from 'express';
import dotenv from 'dotenv';
import cors from 'cors';
import prisma from './lib/prisma'; 
import { bindService } from './services/bindService'; 

// --- IMPORTAMOS LAS RUTAS ---
import authRoutes from './routes/authRoutes';
import productRoutes from './routes/productRoutes';
import transactionRoutes from './routes/transactionRoutes';
import questionRoutes from './routes/questionRoutes';
import chatRoutes from './routes/chatRoutes';
import userRoutes from './routes/userRoutes';
import needRoutes from './routes/needRoutes';
import reviewRoutes from './routes/reviewRoutes';
import storeRoutes from './routes/storeRoutes'; // <-- NUEVA RUTA: Tiendas

dotenv.config();
const app: Express = express();
const PORT = process.env.PORT || 3001;

// Configuración avanzada de CORS para producción (Vercel) y desarrollo local
app.use(cors({
  origin: function (origin, callback) {
    // Permitimos peticiones sin origen (ej. Postman) o provenientes de localhost y vercel
    if (!origin || origin.includes('localhost') || origin.includes('vercel.app')) {
      callback(null, true);
    } else {
      callback(new Error('No permitido por CORS'));
    }
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

// Webhook crudo para HMAC MP
app.use('/api/transactions/webhook', express.raw({ type: 'application/json' }));
app.use(express.json());

// --- MONTAJE DE RUTAS ---
app.use('/api/auth', authRoutes);
app.use('/api/transactions', transactionRoutes);
app.use('/api/questions', questionRoutes);
app.use('/api', productRoutes);
app.use('/api/chat', chatRoutes); 
app.use('/api', userRoutes);
app.use('/api/needs', needRoutes);
app.use('/api/reviews', reviewRoutes);
app.use('/api', storeRoutes); // <-- MONTAJE: Tiendas (/api/stores y /api/user/stores)

app.get('/', (req: Request, res: Response) => {
  res.send('✅ Servidor Mission Vende funcionando.');
});

// --- CRON JOBS (TIME-OUT DE LIBERACIÓN LEGAL - BRIEF #022) ---
const startCronJobs = () => {
  setInterval(async () => {
    try {
      const seventyTwoHoursAgo = new Date(Date.now() - 72 * 60 * 60 * 1000);
      
      const expiredTransactions = await prisma.transaction.findMany({
        where: {
          state: 'PAID_HELD',
          updatedAt: { lte: seventyTwoHoursAgo }
        },
        include: { 
            seller: true,
            product: {
                include: { store: true }
            }
        } 
      });

      for (const tx of expiredTransactions) {
        try {
          const targetCvuCbu = tx.product?.store?.cvu || tx.product?.store?.cbu;
          
          if (!targetCvuCbu) {
            console.warn(`⚠️ [Cron]: Tienda sin CBU/CVU en Tx ${tx.id}. Se mantendrá retenido.`);
            continue; 
          }

          const sellerPayoutNumber = Number(tx.sellerPayout);

          const transferResult = await bindService.transferToCVU(
              targetCvuCbu,
              sellerPayoutNumber,
              'VARIOS',
              tx.id
          );

          if (!transferResult.success) {
              console.error(`❌ [Cron]: Falló el banco BIND para Tx ${tx.id}. Retentará en 1 hora.`, transferResult.error);
              continue; 
          }

          await prisma.transaction.update({
            where: { id: tx.id },
            data: {
              state: 'FUNDS_RELEASED',
              updatedAt: new Date(),
              history: {
                create: { oldState: tx.state, newState: 'FUNDS_RELEASED', actorId: 'SYSTEM_CRON' }
              }
            }
          });
          console.log(`🤖 [Cron]: Time-Out expirado. BIND disparado y fondos liberados para Tx: ${tx.id}`);
        } catch (innerError) {
          console.error(`❌ [Cron Error Crítico] falló procesamiento de Tx ${tx.id}:`, innerError);
        }
      }
    } catch (error) {
      console.error('🤖 [Cron Error General]: Falla al escanear la base de datos.', error);
    }
  }, 1000 * 60 * 60); 
  
  console.log('⏱  [Cron]: Escrow Daemon iniciado. Verificando retenciones cada 1h.');
};

// --- INICIAR SERVIDOR ---
const startServer = async () => {
  try {
    await prisma.$connect();
    console.log('🗄️  [Prisma]: Conectado a PostgreSQL.');
    
    startCronJobs();
    
    app.listen(PORT, () => {
      console.log(`🚀 [Servidor]: Corriendo en http://localhost:${PORT}`);
    });
  } catch (error) {
    console.error('❌ [Error]: No se pudo iniciar el servidor.', error);
    process.exit(1);
  }
};

startServer();