import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { TraceIdSchema } from '@trace-ops/contracts';
import { z } from 'zod';

const MAX_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
const environment = z.enum(['dev', 'staging', 'prod']);
const timestamp = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/)
  .refine(value => {
    const parsed = new Date(value);
    return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value.replace(/(?<!\.\d{3})Z$/, '.000Z');
  });
const positiveInteger = (fallback: number, maximum: number) => z.string().regex(/^[1-9]\d{0,5}$/)
  .transform(Number).refine(value => value <= maximum).default(String(fallback));
const listSchema = z.object({
  projectId: z.string().uuid().transform(value => value.toLowerCase()),
  environment: z.enum(['dev', 'staging', 'prod', 'all']).default('all'),
  from: timestamp,
  to: timestamp,
  traceId: TraceIdSchema.optional(),
  service: z.string().min(1).max(120).optional(),
  status: z.enum(['ok', 'error']).optional(),
  page: positiveInteger(1, 1000),
  pageSize: positiveInteger(20, 100),
}).strict();
const detailSchema = z.object({
  projectId: z.string().uuid().transform(value => value.toLowerCase()),
  environment,
  from: timestamp.optional(),
  to: timestamp.optional(),
  includeContent: z.enum(['false', 'true']).optional(),
}).strict();

function window(fromMs: number, toMs: number): void {
  if (fromMs >= toMs || toMs - fromMs > MAX_WINDOW_MS) throw new BadRequestException('Invalid trace query');
}

export function parseTraceListQuery(raw: unknown) {
  const parsed = listSchema.safeParse(raw);
  if (!parsed.success) throw new BadRequestException('Invalid trace query');
  const { from, to, ...query } = parsed.data;
  const fromMs = Date.parse(from), toMs = Date.parse(to);
  window(fromMs, toMs);
  if ((query.page - 1) * query.pageSize > 10000) throw new BadRequestException('Invalid trace query');
  return { ...query, fromMs, toMs };
}

export function parseTraceDetailQuery(traceId: unknown, raw: unknown) {
  const id = TraceIdSchema.safeParse(traceId), parsed = detailSchema.safeParse(raw);
  if (!id.success || !parsed.success) throw new BadRequestException('Invalid trace query');
  const { from, to, includeContent, ...query } = parsed.data;
  if (includeContent === 'true') throw new ForbiddenException('Trace content access is unavailable');
  if ((from === undefined) !== (to === undefined)) throw new BadRequestException('Invalid trace query');
  const toMs = to === undefined ? Date.now() : Date.parse(to);
  const fromMs = from === undefined ? toMs - MAX_WINDOW_MS : Date.parse(from);
  window(fromMs, toMs);
  return { ...query, traceId: id.data, fromMs, toMs, includeContent: false as const };
}

export type TraceListQuery = ReturnType<typeof parseTraceListQuery>;
export type TraceDetailQuery = ReturnType<typeof parseTraceDetailQuery>;
