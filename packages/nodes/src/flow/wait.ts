/**
 * flow.wait — Wait / Delay (NODES.md §Flow control). Pauses the execution for
 * a fixed duration ("30s"…"7d") or until a datetime (usually an expression).
 *
 * DURABLE: returns WAIT with a `delay` WaitSpec — the execution row persists
 * `resumeAt`, survives server restarts, and the router's timeout scanner
 * resumes it through the `main` port once due (router.resumeTimedOut routes
 * delays to "main", not "timeout"). The node never re-executes on resume.
 *
 * mode=until accepts anything Date.parse understands; an unparseable value
 * fails the run loudly (silently never waking would be worse). A past
 * datetime simply resumes on the scanner's next pass.
 */
import {
  fail,
  FlowWaitParamsSchema,
  wait,
  type FlowWaitParams,
  type NodeDef,
} from '@ctb/shared';
import { deadlineFrom } from '../lib/duration';

export const flowWait: NodeDef<FlowWaitParams> = {
  type: 'flow.wait',
  category: 'flow',
  meta: { labelKey: 'nodes.flow.wait.label', descriptionKey: 'nodes.flow.wait.desc', icon: 'clock' },
  ports: { inputs: ['main'], outputs: ['main'] },
  paramsSchema: FlowWaitParamsSchema,
  async execute(ctx, params) {
    let resumeAt: string;
    if (params.mode === 'until') {
      const ts = Date.parse(params.until ?? '');
      if (Number.isNaN(ts)) {
        return fail(`flow.wait: invalid \`until\` datetime "${params.until}"`);
      }
      resumeAt = new Date(ts).toISOString();
    } else {
      resumeAt = deadlineFrom(ctx.now(), params.duration ?? '0s');
    }
    return wait({ kind: 'delay', nodeId: 'UNSET', resumeAt });
  },
};
