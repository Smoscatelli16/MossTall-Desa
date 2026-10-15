// createTestTx.ts
import prisma from '../src/lib/prisma';

async function main() {
  // 1. Obtenemos o creamos comprador de prueba
  let buyer = await prisma.user.findFirst();
  if (!buyer) {
    buyer = await prisma.user.create({
      data: { email: 'comprador@test.com', name: 'Comprador Test' }
    });
  }

  // 2. Obtenemos o creamos vendedor de prueba
  let seller = await prisma.user.findFirst({ where: { NOT: { id: buyer.id } } });
  if (!seller) {
    seller = await prisma.user.create({
      data: { email: 'vendedor@test.com', name: 'Vendedor Test' }
    });
  }

  // 3. Generamos la transacción PENDING
  const tx = await prisma.transaction.create({
    data: {
      buyerId: buyer.id,
      sellerId: seller.id,
      amount: 5000,
      platformFee: 250,
      sellerPayout: 4750,
      state: 'PENDING',
      history: { create: { newState: 'PENDING', actorId: buyer.id } }
    }
  });

  console.log('\n==================================================');
  console.log('✅ TRANSACCIÓN DE PRUEBA CREADA CON ÉXITO');
  console.log('ID PARA COPIAR:', tx.id);
  console.log('==================================================\n');
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());