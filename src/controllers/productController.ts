// src/controllers/productController.ts
import { Request, Response } from 'express';
import { Prisma } from '@prisma/client';
import prisma from '../lib/prisma';
import { AuthRequest } from '../middlewares/authMiddleware';

// --- CATEGORÍAS ---
export const getCategories = async (req: Request, res: Response) => {
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
};

// --- PRODUCTOS PÚBLICOS (BÚSQUEDA, FILTROS Y PAGINACIÓN) ---
export const getPublicProducts = async (req: Request, res: Response) => {
  try {
    const { 
      search, categoryId, minPrice, maxPrice, sort, 
      condition, brand, minYear, maxYear, maxKm,
      page, type // BRIEF #041: Agregados type y page
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

    // BRIEF #041: Filtro múltiple por tipo
    if (type) {
      const types = String(type).split(',');
      whereClause.type = { in: types as any[] };
    }

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

    // BRIEF #041: Lógica Estricta de Paginación
    const currentPage = Number(page) || 1;
    const take = 20; // Límite estricto en memoria
    const skip = (currentPage - 1) * take;

    // Ejecución paralela para rendimiento
    const [products, totalItems] = await Promise.all([
        prisma.product.findMany({
            where: whereClause,
            orderBy: orderBy,
            take: take,
            skip: skip,
            include: {
                store: { 
                    select: { 
                        id: true, 
                        name: true, 
                        logoUrl: true, 
                        type: true,
                        ownerId: true 
                    } 
                },
                category: { select: { name: true } }
            },
        }),
        prisma.product.count({ where: whereClause })
    ]);

    const totalPages = Math.ceil(totalItems / take);

    res.status(200).json({
        products,
        pagination: {
            currentPage,
            totalPages,
            totalItems
        }
    });

  } catch (error) {
    console.error('❌ Error crítico en búsqueda:', error);
    res.status(500).json({ error: 'Error interno al obtener los productos.' });
  }
};

export const getProductDetail = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const product = await prisma.product.findUnique({
      where: { id: id },
      include: {
        store: { 
            select: { 
                id: true, 
                name: true, 
                type: true,
                ratingAverage: true,
                totalReviews: true,
                totalSales: true,
                owner: { select: { id: true, name: true, email: true } } // Mantenemos acceso al usuario real si hace falta
            } 
        },
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
    
    res.status(200).json(product);
  } catch (error) {
    console.error('Error al obtener el producto:', error);
    res.status(500).json({ error: 'Error interno al obtener el producto.' });
  }
};

// --- GESTIÓN DE INVENTARIO (PROTEGIDO) ---

export const getUserInventory = async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.userId;
    const products = await prisma.product.findMany({
      where: { 
          store: { ownerId: userId } // Filtramos por las tiendas que pertenecen al usuario
      },
      orderBy: { createdAt: 'desc' },
      include: { store: { select: { name: true, type: true } } }
    });
    res.json(products);
  } catch (error) {
    console.error('Error cargando inventario:', error);
    res.status(500).json({ error: 'Error al cargar tus productos.' });
  }
};

export const createProduct = async (req: AuthRequest, res: Response) => {
  try {
    const { 
      storeId, title, description, price, images, categoryId, type, 
      condition, brand, model, year, mileage, stock, 
      suggestedCategory 
    } = req.body;
    
    const userId = req.userId;

    if (!title || !description || !categoryId || !type || !storeId) {
      return res.status(400).json({ error: 'Faltan campos obligatorios.' });
    }
    if (!userId) {
      return res.status(401).json({ error: 'No se pudo identificar al usuario.' });
    }

    // --- VALIDACIÓN DE PROPIEDAD DE TIENDA Y TIPO ---
    const store = await prisma.store.findUnique({
        where: { id: storeId }
    });

    if (!store) {
        return res.status(404).json({ error: 'La tienda seleccionada no existe.' });
    }

    if (store.ownerId !== userId) {
        return res.status(403).json({ error: 'No tienes permisos para publicar en esta tienda.' });
    }

    // Aseguramos que el tipo de producto coincida lógicamente con el tipo de tienda
    if (store.type === 'PRODUCT_STORE' && type !== 'PRODUCTO') {
         return res.status(400).json({ error: 'Las Tiendas de Productos solo pueden publicar PRODUCTOS físicos.' });
    }
    if (store.type === 'SERVICE_PROFESSIONAL' && type !== 'SERVICIO') {
         return res.status(400).json({ error: 'Los Perfiles Profesionales solo pueden publicar SERVICIOS.' });
    }
    if (store.type === 'DIGITAL_CREATOR' && type !== 'INFOPRODUCTO') {
         return res.status(400).json({ error: 'Los Creadores Digitales solo pueden publicar INFOPRODUCTOS.' });
    }
    // ------------------------------------------

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
        storeId: storeId, categoryId, type,
        condition: condition || null,
        brand: brand || null,
        model: model || null,
        year: parsedYear,
        mileage: parsedMileage,
        stock: stock ? parseInt(stock) : 1,
        suggestedCategory: suggestedCategory || null 
      },
    });

    res.status(201).json(newProduct);

  } catch (error) {
    console.error('Error al crear producto:', error);
    res.status(500).json({ error: 'Error interno al crear el producto.' });
  }
};

