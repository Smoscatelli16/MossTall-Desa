// src/index.ts
import express, { Express, Request, Response } from 'express';
import dotenv from 'dotenv';
import cors from 'cors';
import prisma from './lib/prisma'; 

// --- IMPORTAMOS EL NUEVO DAEMON (BRIEF #047) ---
import { startEscrowDaemon } from './services/escrowDaemon';

// --- IMPORTAMOS LAS RUTAS ---
import authRoutes from './routes/authRoutes';
import productRoutes from './routes/productRoutes';
import transactionRoutes from './routes/transactionRoutes';
import questionRoutes from './routes/questionRoutes';
import chatRoutes from './routes/chatRoutes';
import userRoutes from './routes/userRoutes';
import needRoutes from './routes/needRoutes';
import reviewRoutes from './routes/reviewRoutes';
import storeRoutes from './routes/storeRoutes'; 

dotenv.config();
const app: Express = express();
const PORT = process.env.PORT || 3001;

// Configuración avanzada de CORS
app.use(cors({
  origin: function (origin, callback) {
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
app.use('/api', storeRoutes); 

app.get('/', (req: Request, res: Response) => {
  res.send('✅ Servidor Mission Vende funcionando.');
});

// --- INICIAR SERVIDOR ---
const startServer = async () => {
  try {
    await prisma.$connect();
    console.log('🗄️  [Prisma]: Conectado a PostgreSQL.');
    
    // INICIAMOS EL NUEVO ESCROW DAEMON ROBUSTO
    startEscrowDaemon();
    
    app.listen(PORT, () => {
      console.log(`🚀 [Servidor]: Corriendo en http://localhost:${PORT}`);
    });
  } catch (error) {
    console.error('❌ [Error]: No se pudo iniciar el servidor.', error);
    process.exit(1);
  }
};

startServer();