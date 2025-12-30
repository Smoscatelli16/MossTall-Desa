// src/index.ts

// Importamos las herramientas
import express, { Express, Request, Response, NextFunction } from 'express';
import dotenv from 'dotenv';
import { PrismaClient, Prisma } from '@prisma/client'; // Importamos tipos de Prisma
import cors from 'cors';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { Resend } from 'resend'; // Importamos Resend para Emails
// Importamos Mercado Pago
import { MercadoPagoConfig, Preference, Payment } from 'mercadopago'; // Agregamos Payment para webhook

// --- CONFIGURACIÓN INICIAL ---
dotenv.config();
const app: Express = express();
app.use(cors());
app.use(express.json());
const prisma = new PrismaClient();
const PORT = process.env.PORT || 3001;
const JWT_SECRET = process.env.JWT_SECRET;

// ⚠️ AJUSTE DE NEGOCIO (SPEC #009): Comisión bajada al 5%
const COMMISSION_RATE = 0.05; 

const MP_ACCESS_TOKEN = process.env.MP_ACCESS_TOKEN;
const RESEND_API_KEY = process.env.RESEND_API_KEY; // API Key de Resend

if (!JWT_SECRET) {
  console.error("¡ERROR! La variable JWT_SECRET no está definida en el .env");
  process.exit(1);
}

if (!MP_ACCESS_TOKEN) {
  console.error("¡ERROR! La variable MP_ACCESS_TOKEN no está definida en el .env");
  process.exit(1);
}

// --- CONFIGURACIÓN CLIENTES EXTERNOS ---
const client = new MercadoPagoConfig({ accessToken: MP_ACCESS_TOKEN });
const paymentClient = new Payment(client); // Cliente para verificar pagos

// Inicializamos Resend (Email) solo si existe la key, sino avisamos
let resend: Resend | null = null;
if (RESEND_API_KEY) {
    resend = new Resend(RESEND_API_KEY);
} else {
    console.warn("⚠️ ADVERTENCIA: RESEND_API_KEY no definida. Los emails no se enviarán.");
}

// --- (FIN DE LA CONFIGURACIÓN) ---


// --- INTERFAZ DE REQUEST AUTENTICADO ---
export interface AuthRequest extends Request {
  userId?: string;
}


// --- MIDDLEWARE DE AUTENTICACIÓN (EL "GUARDIA") ---
const authMiddleware = (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];

    if (!token) {
      return res.status(401).json({ error: 'Acceso no autorizado. Se requiere un token.' });
    }

    jwt.verify(token, JWT_SECRET, (err: any, decodedToken: any) => {
      if (err) {
        return res.status(403).json({ error: 'Token inválido o expirado.' });
      }
      req.userId = decodedToken.userId;
      next();
    });
  } catch (error) {
    res.status(500).json({ error: 'Error interno del servidor.' });
  }
};


// --- RUTAS DE AUTENTICACIÓN (Públicas) ---

app.get('/', (req: Request, res: Response) => {
  res.send('El servidor de MossTall está funcionando con Chat Seguro y Reglas de Contacto V2!');
});

app.post('/api/auth/register', async (req: Request, res: Response) => {
  try {
    const { email, name, password } = req.body;
    if (!email || !name || !password) {
      return res.status(400).json({ error: 'Faltan datos obligatorios.' });
    }
    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash(password, salt);
    const newUser = await prisma.user.create({
      data: {
        email: email,
        name: name,
        password: hashedPassword,
      },
    });
    res.status(201).json({
      id: newUser.id,
      email: newUser.email,
      name: newUser.name,
    });
  } catch (error: any) {
    if (error.code === 'P2002') {
      return res.status(409).json({ error: 'El email ya está en uso' });
    }
    console.error('Error en el registro:', error);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
});

app.post('/api/auth/login', async (req: Request, res: Response) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ error: 'Email y contraseña son obligatorios.' });
    }
    // CORRECCIÓN: Nos aseguramos de usar findUnique correctamente con 'email'
    const user = await prisma.user.findUnique({
      where: { email: email },
    });
    if (!user) {
      return res.status(401).json({ error: 'Credenciales inválidas' });
    }
    const passwordMatch = await bcrypt.compare(password, user.password);
    if (!passwordMatch) {
      return res.status(401).json({ error: 'Credenciales inválidas' });
    }
    const token = jwt.sign(
      { userId: user.id, email: user.email },
      JWT_SECRET,
      { expiresIn: '1h' }
    );
    res.status(200).json({ token: token });
  } catch (error: any) {
    console.error('Error en el login:', error);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
});


// --- RUTAS DE CATEGORÍAS ---

app.get('/api/categories', async (req: Request, res: Response) => {
  try {
    const categories = await prisma.category.findMany({
      where: { parentId: null },
      include: { children: true },
      orderBy: { name: 'asc' }
    });
    res.status(200).json(categories);
  } catch (error) {
    console.error('Error al obtener categorías:', error);
    res.status(500).json({ error: 'Error interno al obtener categorías.' });
  }
});


// --- RUTAS DE PERFIL PROFESIONAL (SPEC #010) ---