export const deleteProduct = async (req: AuthRequest, res: Response) => {
  try {
    const { id } = req.params;
    const userId = req.userId;

    const product = await prisma.product.findUnique({ 
        where: { id },
        include: { store: true }
    });
    if (!product) return res.status(404).json({ error: 'Producto no encontrado.' });
    if (product.store.ownerId !== userId) return res.status(403).json({ error: 'No tienes permiso.' });

    const activeTransactions = await prisma.transaction.count({
      where: { 
        productId: id,
        state: { in: ['PENDING', 'PAID_HELD', 'DELIVERY_CONFIRMED', 'DISPUTED'] }
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
};

export const updateProduct = async (req: AuthRequest, res: Response) => {
  try {
    const { id } = req.params;
    const userId = req.userId;
    const { status, stock } = req.body;

    const product = await prisma.product.findUnique({ 
        where: { id },
        include: { store: true }
    });
    if (!product) return res.status(404).json({ error: 'Producto no encontrado.' });
    if (product.store.ownerId !== userId) return res.status(403).json({ error: 'No tienes permiso.' });

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
};

// --- MÓDULO DE PREGUNTAS Y RESPUESTAS (Q&A) ---

export const askQuestion = async (req: AuthRequest, res: Response) => {
  try {
    const { id: productId } = req.params;
    const { content } = req.body;
    const askerId = req.userId;

    if (!askerId) return res.status(401).json({ error: 'Debes iniciar sesión para preguntar.' });
    if (!content || content.trim().length < 5) return res.status(400).json({ error: 'La pregunta es muy corta.' });

    const product = await prisma.product.findUnique({ 
        where: { id: productId },
        include: { store: true }
    });
    if (!product) return res.status(404).json({ error: 'Producto no encontrado.' });
    if (product.store.ownerId === askerId) return res.status(400).json({ error: 'No puedes preguntarte a ti mismo.' });

    const newQuestion = await prisma.question.create({
      data: {
        content: content.trim(),
        productId,
        askerId
      },
      include: { asker: { select: { name: true } } }
    });

    res.status(201).json(newQuestion);
  } catch (error) {
    console.error('Error creando pregunta:', error);
    res.status(500).json({ error: 'Error al enviar la pregunta.' });
  }
};

export const answerQuestion = async (req: AuthRequest, res: Response) => {
  try {
    const { id: questionId } = req.params;
    const { answer } = req.body;
    const userId = req.userId;

    if (!answer || answer.trim().length < 2) return res.status(400).json({ error: 'La respuesta es inválida.' });

    const question = await prisma.question.findUnique({ 
      where: { id: questionId },
      include: { product: { include: { store: true } } } 
    });

    if (!question) return res.status(404).json({ error: 'Pregunta no encontrada.' });
    if (question.product.store.ownerId !== userId) return res.status(403).json({ error: 'Solo el dueño de la tienda puede responder.' });
    if (question.answer) return res.status(400).json({ error: 'Esta pregunta ya fue respondida.' });

    const updatedQuestion = await prisma.question.update({
      where: { id: questionId },
      data: { 
        answer: answer.trim(),
        answeredAt: new Date(),
        isReadByAsker: false // Para notificar al comprador en su dashboard
      }
    });

    res.json(updatedQuestion);
  } catch (error) {
    console.error('Error respondiendo pregunta:', error);
    res.status(500).json({ error: 'Error al enviar la respuesta.' });
  }
};