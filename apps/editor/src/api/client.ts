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
  type AiUsageSummary,
  type ApiErrorBody,
  type BotAiBudget,
  type BotPublic,
  type SetBotAiBudgetBody,
  SetBotAiBudgetBodySchema,
  type CollectionPackInfo,
  type CollectionPublic,
  type CreateBotBody,
  CreateBotBodySchema,
  type CreateCollectionBody,
  CreateCollectionBodySchema,
  type CreateCredentialBody,
  CreateCredentialBodySchema,
  type CreateFlowBody,
  CreateFlowBodySchema,
  type CreateRecordBody,
  CreateRecordBodySchema,
  type CredentialPublic,
  type ExecutionDetail,
  type ExecutionSummary,
  type FilePublic,
  type FlowExport,
  type FlowTemplateInfo,
  type ImportFlowBody,
  ImportFlowBodySchema,
  type ImportTemplateBody,
  ImportTemplateBodySchema,
  type RunFlowResult,
  type TestListenArmed,
  type TestListenStatus,
  type FlowItem,
  type FlowPublic,
  type FlowVersionInfo,
  RollbackFlowBodySchema,
  type LoginBody,
  LoginBodySchema,
  type NodeTypeInfo,
  type QueryRecordsBody,
  QueryRecordsBodySchema,
  type RecordPublic,
  type RecordsPage,
  type SessionUser,
  type UpdateBotBody,
  UpdateBotBodySchema,
  type UpdateCollectionBody,
  UpdateCollectionBodySchema,
  type UpdateCredentialBody,
  UpdateCredentialBodySchema,
  type UpdateFlowBody,
  UpdateFlowBodySchema,
  type UpdateRecordBody,
  UpdateRecordBodySchema,
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

  /** AI spend summary for a bot (PD-T2) — budget + today/all-time + per-credential. */
  async getBotAiUsage(id: string): Promise<AiUsageSummary> {
    return (await this.request<{ usage: AiUsageSummary }>('GET', `/api/bots/${id}/ai-usage`)).usage;
  }

  /** Set a bot's AI budget (PD-T2). `0` on any field = unlimited. */
  async setBotAiBudget(id: string, body: SetBotAiBudgetBody): Promise<BotAiBudget> {
    const valid = this.validate(SetBotAiBudgetBodySchema, body);
    return (await this.request<{ budget: BotAiBudget }>('PUT', `/api/bots/${id}/ai-budget`, valid)).budget;
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

  // -- collections (Data section, P3.5-T3) ------------------------------------

  /** List a bot's collection definitions (admin only). */
  async listCollections(botId: string): Promise<CollectionPublic[]> {
    const qs = `?botId=${encodeURIComponent(botId)}`;
    return (await this.request<{ collections: CollectionPublic[] }>('GET', `/api/collections${qs}`))
      .collections;
  }

  async getCollection(id: string): Promise<CollectionPublic> {
    return (await this.request<{ collection: CollectionPublic }>('GET', `/api/collections/${id}`))
      .collection;
  }

  /** Define a new collection on `botId` (schema validated locally first, I5). */
  async createCollection(botId: string, body: CreateCollectionBody): Promise<CollectionPublic> {
    const valid = this.validate(CreateCollectionBodySchema, body);
    const qs = `?botId=${encodeURIComponent(botId)}`;
    return (
      await this.request<{ collection: CollectionPublic }>('POST', `/api/collections${qs}`, valid)
    ).collection;
  }

  async updateCollection(id: string, body: UpdateCollectionBody): Promise<CollectionPublic> {
    const valid = this.validate(UpdateCollectionBodySchema, body);
    return (
      await this.request<{ collection: CollectionPublic }>('PATCH', `/api/collections/${id}`, valid)
    ).collection;
  }

  async deleteCollection(id: string): Promise<void> {
    await this.request<{ ok: true }>('DELETE', `/api/collections/${id}`);
  }

  // -- starter packs (P3.5-T6) ------------------------------------------------

  /** List the shipped starter packs (gallery rows — no heavy schema/graph). */
  async listCollectionPacks(): Promise<CollectionPackInfo[]> {
    return (await this.request<{ packs: CollectionPackInfo[] }>('GET', '/api/collection-packs'))
      .packs;
  }

  /** Import a pack onto a bot: creates its collections (skipping existing slugs)
   *  + its flows as drafts in one call. Returns what was created/skipped. */
  async importCollectionPack(
    botId: string,
    packId: string,
  ): Promise<{
    pack: string;
    collections: CollectionPublic[];
    skippedCollections: string[];
    flows: { id: string; name: string }[];
  }> {
    return this.request('POST', '/api/collection-packs/import', { botId, packId });
  }

  // -- records (auto-generated CRUD panel, P3.5-T3/T4) ------------------------

  /** Simple paged list (no filter). For filtered reads use queryRecords. */
  async listRecords(
    collectionId: string,
    opts: { limit?: number; offset?: number } = {},
  ): Promise<RecordsPage> {
    const params = new URLSearchParams();
    if (opts.limit !== undefined) params.set('limit', String(opts.limit));
    if (opts.offset !== undefined) params.set('offset', String(opts.offset));
    const qs = params.size > 0 ? `?${params.toString()}` : '';
    return this.request<RecordsPage>('GET', `/api/records/${collectionId}${qs}`);
  }

  /** Filtered query — the shared RecordFilter travels as a JSON POST body (I5). */
  async queryRecords(collectionId: string, body: QueryRecordsBody): Promise<RecordsPage> {
    const valid = this.validate(QueryRecordsBodySchema, body);
    return this.request<RecordsPage>('POST', `/api/records/${collectionId}/query`, valid);
  }

  /** Live record count — used by the destructive-edit warning (P3.5-T3 accept). */
  async countRecords(collectionId: string): Promise<number> {
    return (await this.request<{ count: number }>('GET', `/api/records/${collectionId}/count`))
      .count;
  }

  async getRecord(collectionId: string, id: string): Promise<RecordPublic> {
    return (
      await this.request<{ record: RecordPublic }>('GET', `/api/records/${collectionId}/${id}`)
    ).record;
  }

  async createRecord(collectionId: string, body: CreateRecordBody): Promise<RecordPublic> {
    const valid = this.validate(CreateRecordBodySchema, body);
    return (
      await this.request<{ record: RecordPublic }>('POST', `/api/records/${collectionId}`, valid)
    ).record;
  }

  async updateRecord(
    collectionId: string,
    id: string,
    body: UpdateRecordBody,
  ): Promise<RecordPublic> {
    const valid = this.validate(UpdateRecordBodySchema, body);
    return (
      await this.request<{ record: RecordPublic }>(
        'PATCH',
        `/api/records/${collectionId}/${id}`,
        valid,
      )
    ).record;
  }

  async deleteRecord(collectionId: string, id: string): Promise<void> {
    await this.request<{ ok: true }>('DELETE', `/api/records/${collectionId}/${id}`);
  }

  // -- files (image/file field uploads, P3.5-T4) ------------------------------

  /**
   * Upload bytes for an `image`/`file` field. The server takes a small
   * JSON+base64 body (no multipart dep) scoped to a bot and returns the file id
   * (stored in the record) + a download URL the panel renders.
   */
  async uploadFile(botId: string, data: string, mime?: string | null): Promise<FilePublic> {
    const qs = `?botId=${encodeURIComponent(botId)}`;
    return (
      await this.request<{ file: FilePublic }>('POST', `/api/files${qs}`, {
        data,
        ...(mime ? { mime } : {}),
      })
    ).file;
  }

  /** Convenience: read the absolute download URL for a stored file id. */
  fileUrl(id: string): string {
    return `${this.base}/api/files/${encodeURIComponent(id)}`;
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

  /**
   * Single-node run (I-T2, gap G16): execute ONE node and stop, without running
   * the whole flow. Always a TEST run, so a pinned node honours its pin. The
   * editor reads the node's output from the execution log (run-data store).
   */
  async runNode(id: string, nodeId: string, input?: FlowItem[]): Promise<RunFlowResult> {
    return this.request<RunFlowResult>('POST', `/api/flows/${id}/run-node`, {
      nodeId,
      ...(input !== undefined ? { input } : {}),
    });
  }

  /**
   * Live-trigger test run (J-T2, Report B): arm the flow's enabled `tg.trigger`
   * to capture the NEXT matching live update — n8n's "listen for test event".
   * Returns the armed execution id; the editor then polls {@link testListenStatus}.
   * 422 `no_telegram_trigger` when the flow has no enabled `tg.trigger`.
   */
  async testListen(id: string): Promise<TestListenArmed> {
    return this.request<TestListenArmed>('POST', `/api/flows/${id}/test-listen`);
  }

  /** Poll an armed test-listen's lifecycle (listening → captured/expired/gone). */
  async testListenStatus(id: string, executionId: string): Promise<TestListenStatus> {
    return this.request<TestListenStatus>(
      'GET',
      `/api/flows/${id}/test-listen/status?executionId=${encodeURIComponent(executionId)}`,
    );
  }

  /** Disarm an armed test-listen (the waiting banner's Cancel button). */
  async testListenCancel(id: string, executionId: string): Promise<void> {
    await this.request<unknown>(
      'DELETE',
      `/api/flows/${id}/test-listen?executionId=${encodeURIComponent(executionId)}`,
    );
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
