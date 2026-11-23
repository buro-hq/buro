import { z } from 'zod';
export const repositoryToolSchemas = {
  read_file: z.strictObject({
    path: z.string().min(1).max(1000),
    startLine: z.number().int().min(1).optional(),
    startColumn: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
    lineCount: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
    maxChars: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
  }),
  list_files: z.strictObject({ path: z.string().max(1000).optional() }),
  search_text: z.strictObject({
    query: z.string().min(1).max(200),
    path: z.string().max(1000).optional(),
  }),
  edit_file: z.strictObject({
    path: z.string().min(1).max(1000),
    oldText: z.string().max(64000),
    newText: z.string().max(64000),
  }),
  run_command: z.strictObject({
    command: z.string().min(1).max(4000),
    timeoutMs: z.number().int().positive().max(2147483647).optional(),
  }),
  read_diff: z.strictObject({}),
};
