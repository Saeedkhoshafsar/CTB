/**
 * NodeRegistry — maps node type ids ("tg.sendMessage") to their NodeDef
 * (P1-T4). The executor resolves implementations ONLY through the registry;
 * params are validated against each node's Zod schema (invariant I5) at
 * resolve time so execute() always receives typed params.
 */
import {
  NodeParamsError,
  UnknownNodeTypeError,
  type NodeDef,
  type PortName,
} from '@ctb/shared';

export class NodeRegistry {
  private readonly defs = new Map<string, NodeDef<unknown>>();

  register<P>(def: NodeDef<P>): this {
    if (this.defs.has(def.type)) {
      throw new Error(`node type "${def.type}" already registered`);
    }
    this.defs.set(def.type, def as NodeDef<unknown>);
    return this;
  }

  has(type: string): boolean {
    return this.defs.has(type);
  }

  get(type: string): NodeDef<unknown> {
    const def = this.defs.get(type);
    if (!def) throw new UnknownNodeTypeError(type);
    return def;
  }

  /** All registered defs (editor palette, docs generation). */
  list(): NodeDef<unknown>[] {
    return [...this.defs.values()];
  }

  /**
   * Validate raw graph params against the node's schema.
   * Throws typed NodeParamsError with node context for exec_logs.
   */
  parseParams(type: string, nodeId: string, rawParams: unknown): unknown {
    const def = this.get(type);
    const parsed = def.paramsSchema.safeParse(rawParams);
    if (!parsed.success) {
      const detail = parsed.error.issues
        .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
        .join('; ');
      throw new NodeParamsError(
        `invalid params for ${type} (node "${nodeId}"): ${detail}`,
        nodeId,
        type,
      );
    }
    return parsed.data;
  }

  /** Effective output ports for a node instance (handles dynamicOutputs). */
  outputsFor(type: string, params: unknown): PortName[] {
    const def = this.get(type);
    return def.dynamicOutputs ? def.dynamicOutputs(params) : def.ports.outputs;
  }
}
