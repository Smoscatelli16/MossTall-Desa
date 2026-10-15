// testDaemon.ts
import prisma from '../src/lib/prisma';

async function main() {
  // 1. Obtenemos comprador y vendedor
  const buyer = await prisma.user.findFirst();
  const seller = await prisma.user.findFirst({ where: { NOT: { id: buyer?.id } } });

  // 2. Creamos una segunda transacción sin problemas en estado PAID_HELD
  const normalTx = await prisma.transaction.create({
    data: {
      buyerId: buyer!.id,
      sellerId: seller!.id,
      amount: 8000,
      platformFee: 400,
      sellerPayout: 7600,
      state: 'PAID_HELD',
      history: { create: { newState: 'PAID_HELD', actorId: buyer!.id } }
    }
  });

  console.log('📌 Creada nueva transacción normal en custodia (PAID_HELD)...');

  // 3. Ejecutamos el filtro del Escrow Daemon (libera solo las PAID_HELD)
  const heldTransactions = await prisma.transaction.findMany({
    where: { state: 'PAID_HELD' }
  });

  for (const tx of heldTransactions) {
    await prisma.transaction.update({
      where: { id: tx.id },
      data: {
        state: 'FUNDS_RELEASED',
        history: { create: { oldState: 'PAID_HELD', newState: 'FUNDS_RELEASED', actorId: 'SYSTEM_CRON' } }
      }
    });
  }

  // 4. Reporte final de estados en la base de datos
  const allTxs = await prisma.transaction.findMany({
    select: { id: true, state: true }
  });

  console.log('\n==================================================');
  console.log('🤖 RESULTADO DEL ESCROW DAEMON');
  console.log('==================================================');
  allTxs.forEach((tx) => {
    console.log(`• ID: ${tx.id.slice(0, 8)}... | Estado Actual: [ ${tx.state} ]`);
  });
  console.log('==================================================\n');
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());