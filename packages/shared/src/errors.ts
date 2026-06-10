/** Typed error classes shared across packages (CLAUDE.md §7). */

export class CtbError extends Error {
  constructor(message: string, readonly code: string) {
    super(message);
    this.name = new.target.name;
  }
}

/** A {{ }} expression failed to evaluate. */
export class ExpressionError extends CtbError {
  constructor(message: string, readonly expression: string) {
    super(message, 'EXPRESSION_ERROR');
  }
}

/** Node params failed schema validation at runtime. */
export class NodeParamsError extends CtbError {
  constructor(message: string, readonly nodeId: string, readonly nodeType: string) {
    super(message, 'NODE_PARAMS_ERROR');
  }
}

/** Graph references a node type the registry doesn't know. */
export class UnknownNodeTypeError extends CtbError {
  constructor(readonly nodeType: string) {
    super(`unknown node type "${nodeType}"`, 'UNKNOWN_NODE_TYPE');
  }
}

/** Execution exceeded its step or wall-time budget. */
export class ExecutionBudgetError extends CtbError {
  constructor(message: string) {
    super(message, 'EXECUTION_BUDGET');
  }
}

/** Sandboxed code failed or timed out. */
export class SandboxError extends CtbError {
  constructor(message: string) {
    super(message, 'SANDBOX_ERROR');
  }
}
