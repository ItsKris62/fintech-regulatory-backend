/**
 * Generates a unique ticket number in the format SB-YYYY-NNNNN.
 * Must be called inside a transaction to prevent race conditions.
 */
export async function generateTicketNumber(prisma: any): Promise<string> {
  const year = new Date().getFullYear();
  const prefix = `SB-${year}-`;

  const lastTicket = await prisma.supportTicket.findFirst({
    where: { ticketNumber: { startsWith: prefix } },
    orderBy: { ticketNumber: 'desc' },
    select: { ticketNumber: true },
  });

  const nextNum = lastTicket
    ? parseInt(lastTicket.ticketNumber.split('-')[2], 10) + 1
    : 1;

  return `${prefix}${String(nextNum).padStart(5, '0')}`;
}