// 1. Obtener mi propio perfil (para edición)
app.get('/api/user/profile', authMiddleware, async (req: AuthRequest, res: Response) => {
    try {
        const userId = req.userId;
        const profile = await prisma.professionalProfile.findUnique({
            where: { userId }
        });
        // Si no existe perfil, devolvemos null (el frontend mostrará formulario vacío)
        res.json(profile || null);
    } catch (error) {
        console.error('Error fetching user profile:', error);
        res.status(500).json({ error: 'Error al cargar perfil.' });
    }
});

// 2. Guardar o Actualizar mi perfil (Upsert)
app.put('/api/user/profile', authMiddleware, async (req: AuthRequest, res: Response) => {
    try {
        const userId = req.userId;
        const { profession, biography, experienceYears, education, portfolioImages, certifications } = req.body;

        // Upsert: Si existe actualiza, si no crea.
        const profile = await prisma.professionalProfile.upsert({
            where: { userId },
            update: {
                profession,
                biography,
                experienceYears: experienceYears ? Number(experienceYears) : null,
                education,
                portfolioImages: portfolioImages || [],
                certifications: certifications || []
            },
            create: {
                userId: userId!,
                profession,
                biography,
                experienceYears: experienceYears ? Number(experienceYears) : null,
                education,
                portfolioImages: portfolioImages || [],
                certifications: certifications || []
            }
        });

        res.json(profile);
    } catch (error) {
        console.error('Error saving profile:', error);
        res.status(500).json({ error: 'Error al guardar perfil.' });
    }
});

// 3. Ver Perfil Público (Para que los clientes vean al profesional)
app.get('/api/profile/:userId', async (req: Request, res: Response) => {
    try {
        const { userId } = req.params;

        // CORRECCIÓN: Eliminamos cualquier referencia a columnas extrañas. Usamos 'id'.
        const user = await prisma.user.findUnique({
            where: { id: userId },
            select: {
                id: true,
                name: true,
                createdAt: true,
                // Incluimos su perfil profesional
                professionalProfile: true,
                // Incluimos reseñas recibidas para la reputación
                reviewsReceived: {
                    include: { reviewer: { select: { name: true } } },
                    orderBy: { createdAt: 'desc' }
                },
                // Incluimos sus servicios activos para mostrar "Más de este vendedor"
                products: {
                    where: { status: 'DISPONIBLE' }, // Solo activos
                    select: { id: true, title: true, price: true, type: true, images: true }
                }
            }
        });

        if (!user) return res.status(404).json({ error: 'Usuario no encontrado.' });

        res.json(user);
    } catch (error) {
        console.error('Error fetching public profile:', error);
        res.status(500).json({ error: 'Error al cargar perfil público.' });
    }
});


// --- RUTAS DE DASHBOARD (COMPRAS, VENTAS Y PREGUNTAS) ---

app.get('/api/dashboard', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.userId;
    if (!userId) return res.status(401).json({ error: 'Usuario no identificado.' });

    // 1. Buscar Compras (Donde soy comprador Y no lo borré)
    const purchases = await prisma.transaction.findMany({
      where: { 
        buyerId: userId,
        deletedByBuyer: false
      },
      include: {
        product: {
          select: { title: true, price: true, images: true, id: true, type: true }
        },
        seller: {
          select: { name: true, email: true }
        },
        review: true 
      },
      orderBy: { createdAt: 'desc' }
    });

    // 2. Buscar Ventas (Donde soy vendedor Y no lo borré)
    const sales = await prisma.transaction.findMany({
      where: { 
        sellerId: userId,
        deletedBySeller: false
      },
      include: {
        product: {
          select: { title: true, price: true, images: true, id: true, type: true }
        },
        buyer: {
          select: { name: true, email: true }
        }
      },
      orderBy: { createdAt: 'desc' }
    });

    // 3. Buscar Preguntas Pendientes (COMO VENDEDOR - ROJO)
    const pendingQuestions = await prisma.question.findMany({
        where: {
            product: { creatorId: userId }, 
            answer: null 
        },
        include: {
            product: { select: { title: true, id: true, images: true } }, 
            asker: { select: { name: true } } 
        },
        orderBy: { createdAt: 'asc' }
    });

    // 4. Buscar Respuestas Recibidas (COMO COMPRADOR - AZUL)
    const answersReceived = await prisma.question.findMany({
        where: {
            askerId: userId, 
            answer: { not: null }, 
            isReadByAsker: false 
        },
        include: {
            product: { select: { title: true, id: true, images: true } },
            asker: { select: { name: true } }
        },
        orderBy: { updatedAt: 'desc' } 
    });

    // 5. DETECTAR RESEÑAS PENDIENTES (OBLIGATORIAS)
    // Buscamos transacciones donde: Soy comprador, está COMPLETADO y NO hay review
    const pendingReviews = await prisma.transaction.findMany({
        where: {
            buyerId: userId,
            status: 'COMPLETADO',
            review: null // <-- Importante: Si es null, falta calificar
        },
        include: {
            seller: { select: { name: true } },
            product: { select: { title: true } }
        }
    });

    res.json({ purchases, sales, pendingQuestions, answersReceived, pendingReviews });

  } catch (error) {
    console.error('Error en dashboard:', error);
    res.status(500).json({ error: 'Error al cargar el panel.' });
  }
});


