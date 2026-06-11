/**
 * http.request — HTTP Request (NODES.md §Data & code). Calls ctx.http.request
 * (the HOST-LIMITED capability — timeout cap + response size cap live in the
 * server wiring, invariant I6) once PER ITEM, n8n-style.
 *
 * Response → `$json`: auto-parsed JSON object spreads into the item; a JSON
 * array becomes `{ data: [...] }`; non-JSON text becomes `{ body: "…" }`.
 * `statusCode` and `headers` always ride along.
 *
 * never_error=true: non-2xx responses flow out of `main` with their
 * statusCode instead of failing the execution. Transport errors (DNS, abort)
 * still fail — there is no response to inspect.
 *
 * Credential selector arrives in P3-T4; until then auth rides plain header rows.
 */
import {
  fail,
  HttpRequestParamsSchema,
  out,
  type FlowItem,
  type HttpRequestParams,
  type NodeDef,
} from '@ctb/shared';
import { parseDuration } from '../lib/duration';

export const httpRequest: NodeDef<HttpRequestParams> = {
  type: 'http.request',
  category: 'data',
  meta: { labelKey: 'nodes.http.request.label', descriptionKey: 'nodes.http.request.desc', icon: 'globe' },
  ports: { inputs: ['main'], outputs: ['main'] },
  paramsSchema: HttpRequestParamsSchema,
  async execute(ctx, params, items) {
    const input: FlowItem[] = items.length > 0 ? items : [{ json: {} }];
    const output: FlowItem[] = [];

    const url = buildUrl(params);
    if (url instanceof Error) return fail(`http.request: ${url.message}`);
    const headers: Record<string, string> = {};
    for (const row of params.headers ?? []) headers[row.name] = row.value;

    let body: string | undefined;
    if (params.body_type === 'json' || params.body_type === 'raw') {
      body = params.body ?? '';
      if (params.body_type === 'json' && !('content-type' in lowerKeys(headers))) {
        headers['content-type'] = 'application/json';
      }
    } else if (params.body_type === 'form') {
      const form = new URLSearchParams();
      for (const row of params.form ?? []) form.append(row.name, row.value);
      body = form.toString();
      if (!('content-type' in lowerKeys(headers))) {
        headers['content-type'] = 'application/x-www-form-urlencoded';
      }
    }

    for (const _item of input) {
      let res: { status: number; headers: Record<string, string>; body: unknown };
      try {
        res = await ctx.http.request({
          method: params.method,
          url,
          ...(Object.keys(headers).length > 0 ? { headers } : {}),
          ...(body !== undefined ? { body } : {}),
          ...(params.timeout ? { timeoutMs: parseDuration(params.timeout) } : {}),
        });
      } catch (err) {
        // transport failure — no response to inspect, never_error cannot apply
        return fail(`http.request failed: ${err instanceof Error ? err.message : err}`);
      }

      if (!params.never_error && (res.status < 200 || res.status >= 300)) {
        return fail(`http.request: ${params.method} ${url} → HTTP ${res.status}`);
      }
      output.push({ json: responseJson(res) });
    }
    return out({ main: output });
  },
};

/** url + query rows → final URL (rows append to any existing query string). */
function buildUrl(params: HttpRequestParams): string | Error {
  try {
    const u = new URL(params.url);
    for (const row of params.query ?? []) u.searchParams.append(row.name, row.value);
    return u.toString();
  } catch {
    return new Error(`invalid url "${params.url}"`);
  }
}

/** Response → item json per NODES.md (auto-parse JSON; statusCode/headers ride along). */
function responseJson(res: {
  status: number;
  headers: Record<string, string>;
  body: unknown;
}): Record<string, unknown> {
  const base: Record<string, unknown> = { statusCode: res.status, headers: res.headers };
  if (res.body !== null && typeof res.body === 'object' && !Array.isArray(res.body)) {
    return { ...(res.body as Record<string, unknown>), ...base };
  }
  if (Array.isArray(res.body)) return { data: res.body, ...base };
  return { body: res.body, ...base };
}

function lowerKeys(o: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(o)) out[k.toLowerCase()] = v;
  return out;
}
