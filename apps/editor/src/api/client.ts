/**
 * Typed API client (P2-T1) — the editor's ONLY door to the server.
 *
 * Request bodies are validated locally with the SAME Zod schemas the server
 * uses (`@ctb/shared`, invariant I5) so a bad payload fails fast in the UI
 * instead of round-tripping. Responses are typed with the shared `*Public`
 * DTOs. Auth is the signed session cookie — `credentials: 'include'` rides
 * on every call; a 401 raises `ApiError(status=401)` which the auth store
 * turns into a redirect to /login.
 */
import {
  type ApiErrorBody,
  type BotPublic,
  type CreateBotBody,
  CreateBotBodySchema,
  type CreateCredentialBody,
  CreateCredentialBodySchema,
  type CreateFlowBody,
  CreateFlowBodySchema,
  type CredentialPublic,
  type ExecutionDetail,
  type ExecutionSummary,
  type FlowExport,
  type FlowTemplateInfo,
  type ImportFlowBody,
  ImportFlowBodySchema,
  type ImportTemplateBody,
  ImportTemplateBodySchema,
  type RunFlowResult,
  type FlowPublic,
  type FlowVersionInfo,
  RollbackFlowBodySchema,
  type LoginBody,
  LoginBodySchema,
  type NodeTypeInfo,
  type SessionUser,
  type UpdateBotBody,
  UpdateBotBodySchema,
  type UpdateCredentialBody,
  UpdateCredentialBodySchema,
  type UpdateFlowBody,
  UpdateFlowBodySchema,
  type UpdateUserBody,
  UpdateUserBodySchema,
  type UserPublic,
} from '@ctb/shared';
import type { z } from 'zod';

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly body: ApiErrorBody,
  ) {
    super(`API ${status}: ${body.error}`);
    this.name = 'ApiError';
  }
}

/** Thrown when a body fails the shared Zod schema BEFORE any network call. */
export class ClientValidationError extends Error {
  constructor(public readonly issues: z.core.$ZodIssue[]) {
    super(`invalid request body: ${issues.map((i) => i.message).join('; ')}`);
    this.name = 'ClientValidationError';
  }
}

/** Injectable transport so tests run without a browser or server. */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface ApiClientOptions {
  baseUrl?: string;
  fetchImpl?: FetchLike;
}

export class ApiClient {
  private readonly base: string;
  private readonly fetchImpl: FetchLike;

  constructor(opts: ApiClientOptions = {}) {
    this.base = (opts.baseUrl ?? '').replace(/\/$/, '');
    this.fetchImpl = opts.fetchImpl ?? ((input, init) => fetch(input, init));
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const init: RequestInit = {
      method,
      credentials: 'include',
      headers: body !== undefined ? { 'content-type': 'application/json' } : {},
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    };
    const res = await this.fetchImpl(`${this.base}${path}`, init);
    const text = await res.text();
    const json: unknown = text ? JSON.parse(text) : {};
    if (!res.ok) throw new ApiError(res.status, json as ApiErrorBody);
    return json as T;
  }

  private validate<S extends z.ZodType>(schema: S, body: unknown): z.infer<S> {
    const parsed = schema.safeParse(body);
    if (!parsed.success) throw new ClientValidationError(parsed.error.issues);
    return parsed.data;
  }

  // -- auth -----------------------------------------------------------------

  async login(body: LoginBody): Promise<SessionUser> {
    const valid = this.validate(LoginBodySchema, body);
    const res = await this.request<{ ok: true; user: SessionUser }>(
      'POST',
      '/api/auth/login',
      valid,
    );
    return res.user;
  }

  async logout(): Promise<void> {
    await this.request<{ ok: true }>('POST', '/api/auth/logout');
  }