// --- RUTAS DE GESTIÓN DE INVENTARIO ---

app.get('/api/user/products', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.userId;
    const products = await prisma.product.findMany({
      where: { creatorId: userId },
      orderBy: { createdAt: 'desc' }
    });
    res.json(products);
  } catch (error) {
    console.error('Error cargando inventario:', error);
    res.status(500).json({ error: 'Error al cargar tus productos.' });
  }
});

app.delete('/api/products/:id', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const { id } = req.params;
    const userId = req.userId;

    const product = await prisma.product.findUnique({ where: { id } });
    if (!product) return res.status(404).json({ error: 'Producto no encontrado.' });
    if (product.creatorId !== userId) return res.status(403).json({ error: 'No tienes permiso.' });

    const activeTransactions = await prisma.transaction.count({
      where: { 
        productId: id,
        status: { in: ['INICIADO', 'PAGADO_EN_RETENCION', 'PENDING_WORK'] } // <-- Bloqueamos también si hay trabajos pendientes
      }
    });

    if (activeTransactions > 0) {
      return res.status(400).json({ error: 'No puedes eliminar un producto con ventas/trabajos en curso.' });
    }

    await prisma.product.delete({ where: { id } });
    res.json({ message: 'Producto eliminado.' });

  } catch (error) {
    console.error('Error eliminando producto:', error);
    res.status(500).json({ error: 'Error al eliminar producto.' });
  }
});

app.patch('/api/products/:id', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const { id } = req.params;
    const userId = req.userId;
    const { status, stock } = req.body;

    const product = await prisma.product.findUnique({ where: { id } });
    if (!product) return res.status(404).json({ error: 'Producto no encontrado.' });
    if (product.creatorId !== userId) return res.status(403).json({ error: 'No tienes permiso.' });

    const updateData: any = {};
    if (status) updateData.status = status;
    if (stock !== undefined) updateData.stock = Number(stock);

    const updatedProduct = await prisma.product.update({
      where: { id },
      data: updateData
    });

    res.json(updatedProduct);
  } catch (error) {
    console.error('Error actualizando producto:', error);
    res.status(500).json({ error: 'Error al actualizar producto.' });
  }
});


// --- RUTAS DE PRODUCTOS PÚBLICOS ---

app.get('/api/products', async (req: Request, res: Response) => {
  try {
    const { 
      search, categoryId, minPrice, maxPrice, sort, 
      condition, brand, minYear, maxYear, maxKm 
    } = req.query;

    const whereClause: Prisma.ProductWhereInput = {
        status: 'DISPONIBLE',
        stock: { gt: 0 } 
    };

    if (search) {
      const terms = String(search).trim().split(/\s+/);
      if (terms.length > 0) {
        whereClause.AND = terms.map(term => ({
          OR: [
            { title: { contains: term, mode: 'insensitive' } },
            { description: { contains: term, mode: 'insensitive' } },
            { brand: { contains: term, mode: 'insensitive' } },
            { model: { contains: term, mode: 'insensitive' } }
          ]
        }));
      }
    }

    if (categoryId && categoryId !== '') whereClause.categoryId = String(categoryId);

    if (minPrice || maxPrice) {
      whereClause.price = {};
      if (minPrice) whereClause.price.gte = Number(minPrice);
      if (maxPrice) whereClause.price.lte = Number(maxPrice);
    }

    if (condition) whereClause.condition = condition as any; 
    if (brand) whereClause.brand = { contains: String(brand), mode: 'insensitive' };
    
    if (minYear || maxYear) {
      whereClause.year = {};
      if (minYear) whereClause.year.gte = Number(minYear);
      if (maxYear) whereClause.year.lte = Number(maxYear);
    }
    
    if (maxKm) whereClause.mileage = { lte: Number(maxKm) };

    let orderBy: Prisma.ProductOrderByWithRelationInput = { createdAt: 'desc' };
    if (sort === 'price_asc') orderBy = { price: 'asc' };
    if (sort === 'price_desc') orderBy = { price: 'desc' };
    if (sort === 'oldest') orderBy = { createdAt: 'asc' };

    const products = await prisma.product.findMany({
      where: whereClause,
      orderBy: orderBy,
      include: {
        creator: { select: { name: true } },
        category: { select: { name: true } }
      },
    });

    res.status(200).json(products);

  } catch (error) {
    console.error('❌ Error crítico en búsqueda:', error);
    res.status(500).json({ error: 'Error interno al obtener los productos.' });
  }
});

app.get('/api/products/:id', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const product = await prisma.product.findUnique({
      where: { id: id },
      include: {
        creator: { select: { name: true, email: true } },
        category: { select: { name: true } },
        questions: {
            orderBy: { createdAt: 'desc' },
            include: {
                asker: { select: { name: true } }
            }
        }
      },
    });

    if (!product) return res.status(404).json({ error: 'Producto no encontrado.' });
    
    const { creator, ...rest } = product;
    const safeProduct = { ...rest, creator: { name: creator.name } };

    res.status(200).json(safeProduct);
  } catch (error) {
    console.error('Error al obtener el producto:', error);
    res.status(500).json({ error: 'Error interno al obtener el producto.' });
  }
});

