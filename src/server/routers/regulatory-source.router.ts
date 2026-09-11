import { z } from 'zod';
import { router, adminProcedure } from '../trpc/trpc';
import {
  regulatorySourceService,
  regulatoryFetchService,
  createRegulatorySourceSchema,
  updateRegulatorySourceSchema,
  listRegulatorySourcesSchema,
} from '@/modules/regulatory-intelligence/domain';

export const regulatorySourceRouter = router({
  createSource: adminProcedure
    .input(createRegulatorySourceSchema)
    .mutation(async ({ input }) => regulatorySourceService.createSource(input)),

  updateSource: adminProcedure
    .input(
      z.object({ id: z.string().min(1) }).and(updateRegulatorySourceSchema)
    )
    .mutation(async ({ input }) => {
      const { id, ...data } = input;
      return regulatorySourceService.updateSource(id, data);
    }),

  deactivateSource: adminProcedure
    .input(z.object({ id: z.string().min(1) }))
    .mutation(async ({ input }) => regulatorySourceService.deactivateSource(input.id)),

  getSource: adminProcedure
    .input(z.object({ id: z.string().min(1) }))
    .query(async ({ input }) => regulatorySourceService.getSource(input.id)),

  listSources: adminProcedure
    .input(listRegulatorySourcesSchema)
    .query(async ({ input }) => regulatorySourceService.listSources(input)),

  testConnection: adminProcedure
    .input(z.object({ id: z.string().min(1) }))
    .mutation(async ({ input }) => regulatoryFetchService.testConnection(input.id)),
});
