// testDispute.ts
import prisma from '../src/lib/prisma';

async function main() {
  const lastTx = await prisma.transaction.findFirst({
    orderBy: { createdAt: 'desc' }
  });

  if (!lastTx) {
    console.log('❌ No hay transacciones en la base de datos.');
    return;
  }

  const updatedTx = await prisma.transaction.update({
    where: { id: lastTx.id },
    data: {
      state: 'DISPUTED',
      history: { create: { oldState: lastTx.state, newState: 'DISPUTED', actorId: lastTx.buyerId } }
    }
  });

  console.log('\n==================================================');
  console.log('✅ DISPUTA ABIERTA / FONDOS CONGELADOS CON ÉXITO');
  console.log('ID Transacción:', updatedTx.id);
  console.log('Nuevo Estado:', updatedTx.state);
  console.log('==================================================\n');
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());