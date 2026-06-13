/**
 * Starter template gallery (P3-T7) — a handful of ready-made flows the
 * operator can import with one click, then edit.
 *
 * INVARIANT I2 (domain-agnostic core): every template here is GENERIC. A
 * "feedback form" collects a rating and a comment — it knows nothing about
 * restaurants, courses, or support tickets. A "quiz" asks questions and
 * counts right answers — no subject baked in. Templates are illustrative
 * scaffolding, never vertical features.
 *
 * Each template is a FlowExport envelope (the SAME shape import accepts), so
 * "use template" and "import file" share one code path. They're authored
 * here as plain objects and validated against FlowExportSchema by the test
 * suite + the gallery endpoint, so a malformed template can never ship.
 *
 * Node id convention inside a template: short, readable, unique (NodeIdSchema
 * allows [A-Za-z0-9_-]{1,64}). Menu button branches use the "btn:<key>" port
 * (see menuOutputs); switch branches use the rule's port name.
 */
import type { FlowExport } from './flow-export';
import { FLOW_EXPORT_KIND, FLOW_EXPORT_VERSION } from './flow-export';

/** A gallery entry: a stable id/key + an i18n label/description key + the export. */
export interface FlowTemplate {
  /** Stable key used by the API + the editor (e.g. "feedback"). */
  id: string;
  /** i18n key for the human title (editor renders it; falls back to export.name). */
  labelKey: string;
  /** i18n key for the one-line description. */
  descriptionKey: string;
  /** The importable design. */
  export: FlowExport;
}

const env = (name: string, graph: FlowExport['graph']): FlowExport => ({
  kind: FLOW_EXPORT_KIND,
  version: FLOW_EXPORT_VERSION,
  name,
  graph,
  settings: { executionPolicy: 'replace', errorHandlerFlowId: null },
});

// ── feedback form ────────────────────────────────────────────────────────────
// /feedback → ask for a 1–5 rating (number, validated) → ask for a free-text
// comment → thank-you. Pure data collection; no domain field.
const feedback: FlowTemplate = {
  id: 'feedback',
  labelKey: 'templates.feedback.label',
  descriptionKey: 'templates.feedback.desc',
  export: env('Feedback form', {
    nodes: [
      { id: 'start', type: 'tg.trigger', params: { event: 'command', command: '/feedback' }, position: { x: 0, y: 0 }, disabled: false },
      {
        id: 'askRating',
        type: 'tg.waitForReply',
        params: {
          prompt: 'On a scale of 1 to 5, how would you rate your experience?',
          expect: 'number',
          validation: { min: 1, max: 5 },
          invalid_message: 'Please send a number from 1 to 5.',
          max_retries: 2,
          save_to: 'rating',
        },
        position: { x: 0, y: 140 },
        disabled: false,
      },
      {
        id: 'askComment',
        type: 'tg.waitForReply',
        params: { prompt: 'Thanks! Anything you’d like to add in a few words?', expect: 'text', save_to: 'comment' },
        position: { x: 0, y: 280 },
        disabled: false,
      },
      {
        id: 'thanks',
        type: 'tg.sendMessage',
        params: { type: 'text', text: 'Thank you for your feedback! 🙏' },
        position: { x: 0, y: 420 },
        disabled: false,
      },
    ],
    edges: [
      { id: 'e1', from: { node: 'start', port: 'main' }, to: { node: 'askRating', port: 'main' } },
      { id: 'e2', from: { node: 'askRating', port: 'reply' }, to: { node: 'askComment', port: 'main' } },
      { id: 'e3', from: { node: 'askComment', port: 'reply' }, to: { node: 'thanks', port: 'main' } },
    ],
  }),
};

// ── quiz ─────────────────────────────────────────────────────────────────────
// /quiz → one multiple-choice question via Menu → correct/wrong branches set a
// score and reply. Generic single-question scaffold the operator extends.
const quiz: FlowTemplate = {
  id: 'quiz',
  labelKey: 'templates.quiz.label',
  descriptionKey: 'templates.quiz.desc',
  export: env('Quiz', {
    nodes: [
      { id: 'start', type: 'tg.trigger', params: { event: 'command', command: '/quiz' }, position: { x: 0, y: 0 }, disabled: false },
      {
        id: 'q1',
        type: 'tg.menu',
        params: {
          text: 'Question 1: pick the correct answer.',
          buttons: [
            [
              { text: 'Option A', key: 'a' },
              { text: 'Option B', key: 'b' },
              { text: 'Option C', key: 'c' },
            ],
          ],
          answer_callback_text: 'Recorded ✓',
        },
        position: { x: 0, y: 140 },
        disabled: false,
      },
      {
        id: 'right',
        type: 'tg.sendMessage',
        params: { type: 'text', text: '✅ Correct!' },
        position: { x: -160, y: 300 },
        disabled: false,
      },
      {
        id: 'wrong',
        type: 'tg.sendMessage',
        params: { type: 'text', text: '❌ Not quite — the answer was A.' },
        position: { x: 160, y: 300 },
        disabled: false,
      },
    ],
    edges: [
      { id: 'e1', from: { node: 'start', port: 'main' }, to: { node: 'q1', port: 'main' } },
      { id: 'e2', from: { node: 'q1', port: 'btn:a' }, to: { node: 'right', port: 'main' } },
      { id: 'e3', from: { node: 'q1', port: 'btn:b' }, to: { node: 'wrong', port: 'main' } },
      { id: 'e4', from: { node: 'q1', port: 'btn:c' }, to: { node: 'wrong', port: 'main' } },
    ],
  }),
};

