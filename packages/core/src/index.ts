/**
 * @ctb/core — THE ENGINE. Pure logic: executor, expression engine, registry,
 * execution store interfaces. NEVER imports Telegram/Fastify/DB drivers (invariant I3).
 */
import { CTB_VERSION } from '@ctb/shared';

/** Dependency-chain proof (shared←core); used by @ctb/nodes' chain test. */
export const CORE_DEPENDS_ON_SHARED: string = CTB_VERSION;

export * from './expression/index';
export * from './store/index';
export * from './registry/index';
export * from './engine/index';
