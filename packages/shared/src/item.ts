import { z } from 'zod';

/**
 * BinaryRef — reference to binary content flowing through the pipeline.
 * CTB never copies file bytes between nodes; it passes references:
 *  - tg_file_id : a Telegram file_id reusable in sendPhoto/sendDocument
 *  - stored     : a file persisted by the server (files table id)
 *  - url        : an external URL
 */
export const BinaryRefSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('tg_file_id'),
    fileId: z.string().min(1),
    mime: z.string().optional(),
    fileName: z.string().optional(),
    size: z.number().int().nonnegative().optional(),
  }),
  z.object({
    kind: z.literal('stored'),
    fileRecordId: z.string().min(1),
    mime: z.string().optional(),
    fileName: z.string().optional(),
    size: z.number().int().nonnegative().optional(),
  }),
  z.object({
    kind: z.literal('url'),
    url: z.url(),
    mime: z.string().optional(),
    fileName: z.string().optional(),
  }),
]);
export type BinaryRef = z.infer<typeof BinaryRefSchema>;

/**
 * FlowItem — the data envelope traveling on every edge (n8n mental model).
 * `json` is the payload; `binary` holds named binary references.
 */
export const FlowItemSchema = z.object({
  json: z.record(z.string(), z.unknown()),
  binary: z.record(z.string(), BinaryRefSchema).optional(),
});
export type FlowItem = z.infer<typeof FlowItemSchema>;

/** Convenience constructor used across engine & nodes. */
export function item(json: Record<string, unknown>, binary?: Record<string, BinaryRef>): FlowItem {
  return binary ? { json, binary } : { json };
}