  /** Returns the session user, or null on 401 (not an error — just logged out). */
  async me(): Promise<SessionUser | null> {
    try {
      const res = await this.request<{ user: SessionUser }>('GET', '/api/auth/me');
      return res.user;
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) return null;
      throw err;
    }
  }

  // -- bots -----------------------------------------------------------------

  async listBots(): Promise<BotPublic[]> {
    return (await this.request<{ bots: BotPublic[] }>('GET', '/api/bots')).bots;
  }

  async getBot(id: string): Promise<BotPublic> {
    return (await this.request<{ bot: BotPublic }>('GET', `/api/bots/${id}`)).bot;
  }

  async createBot(body: CreateBotBody): Promise<BotPublic> {
    const valid = this.validate(CreateBotBodySchema, body);
    return (await this.request<{ bot: BotPublic }>('POST', '/api/bots', valid)).bot;
  }

  async updateBot(id: string, body: UpdateBotBody): Promise<BotPublic> {
    const valid = this.validate(UpdateBotBodySchema, body);
    return (await this.request<{ bot: BotPublic }>('PATCH', `/api/bots/${id}`, valid)).bot;
  }

  async deleteBot(id: string): Promise<void> {
    await this.request<{ ok: true }>('DELETE', `/api/bots/${id}`);
  }

  async startBot(id: string): Promise<void> {
    await this.request<{ ok: true }>('POST', `/api/bots/${id}/start`);
  }

  async stopBot(id: string): Promise<void> {
    await this.request<{ ok: true }>('POST', `/api/bots/${id}/stop`);
  }

  // -- flows ----------------------------------------------------------------

  async listFlows(botId?: string): Promise<FlowPublic[]> {
    const qs = botId ? `?botId=${encodeURIComponent(botId)}` : '';
    return (await this.request<{ flows: FlowPublic[] }>('GET', `/api/flows${qs}`)).flows;
  }

  async getFlow(id: string): Promise<FlowPublic> {
    return (await this.request<{ flow: FlowPublic }>('GET', `/api/flows/${id}`)).flow;
  }

  async createFlow(body: CreateFlowBody): Promise<FlowPublic> {
    const valid = this.validate(CreateFlowBodySchema, body);
    return (await this.request<{ flow: FlowPublic }>('POST', '/api/flows', valid)).flow;
  }

  async updateFlow(id: string, body: UpdateFlowBody): Promise<FlowPublic> {
    const valid = this.validate(UpdateFlowBodySchema, body);
    return (await this.request<{ flow: FlowPublic }>('PATCH', `/api/flows/${id}`, valid)).flow;
  }

  async deleteFlow(id: string): Promise<void> {
    await this.request<{ ok: true }>('DELETE', `/api/flows/${id}`);
  }

  async activateFlow(id: string): Promise<void> {
    await this.request<{ ok: true }>('POST', `/api/flows/${id}/activate`);
  }

  async deactivateFlow(id: string): Promise<void> {
    await this.request<{ ok: true }>('POST', `/api/flows/${id}/deactivate`);
  }

  // -- flow lifecycle (P2-T4) -------------------------------------------------

  async listFlowVersions(id: string): Promise<{ current: number; versions: FlowVersionInfo[] }> {
    return this.request<{ current: number; versions: FlowVersionInfo[] }>(
      'GET',
      `/api/flows/${id}/versions`,
    );
  }

  /** Restore an older snapshot; server bumps version and returns the new flow. */
  async rollbackFlow(id: string, version: number): Promise<FlowPublic> {
    const valid = this.validate(RollbackFlowBodySchema, { version });
    return (
      await this.request<{ flow: FlowPublic }>('POST', `/api/flows/${id}/rollback`, valid)
    ).flow;
  }

  // -- import / export + template gallery (P3-T7) -----------------------------

  /** Download a flow's portable design envelope (graph + settings, no identity). */
  async exportFlow(id: string): Promise<FlowExport> {
    return (await this.request<{ export: FlowExport }>('GET', `/api/flows/${id}/export`)).export;
  }

  /** Create a NEW flow on `botId` from an export envelope (server re-validates). */
  async importFlow(body: ImportFlowBody): Promise<FlowPublic> {
    const valid = this.validate(ImportFlowBodySchema, body);
    return (await this.request<{ flow: FlowPublic }>('POST', '/api/flows/import', valid)).flow;
  }

  /** The generic starter template gallery. */
  async listFlowTemplates(): Promise<FlowTemplateInfo[]> {
    return (await this.request<{ templates: FlowTemplateInfo[] }>('GET', '/api/flow-templates'))
      .templates;
  }

  /** Create a NEW flow from a gallery template by its stable id. */
  async importTemplate(body: ImportTemplateBody): Promise<FlowPublic> {
    const valid = this.validate(ImportTemplateBodySchema, body);
    return (await this.request<{ flow: FlowPublic }>('POST', '/api/flows/import-template', valid))
      .flow;
  }

  // -- credentials (P3-T4) ----------------------------------------------------

  async listCredentials(): Promise<CredentialPublic[]> {
    return (await this.request<{ credentials: CredentialPublic[] }>('GET', '/api/credentials'))
      .credentials;
  }

  async createCredential(body: CreateCredentialBody): Promise<CredentialPublic> {
    const valid = this.validate(CreateCredentialBodySchema, body);
    return (
      await this.request<{ credential: CredentialPublic }>('POST', '/api/credentials', valid)
    ).credential;
  }

  async updateCredential(id: string, body: UpdateCredentialBody): Promise<CredentialPublic> {
    const valid = this.validate(UpdateCredentialBodySchema, body);
    return (
      await this.request<{ credential: CredentialPublic }>(
        'PATCH',
        `/api/credentials/${id}`,
        valid,
      )
    ).credential;
  }

  async deleteCredential(id: string): Promise<void> {
    await this.request<{ ok: true }>('DELETE', `/api/credentials/${id}`);
  }

  // -- users (Users page, P3-T5) ----------------------------------------------

  async listUsers(botId: string, opts: { limit?: number; offset?: number } = {}): Promise<UserPublic[]> {
    const params = new URLSearchParams({ botId });
    if (opts.limit !== undefined) params.set('limit', String(opts.limit));
    if (opts.offset !== undefined) params.set('offset', String(opts.offset));
    return (await this.request<{ users: UserPublic[] }>('GET', `/api/users?${params.toString()}`)).users;
  }

  async getUser(id: string): Promise<UserPublic> {
    return (await this.request<{ user: UserPublic }>('GET', `/api/users/${id}`)).user;
  }

  async updateUser(id: string, body: UpdateUserBody): Promise<UserPublic> {
    const valid = this.validate(UpdateUserBodySchema, body);
    return (await this.request<{ user: UserPublic }>('PATCH', `/api/users/${id}`, valid)).user;
  }

  // -- node types (canvas palette, P2-T2) -------------------------------------

  async listNodeTypes(): Promise<NodeTypeInfo[]> {
    return (await this.request<{ nodeTypes: NodeTypeInfo[] }>('GET', '/api/node-types')).nodeTypes;
  }

  // -- executions (NDV run data, P2-T3.5) -------------------------------------

  async listExecutions(opts: { flowId?: string; botId?: string; status?: string; limit?: number } = {}): Promise<ExecutionSummary[]> {
    const params = new URLSearchParams();
    if (opts.flowId) params.set('flowId', opts.flowId);
    if (opts.botId) params.set('botId', opts.botId);
    if (opts.status) params.set('status', opts.status);
    if (opts.limit) params.set('limit', String(opts.limit));
    const qs = params.size > 0 ? `?${params.toString()}` : '';
    return (await this.request<{ executions: ExecutionSummary[] }>('GET', `/api/executions${qs}`)).executions;
  }

  async getExecution(id: string): Promise<ExecutionDetail> {
    return (await this.request<{ execution: ExecutionDetail }>('GET', `/api/executions/${id}`)).execution;
  }

  /**
   * Manual test run (P2-T7): starts at the flow's flow.manualTrigger and runs
   * synchronously to the first WAIT / end / error. 422 when no manual trigger.
   */
  async runFlow(id: string): Promise<RunFlowResult> {
    return this.request<RunFlowResult>('POST', `/api/flows/${id}/run`);
  }

  /** Cancel a waiting/running execution (P2-T5). 409 ApiError when already finished. */
  async cancelExecution(id: string): Promise<ExecutionSummary> {
    return (
      await this.request<{ ok: true; execution: ExecutionSummary }>(
        'POST',
        `/api/executions/${id}/cancel`,
      )
    ).execution;
  }
}

/** App-wide singleton — pages import this; tests build their own with a fake fetch. */
export const api = new ApiClient();