app.post('/api/products', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const { 
      title, description, price, images, categoryId, type, 
      condition, brand, model, year, mileage, stock
    } = req.body;
    
    const creatorId = req.userId;

    if (!title || !description || !categoryId || !type) {
      return res.status(400).json({ error: 'Faltan campos obligatorios.' });
    }
    if (!creatorId) {
      return res.status(401).json({ error: 'No se pudo identificar al usuario.' });
    }

    let finalPrice = 0;
    if (price) finalPrice = parseFloat(price);

    if (type === 'PRODUCTO' && (!finalPrice || finalPrice <= 0)) {
        return res.status(400).json({ error: 'Para vender un Producto Físico, debes colocar un precio válido.' });
    }

    const parsedYear = year ? parseInt(year) : null;
    const parsedMileage = mileage ? parseInt(mileage) : null;

    const newProduct = await prisma.product.create({
      data: {
        title, description, price: finalPrice, images: images || [],
        creatorId: creatorId, categoryId, type,
        condition: condition || null,
        brand: brand || null,
        model: model || null,
        year: parsedYear,
        mileage: parsedMileage,
        stock: stock ? parseInt(stock) : 1
      },
    });

    res.status(201).json(newProduct);

  } catch (error) {
    console.error('Error al crear producto:', error);
    res.status(500).json({ error: 'Error interno al crear el producto.' });
  }
});


// --- RUTAS DE TRANSACCIONES ---