// ── FAQ menu ───────────────────────────────────────────────────────────────────
// /help → menu of topics → each button replies with an answer. Classic
// inline-keyboard navigation, no domain content baked in.
const faq: FlowTemplate = {
  id: 'faq',
  labelKey: 'templates.faq.label',
  descriptionKey: 'templates.faq.desc',
  export: env('FAQ menu', {
    nodes: [
      { id: 'start', type: 'tg.trigger', params: { event: 'command', command: '/help' }, position: { x: 0, y: 0 }, disabled: false },
      {
        id: 'menu',
        type: 'tg.menu',
        params: {
          text: 'What can I help you with?',
          buttons: [
            [
              { text: 'Topic 1', key: 'topic1' },
              { text: 'Topic 2', key: 'topic2' },
            ],
            [{ text: 'Topic 3', key: 'topic3' }],
          ],
        },
        position: { x: 0, y: 140 },
        disabled: false,
      },
      { id: 'a1', type: 'tg.sendMessage', params: { type: 'text', text: 'Here’s the answer to topic 1.' }, position: { x: -200, y: 300 }, disabled: false },
      { id: 'a2', type: 'tg.sendMessage', params: { type: 'text', text: 'Here’s the answer to topic 2.' }, position: { x: 0, y: 300 }, disabled: false },
      { id: 'a3', type: 'tg.sendMessage', params: { type: 'text', text: 'Here’s the answer to topic 3.' }, position: { x: 200, y: 300 }, disabled: false },
    ],
    edges: [
      { id: 'e1', from: { node: 'start', port: 'main' }, to: { node: 'menu', port: 'main' } },
      { id: 'e2', from: { node: 'menu', port: 'btn:topic1' }, to: { node: 'a1', port: 'main' } },
      { id: 'e3', from: { node: 'menu', port: 'btn:topic2' }, to: { node: 'a2', port: 'main' } },
      { id: 'e4', from: { node: 'menu', port: 'btn:topic3' }, to: { node: 'a3', port: 'main' } },
    ],
  }),
};

// ── reminder ─────────────────────────────────────────────────────────────────
// /remind → confirm → durable Wait → send the reminder. Shows the persistent
// delay node; the delay is generic (1 hour) and operator-editable.
const reminder: FlowTemplate = {
  id: 'reminder',
  labelKey: 'templates.reminder.label',
  descriptionKey: 'templates.reminder.desc',
  export: env('Reminder', {
    nodes: [
      { id: 'start', type: 'tg.trigger', params: { event: 'command', command: '/remind' }, position: { x: 0, y: 0 }, disabled: false },
      { id: 'ack', type: 'tg.sendMessage', params: { type: 'text', text: 'Got it — I’ll remind you in 1 hour. ⏰' }, position: { x: 0, y: 140 }, disabled: false },
      { id: 'wait', type: 'flow.wait', params: { mode: 'duration', duration: '1h' }, position: { x: 0, y: 280 }, disabled: false },
      { id: 'remind', type: 'tg.sendMessage', params: { type: 'text', text: '🔔 Here’s your reminder!' }, position: { x: 0, y: 420 }, disabled: false },
    ],
    edges: [
      { id: 'e1', from: { node: 'start', port: 'main' }, to: { node: 'ack', port: 'main' } },
      { id: 'e2', from: { node: 'ack', port: 'main' }, to: { node: 'wait', port: 'main' } },
      { id: 'e3', from: { node: 'wait', port: 'main' }, to: { node: 'remind', port: 'main' } },
    ],
  }),
};

/** The gallery, in display order. All GENERIC (I2). */
export const FLOW_TEMPLATES: readonly FlowTemplate[] = [feedback, quiz, faq, reminder];

/** Look up a template by its stable id. */
export function findFlowTemplate(id: string): FlowTemplate | undefined {
  return FLOW_TEMPLATES.find((t) => t.id === id);
}

/** Serializable gallery row for the API (no nested export graph in the list). */
export interface FlowTemplateInfo {
  id: string;
  labelKey: string;
  descriptionKey: string;
  name: string;
  nodeCount: number;
}

export function flowTemplateInfo(t: FlowTemplate): FlowTemplateInfo {
  return {
    id: t.id,
    labelKey: t.labelKey,
    descriptionKey: t.descriptionKey,
    name: t.export.name,
    nodeCount: t.export.graph.nodes.length,
  };
}
