import { prisma } from '../lib/prisma/client';

async function run() {


  const docs = await prisma.regulatoryDocument.findMany({
    where: {
      OR: [
        { title: { contains: 'Banking Act' } },
        { title: { contains: 'Proceeds of Crime and Anti-Money Laundering Regulations' } },
        { title: { contains: 'Computer Misuse and Cybercrimes Act, 2018' } },
        { title: { contains: 'Kenya Information and Communications Act' } },
      ]
    },
    select: { id: true, title: true }
  });

  console.log(JSON.stringify(docs, null, 2));
}

run().finally(() => prisma.$disconnect());
