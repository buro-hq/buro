import type { RecordStore } from '../storage/record-store.ts';
import { objectArguments, textArgument } from '../tools/arguments.ts';
import { ToolFailure, type Tool, type ToolResult } from '../tools/tool.ts';

/** Full tool output kept outside the conversation when inline content would crowd the request. */
export interface ToolReceipt {
  id: string;
  sessionId: string;
  runId?: string;
  toolName?: string;
  content: string;
  exitCode?: number;
  createdAt: string;
}

/** Stores receipts independently of the diagnostic activity log and the transcript itself. */
export interface ReceiptStore extends RecordStore<ToolReceipt> {}

const maxInlineBytes = 16 * 1024;
const windowChars = 1024;
const maxRangeChars = 64 * 1024;
const defaultRangeChars = 4096;

/** Replaces oversized inline output with status, both ends and a range-readable reference. */
export const compactToolResult = (input: {
  id: string;
  sessionId: string;
  runId?: string;
  toolName?: string;
  result: ToolResult;
}): { content: string; receipt?: ToolReceipt } => {
  const { result } = input;
  if (Buffer.byteLength(result.content, 'utf8') <= maxInlineBytes)
    return { content: result.content };

  const receipt: ToolReceipt = {
    id: input.id,
    sessionId: input.sessionId,
    runId: input.runId,
    toolName: input.toolName,
    content: result.content,
    exitCode: result.exitCode,
    createdAt: new Date().toISOString(),
  };
  const content = JSON.stringify({
    receipt: input.id,
    bytes: Buffer.byteLength(result.content, 'utf8'),
    isError: result.isError,
    exitCode: result.exitCode,
    head: result.content.slice(0, windowChars),
    tail: result.content.slice(-windowChars),
    note: 'The complete output is saved outside this conversation. Read any character range with receipt_read using this receipt id, offset and limit.',
  });

  return { content, receipt };
};

/** Exposes saved full outputs as ordinary readable ranges, scoped to the caller's conversation. */
export const receiptTools = (input: { store: ReceiptStore }): Tool[] => [
  {
    effect: 'read',
    definition: {
      name: 'receipt_read',
      description:
        'Read a character range of a large tool output saved as a receipt. Use the receipt id from the compact result.',
      parameters: {
        type: 'object',
        properties: {
          receipt: { type: 'string' },
          offset: { type: 'integer', minimum: 0 },
          limit: { type: 'integer', minimum: 1, maximum: maxRangeChars },
        },
        required: ['receipt'],
        additionalProperties: false,
      },
    },
    async execute({ arguments: value, context }) {
      const args = objectArguments(value);
      const receiptId = textArgument({
        arguments: args,
        name: 'receipt',
      })!;
      const hasOffset = args.offset !== undefined;
      const invalidOffset = hasOffset && (!Number.isSafeInteger(args.offset) || Number(args.offset) < 0);
      if (invalidOffset)
        throw new ToolFailure('offset must be a nonnegative integer.');

      const hasLimit = args.limit !== undefined;
      const invalidLimit = hasLimit &&
        (!Number.isSafeInteger(args.limit) || Number(args.limit) < 1 || Number(args.limit) > maxRangeChars);
      if (invalidLimit)
        throw new ToolFailure(`limit must be an integer between 1 and ${maxRangeChars}.`);

      const receipt = await input.store.get(receiptId);
      const readable = receipt && receipt.sessionId === context.sessionId;
      if (!readable)
        return { content: 'No saved receipt with this id in this conversation.', isError: true };

      const offset = hasOffset ? Number(args.offset) : 0;
      const limit = hasLimit ? Number(args.limit) : defaultRangeChars;
      const range = receipt.content.slice(offset, offset + limit);

      return {
        content: JSON.stringify({
          receipt: receiptId,
          toolName: receipt.toolName,
          offset,
          length: range.length,
          total: receipt.content.length,
          exitCode: receipt.exitCode,
          content: range,
        }),
      };
    },
  },
];
