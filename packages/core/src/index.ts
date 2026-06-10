/**
 * @ctb/core — THE ENGINE. Pure logic: executor, expression engine, registry,
 * execution store interfaces. NEVER imports Telegram/Fastify/DB drivers (invariant I3).
 * Engine lands in Phase 1. This file is the P0-T1 placeholder.
 */
import { CTB_VERSION } from '@ctb/shared';

export const CORE_DEPENDS_ON_SHARED: string = CTB_VERSION;