// 1. CREAR TRANSACCIÓN (PRODUCTO = PAGO YA / SERVICIO = RESERVA)
app.post('/api/transactions', authMiddleware, async (req: AuthRequest, res: Response) => {
  console.log('--- INICIO DE CREACIÓN DE TRANSACCIÓN ---');
  
  const { productId } = req.body;
  const buyerId = req.userId;

  try {
    const product = await prisma.product.findUnique({ where: { id: productId } });

    if (!product) return res.status(404).json({ error: 'Producto no encontrado.' });
    if (product.creatorId === buyerId) return res.status(400).json({ error: 'No puedes comprar tu propio producto.' });
    
    // --- LÓGICA DIFERENCIADA POR TIPO ---

    // A. SERVICIOS (FLUJO #008)
    if (product.type === 'SERVICIO') {
        // Creamos la transacción en estado PENDING_WORK
        const serviceTx = await prisma.transaction.create({
            data: {
                buyerId: buyerId!,
                sellerId: product.creatorId,
                productId,
                amount: product.price, // Precio inicial (estimado)
                platformFee: product.price * COMMISSION_RATE,
                sellerPayout: product.price * (1 - COMMISSION_RATE),
                status: 'PENDING_WORK' // <-- ESTADO CLAVE
            }
        });

        // Retornamos éxito pero SIN URL de pago (aún)
        return res.status(201).json({
            transaction: serviceTx,
            message: "Servicio contratado. Coordina con el profesional. El pago se generará al finalizar el trabajo.",
            paymentUrl: null 
        });
    }

    // B. PRODUCTOS FÍSICOS (FLUJO ESTÁNDAR)
    // Validación de Stock
    if (product.stock <= 0) return res.status(400).json({ error: 'Producto agotado.' });
    if (product.status !== 'DISPONIBLE') return res.status(400).json({ error: 'Producto no disponible.' });

    const amount = Number(product.price);
    if (amount <= 0) return res.status(400).json({ error: 'Precio inválido para pago.' });

    const platformFee = amount * COMMISSION_RATE;
    const sellerPayout = amount - platformFee;

    // Transacción Atómica
    const newTransaction = await prisma.$transaction(async (tx) => {
      const t = await tx.transaction.create({
        data: {
          buyerId: buyerId!, sellerId: product.creatorId, productId, 
          amount, platformFee, sellerPayout, status: 'INICIADO',
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

    // Generar Preferencia MP
    const preference = new Preference(client);
    const mpResult = await preference.create({
      body: {
        items: [{ id: productId, title: product.title, quantity: 1, unit_price: amount, currency_id: 'ARS' }],
        back_urls: {
          success: 'http://localhost:3000/payment/success',
          failure: 'http://localhost:3000/payment/failure',
          pending: 'http://localhost:3000/payment/pending'
        },
        external_reference: newTransaction.id,
      }
    });

    res.status(201).json({
      transaction: newTransaction,
      paymentUrl: mpResult.init_point
    });

  } catch (error: any) {
    console.error('Error Transacción:', error);
    if (productId) { // Rollback manual simple
       await prisma.product.update({ where: { id: productId }, data: { stock: { increment: 1 }, status: 'DISPONIBLE' } }).catch(() => {});
    }
    res.status(500).json({ error: 'Error al procesar la solicitud.', details: error.message });
  }
});

// WEBHOOK DE MERCADO PAGO (Faltaba en la versión corta, lo re-agrego)
app.post('/api/payment/webhook', async (req: Request, res: Response) => {
    const { type, data } = req.body;
    
    try {
        if (type === 'payment') {
            const paymentId = data.id;
            const payment = await paymentClient.get({ id: paymentId });
            
            if (payment.status === 'approved' && payment.external_reference) {
                const transactionId = payment.external_reference;
                
                // Actualizar estado a PAGADO
                await prisma.transaction.update({
                    where: { id: transactionId },
                    data: { 
                        status: 'PAGADO_EN_RETENCION',
                        mercadoPagoId: String(paymentId)
                    }
                });
                console.log(`💰 Pago aprobado para transacción: ${transactionId}`);
            }
        }
        res.status(200).send('OK');
    } catch (error) {
        console.error('Webhook error:', error);
        res.status(500).send('Error');
    }
});

// 2. NUEVO ENDPOINT: COBRO ÁGIL / DINÁMICO (Vendedor -> Cliente)
app.post('/api/transactions/:id/checkout-dynamic', authMiddleware, async (req: AuthRequest, res: Response) => {
    try {
        const { id } = req.params; // Transaction ID
        const { amount, description } = req.body;
        const sellerId = req.userId;

        if (!amount || amount <= 0) return res.status(400).json({ error: 'El monto debe ser mayor a 0.' });

        // Buscar transacción
        const transaction = await prisma.transaction.findUnique({
            where: { id },
            include: { product: true }
        });

        if (!transaction) return res.status(404).json({ error: 'Transacción no encontrada.' });

        // Validaciones de Seguridad
        if (transaction.sellerId !== sellerId) return res.status(403).json({ error: 'Solo el vendedor puede generar el cobro.' });
        if (transaction.product?.type !== 'SERVICIO') return res.status(400).json({ error: 'El cobro dinámico solo es para Servicios.' });
        
        // El estado debe permitir cobrar (PENDING_WORK o INICIADO si se renegocia)
        if (transaction.status === 'COMPLETADO' || transaction.status === 'CANCELADO') {
            return res.status(400).json({ error: 'Esta transacción ya está cerrada.' });
        }

        // Cálculos
        const finalAmount = Number(amount);
        const platformFee = finalAmount * COMMISSION_RATE;
        const sellerPayout = finalAmount - platformFee;

        // Actualizar Transacción con el precio real acordado
        await prisma.transaction.update({
            where: { id },
            data: {
                amount: finalAmount,
                platformFee,
                sellerPayout,
                status: 'INICIADO' 
            }
        });

        // Generar Link de Pago (Preferencia MP)
        const preference = new Preference(client);
        const mpResult = await preference.create({
            body: {
                items: [
                    {
                        id: transaction.productId || 'servicio',
                        title: description || transaction.product?.title || 'Servicio Profesional',
                        quantity: 1,
                        unit_price: finalAmount,
                        currency_id: 'ARS',
                    }
                ],
                back_urls: {
                    success: 'http://localhost:3000/payment/success',
                    failure: 'http://localhost:3000/payment/failure',
                    pending: 'http://localhost:3000/payment/pending'
                },
                external_reference: transaction.id,
            }
        });

        // Retornar el link para que el vendedor se lo muestre al cliente (QR)
        res.json({
            message: 'Cobro generado exitosamente.',
            paymentUrl: mpResult.init_point, // Link para pagar
            amount: finalAmount
        });

    } catch (error) {
        console.error('Error en cobro dinámico:', error);
        res.status(500).json({ error: 'Error al generar el cobro.' });
    }
});

// 3. NUEVO ENDPOINT (SPEC #011): LIBERACIÓN DE FONDOS (ESCROW RELEASE)
app.patch('/api/transactions/:id/release', authMiddleware, async (req: AuthRequest, res: Response) => {
    const { id } = req.params;
    const userId = req.userId;

    try {
        // 1. Buscar la transacción con datos de vendedor para notificar
        const transaction = await prisma.transaction.findUnique({
            where: { id },
            include: { seller: true }
        });

        if (!transaction) return res.status(404).json({ error: 'Transacción no encontrada.' });

        // 2. Validación de Seguridad (Rol)
        if (transaction.buyerId !== userId) {
            return res.status(403).json({ error: 'Solo el comprador puede liberar los fondos.' });
        }

        // 3. Validación de Estado
        // Permitimos liberar si está 'PAGADO_EN_RETENCION' (Flujo ideal) o 'INICIADO' (Flujo MVP sin webhook de pago)
        if (transaction.status !== 'PAGADO_EN_RETENCION' && transaction.status !== 'INICIADO') {
            return res.status(400).json({ error: 'El estado actual no permite liberar fondos.' });
        }

        // 4. Acción Principal: Completar Transacción
        const updatedTransaction = await prisma.transaction.update({
            where: { id },
            data: {
                status: 'COMPLETADO',
                updatedAt: new Date()
            }
        });

        // 5. Notificación al Vendedor
        if (resend && transaction.seller.email) {
            resend.emails.send({
                from: 'MossTall Pagos <onboarding@resend.dev>',
                to: transaction.seller.email,
                subject: `🎉 ¡Pago Liberado! Venta Completada`,
                html: `
                    <h1>¡Buenas noticias!</h1>
                    <p>El comprador ha confirmado la recepción del producto/servicio.</p>
                    <p><strong>Monto liberado:</strong> $${transaction.sellerPayout.toLocaleString('es-AR')}</p>
                    <p>El dinero estará disponible en tu cuenta pronto.</p>
                `
            }).catch(console.error);
        }

        res.json({ message: 'Fondos liberados exitosamente.', transaction: updatedTransaction });

    } catch (error) {
        console.error('Error liberando fondos:', error);
        res.status(500).json({ error: 'Error interno al liberar fondos.' });
    }
});


// CANCELACIÓN
app.patch('/api/transactions/:id/cancel', authMiddleware, async (req: AuthRequest, res: Response) => {
  const { id } = req.params;
  const userId = req.userId;

  try {
    const transaction = await prisma.transaction.findUnique({ where: { id }, include: { product: true } });
    if (!transaction) return res.status(404).json({ error: 'Transacción no encontrada.' });
    if (transaction.buyerId !== userId && transaction.sellerId !== userId) return res.status(403).json({ error: 'No tienes permiso.' });
    if (transaction.status === 'COMPLETADO' || transaction.status === 'CANCELADO') return res.status(400).json({ error: 'Estado inválido.' });

    const updatedTransaction = await prisma.$transaction(async (tx) => {
        const t = await tx.transaction.update({ where: { id }, data: { status: 'CANCELADO' } });
        if (transaction.productId && transaction.product?.type === 'PRODUCTO') { // Solo devolver stock si es producto
            await tx.product.update({ where: { id: transaction.productId }, data: { stock: { increment: 1 }, status: 'DISPONIBLE' } });
        }
        return t;
    });
    res.json(updatedTransaction);
  } catch (error) {
    res.status(500).json({ error: 'Error interno al cancelar.' });
  }
});

// BORRADO TRANSACCIONES
app.delete('/api/transactions/:id', authMiddleware, async (req: AuthRequest, res: Response) => {
  const { id } = req.params;
  const userId = req.userId;
  try {
    const transaction = await prisma.transaction.findUnique({ where: { id } });
    if (!transaction) return res.status(404).json({ error: 'No encontrada.' });
    if (transaction.buyerId === userId) await prisma.transaction.update({ where: { id }, data: { deletedByBuyer: true } });
    else if (transaction.sellerId === userId) await prisma.transaction.update({ where: { id }, data: { deletedBySeller: true } });
    else return res.status(403).json({ error: 'Sin permiso.' });
    res.json({ message: 'Eliminada.' });
  } catch (error) { res.status(500).json({ error: 'Error al eliminar.' }); }
});


// --- RUTAS DE PREGUNTAS Y RESPUESTAS (Q&A) ---

app.post('/api/questions', authMiddleware, async (req: AuthRequest, res: Response) => {
    try {
        const { productId, content } = req.body;
        const askerId = req.userId;
        if (!productId || !content) return res.status(400).json({ error: 'Faltan datos.' });
        const product = await prisma.product.findUnique({ where: { id: productId }, include: { creator: true } });
        if (!product) return res.status(404).json({ error: 'Producto no encontrado.' });
        if (product.creatorId === askerId) return res.status(400).json({ error: 'No puedes preguntar en tu propia publicación.' });

        const question = await prisma.question.create({ data: { productId, askerId: askerId!, content } });

        if (resend && product.creator.email) {
            resend.emails.send({
                from: 'MossTall <onboarding@resend.dev>',
                to: product.creator.email,
                subject: `💬 Nueva pregunta en: ${product.title}`,
                html: `<p>Te preguntaron sobre <strong>${product.title}</strong>:</p><blockquote>"${content}"</blockquote>`
            }).catch(console.error);
        }
        res.status(201).json(question);
    } catch (error) { res.status(500).json({ error: 'Error al enviar pregunta.' }); }
});

app.patch('/api/questions/:id/answer', authMiddleware, async (req: AuthRequest, res: Response) => {
    try {
        const { id } = req.params;
        const { answer } = req.body;
        const userId = req.userId;
        if (!answer) return res.status(400).json({ error: 'Respuesta vacía.' });

        const question = await prisma.question.findUnique({ where: { id }, include: { product: true, asker: true } });
        if (!question) return res.status(404).json({ error: 'Pregunta no encontrada.' });
        if (question.product.creatorId !== userId) return res.status(403).json({ error: 'No tienes permiso.' });

        const updatedQuestion = await prisma.question.update({
            where: { id },
            data: { answer, answeredAt: new Date() }
        });

        if (resend && question.asker.email) {
            resend.emails.send({
                from: 'MossTall <onboarding@resend.dev>',
                to: question.asker.email,
                subject: `✅ Te respondieron sobre: ${question.product.title}`,
                html: `<p>Respuesta: <strong>${answer}</strong></p>`
            }).catch(console.error);
        }
        res.json(updatedQuestion);
    } catch (error) { res.status(500).json({ error: 'Error al responder.' }); }
});

app.delete('/api/questions/:id', authMiddleware, async (req: AuthRequest, res: Response) => {
    try {
        const { id } = req.params;
        const userId = req.userId;
        const question = await prisma.question.findUnique({ where: { id }, include: { product: true } });
        if (!question) return res.status(404).json({ error: 'No encontrada.' });

        const isAsker = question.askerId === userId;
        const isOwner = question.product.creatorId === userId;
        if (!isAsker && !isOwner) return res.status(403).json({ error: 'Sin permiso.' });

        await prisma.question.delete({ where: { id } });
        res.json({ message: 'Eliminada.' });
    } catch (error) { res.status(500).json({ error: 'Error al eliminar.' }); }
});

app.delete('/api/questions/:id/answer', authMiddleware, async (req: AuthRequest, res: Response) => {
    try {
        const { id } = req.params;
        const userId = req.userId;
        const question = await prisma.question.findUnique({ where: { id }, include: { product: true } });
        if (!question) return res.status(404).json({ error: 'No encontrada.' });
        if (question.product.creatorId !== userId) return res.status(403).json({ error: 'Sin permiso.' });

        await prisma.question.update({ where: { id }, data: { answer: null, answeredAt: null } });
        res.json({ message: 'Respuesta eliminada.' });
    } catch (error) { res.status(500).json({ error: 'Error al eliminar respuesta.' }); }
});

app.patch('/api/questions/:id/read', authMiddleware, async (req: AuthRequest, res: Response) => {
    try {
        const { id } = req.params;
        const userId = req.userId;
        const question = await prisma.question.findUnique({ where: { id } });
        if (!question) return res.status(404).json({ error: 'No encontrada' });
        if (question.askerId !== userId) return res.status(403).json({ error: 'Sin permiso' });

        await prisma.question.update({ where: { id }, data: { isReadByAsker: true } });
        res.json({ message: 'Marcada como leída' });
    } catch (error) { res.status(500).json({ error: 'Error al marcar como leído' }); }
});


// --- RUTAS DE CHAT (SISTEMA DE MENSAJERÍA #009) ---

// 1. OBTENER MIS CHATS (INBOX) - CON CONTADOR DE NO LEÍDOS
app.get('/api/chats', authMiddleware, async (req: AuthRequest, res: Response) => {
    try {
        const userId = req.userId;
        const chats = await prisma.chatRoom.findMany({
            where: {
                transaction: {
                    OR: [
                        { buyerId: userId },
                        { sellerId: userId }
                    ]
                }
            },
            include: {
                transaction: {
                    include: {
                        product: { select: { title: true, type: true } },
                        buyer: { select: { name: true, id: true } },
                        seller: { select: { name: true, id: true } }
                    }
                },
                messages: {
                    orderBy: { createdAt: 'desc' },
                    take: 1
                },
                // Contar mensajes donde: senderId NO soy yo Y isRead es falso
                _count: {
                    select: { 
                        messages: { 
                            where: { 
                                senderId: { not: userId },
                                isRead: false
                            } 
                        } 
                    }
                }
            },
            orderBy: { updatedAt: 'desc' }
        });
        res.json(chats);
    } catch (error) {
        console.error('Error fetching chats:', error);
        res.status(500).json({ error: 'Error al cargar chats.' });
    }
});

// 2. ENTRAR A UNA SALA (GET OR CREATE) - APLICA MATRIZ DE ACCESO - CORREGIDO
app.post('/api/chats/:transactionId', authMiddleware, async (req: AuthRequest, res: Response) => {
    try {
        const { transactionId } = req.params;
        const userId = req.userId;

        // A. Buscar Transacción y validar permisos
        const transaction = await prisma.transaction.findUnique({
            where: { id: transactionId },
            include: { product: true }
        });

        if (!transaction) return res.status(404).json({ error: 'Transacción no encontrada.' });
        if (transaction.buyerId !== userId && transaction.sellerId !== userId) {
            return res.status(403).json({ error: 'No tienes permiso para ver este chat.' });
        }

        // B. MATRIZ DE ACCESO (GUARDIA DE SEGURIDAD)
        const isService = transaction.product?.type === 'SERVICIO';
        const status = transaction.status;

        // CASO 1: PRODUCTOS FÍSICOS
        if (!isService) {
            // Regla: "Silencio hasta que pagues" - Bloqueamos si está INICIADO
            /* COMENTADO PARA PRUEBAS LOCALES SIN PAGO REAL
            if (status === 'INICIADO') {
                return res.status(403).json({ error: '🔒 Chat bloqueado. Debes realizar el pago para chatear con el vendedor.' });
            }
            */
        }
        
        // C. Buscar o Crear la Sala (CON DATOS COMPLETOS)
        // Definimos la estructura de datos que queremos traer (Include)
        const chatInclude = {
            transaction: {
                include: {
                    product: { select: { title: true, type: true, price: true, images: true } },
                    buyer: { select: { name: true, id: true, email: true } },
                    seller: { select: { name: true, id: true, email: true } }
                }
            }
        };

        let chatRoom = await prisma.chatRoom.findUnique({
            where: { transactionId },
            include: chatInclude // <--- TRAER DATOS AQUÍ
        });

        if (!chatRoom) {
            chatRoom = await prisma.chatRoom.create({
                data: { transactionId },
                include: chatInclude // <--- Y AQUÍ TAMBIÉN AL CREAR
            });
        }

        res.json(chatRoom);

    } catch (error) {
        console.error('Error accessing chat:', error);
        res.status(500).json({ error: 'Error al acceder al chat.' });
    }
});

// 3. ENVIAR MENSAJE (CON isRead: false POR DEFECTO)
app.post('/api/messages', authMiddleware, async (req: AuthRequest, res: Response) => {
    try {
        const { chatRoomId, content } = req.body;
        const senderId = req.userId;

        if (!content || !content.trim()) return res.status(400).json({ error: 'Mensaje vacío.' });

        // Validar que la sala exista y el usuario pertenezca
        const chatRoom = await prisma.chatRoom.findUnique({
            where: { id: chatRoomId },
            include: { transaction: { include: { buyer: true, seller: true } } }
        });

        if (!chatRoom) return res.status(404).json({ error: 'Sala de chat no encontrada.' });
        
        // Validación de Integridad (Anti-Evasión de última hora)
        // Si cancelaron la orden mientras chateaban, bloqueamos nuevos mensajes
        if (chatRoom.transaction.status === 'CANCELADO') {
            return res.status(403).json({ error: 'La transacción fue cancelada. No se pueden enviar mensajes.' });
        }

        const isBuyer = chatRoom.transaction.buyerId === senderId;
        const isSeller = chatRoom.transaction.sellerId === senderId;

        if (!isBuyer && !isSeller) return res.status(403).json({ error: 'No perteneces a este chat.' });

        // Crear Mensaje (NO LEÍDO por defecto)
        const message = await prisma.message.create({
            data: {
                chatRoomId,
                senderId: senderId!,
                content,
                isRead: false // <--- Explícito
            }
        });

        // Actualizar Timestamp de la Sala (para ordenar inbox)
        await prisma.chatRoom.update({
            where: { id: chatRoomId },
            data: { updatedAt: new Date() }
        });

        // NOTIFICACIÓN POR EMAIL (Opcional pero recomendado)
        const receiverEmail = isBuyer ? chatRoom.transaction.seller.email : chatRoom.transaction.buyer.email;
        const senderName = isBuyer ? chatRoom.transaction.buyer.name : chatRoom.transaction.seller.name;

        if (resend && receiverEmail) {
            resend.emails.send({
                from: 'MossTall Chat <onboarding@resend.dev>',
                to: receiverEmail,
                subject: `💬 Nuevo mensaje de ${senderName}`,
                html: `<p><strong>${senderName}</strong> te escribió:</p><blockquote>"${content}"</blockquote><p>Entra a MossTall para responder.</p>`
            }).catch(console.error);
        }

        res.status(201).json(message);

    } catch (error) {
        console.error('Error sending message:', error);
        res.status(500).json({ error: 'Error al enviar mensaje.' });
    }
});

// 4. OBTENER MENSAJES DE UNA SALA (Y MARCAR COMO LEÍDOS AUTOMÁTICAMENTE)
app.get('/api/chats/:chatRoomId/messages', authMiddleware, async (req: AuthRequest, res: Response) => {
    try {
        const { chatRoomId } = req.params;
        const userId = req.userId;

        const chatRoom = await prisma.chatRoom.findUnique({
            where: { id: chatRoomId },
            include: { transaction: true }
        });

        if (!chatRoom) return res.status(404).json({ error: 'Sala no encontrada.' });
        if (chatRoom.transaction.buyerId !== userId && chatRoom.transaction.sellerId !== userId) {
            return res.status(403).json({ error: 'Sin permiso.' });
        }

        // --- LÓGICA DE MARCAR COMO LEÍDO ---
        // Actualizamos todos los mensajes de ESTA sala donde:
        // 1. Yo NO soy el sender (me los enviaron a mí).
        // 2. Aún no están leídos.
        await prisma.message.updateMany({
            where: {
                chatRoomId: chatRoomId,
                senderId: { not: userId }, // Mensajes que recibí
                isRead: false
            },
            data: { isRead: true }
        });

        // Obtenemos los mensajes (ahora ya marcados como leídos)
        const messages = await prisma.message.findMany({
            where: { chatRoomId },
            orderBy: { createdAt: 'asc' },
            include: { sender: { select: { name: true, id: true } } }
        });

        res.json(messages);

    } catch (error) {
        console.error('Error fetching messages:', error);
        res.status(500).json({ error: 'Error al cargar mensajes.' });
    }
});


// --- INICIAR EL SERVIDOR ---
const startServer = async () => {
  try {
    await prisma.$connect();
    console.log('[prisma]: Conectado a la base de datos PostgreSQL.');
    app.listen(PORT, () => {
      console.log(`[servidor]: Servidor corriendo en http://localhost:${PORT}`);
    });
  } catch (error) {
    console.error('[prisma]: No se pudo conectar a la base de datos.');
    console.error(error);
    process.exit(1);
  }
};

startServer();