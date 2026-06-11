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
  type CreateFlowBody,
  CreateFlowBodySchema,
  type FlowPublic,
  type LoginBody,
  LoginBodySchema,
  type SessionUser,
  type UpdateBotBody,
  UpdateBotBodySchema,
  type UpdateFlowBody,
  UpdateFlowBodySchema,
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
}

/** App-wide singleton — pages import this; tests build their own with a fake fetch. */
export const api = new ApiClient();
