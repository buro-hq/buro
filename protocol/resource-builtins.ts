import { z } from 'zod';
import { endpointIsPrivate, modelEndpointURL } from './endpoint-trust.ts';
import { ResourceIdSchema, type ResourceConnection, type RuntimeDefinition } from './resources.ts';

const modelEndpoint = z
  .string()
  .min(1)
  .max(1000)
  .refine((value) => {
    try {
      modelEndpointURL(value);
      return true;
    } catch {
      return false;
    }
  }, 'Use an HTTP(S) endpoint without credentials, query or fragment.');

export const OllamaConnectionConfigSchema = z
  .strictObject({
    endpoint: modelEndpoint.default('http://127.0.0.1:11434'),
    capacity: z.number().int().min(1).max(8).default(1),
    trust: z.enum(['auto', 'private-network', 'external']).default('auto'),
    think: z.union([z.boolean(), z.string().max(40)]).optional(),
  })
  .superRefine((config, ctx) => {
    if (config.trust !== 'private-network') return;
    try {
      if (endpointIsPrivate(modelEndpointURL(config.endpoint))) return;
    } catch {
      return;
    }
    ctx.addIssue({
      code: 'custom',
      path: ['trust'],
      message: 'Private network trust requires a literal private or loopback IP address.',
    });
  });
export const DeepSeekConnectionConfigSchema = z
  .strictObject({
    endpoint: modelEndpoint.default('https://api.deepseek.com'),
    capacity: z.number().int().min(1).max(8).default(2),
    apiKeyEnv: z
      .string()
      .regex(/^[A-Z][A-Z0-9_]{0,99}$/)
      .default('DEEPSEEK_API_KEY'),
    thinking: z.enum(['enabled', 'disabled']).default('disabled'),
  })
  .superRefine((config, ctx) => {
    try {
      const endpoint = modelEndpointURL(config.endpoint);
      if (
        endpoint.protocol !== 'https:' &&
        !['localhost', '127.0.0.1', '[::1]'].includes(endpoint.hostname)
      )
        ctx.addIssue({
          code: 'custom',
          path: ['endpoint'],
          message: 'Remote DeepSeek endpoints require HTTPS.',
        });
    } catch {
      /* The endpoint field reports malformed URLs. */
    }
  });
export const ManagedLimitsSchema = z
  .strictObject({
    contextTokens: z.number().int().min(1024).max(262144).default(32768),
    maxOutputTokens: z.number().int().min(128).max(32768).default(4096),
    maxRequestsPerTurn: z.number().int().min(1).max(64).default(24),
    maxToolCallsPerTurn: z.number().int().min(1).max(128).default(64),
    maxSessionRequests: z.number().int().min(1).max(1024).default(256),
  })
  .refine((limits) => limits.maxOutputTokens < limits.contextTokens, 'Reserve input context.');
export const ManagedRuntimeConfigSchema = z.strictObject({
  connectionId: ResourceIdSchema,
  model: z.string().min(1).max(200),
  limits: ManagedLimitsSchema.default(() => ManagedLimitsSchema.parse({})),
});
export const NativeRuntimeConfigSchema = z.strictObject({
  model: z
    .string()
    .trim()
    .min(1)
    .max(200)
    .refine((value) => !/[\0\r\n]/.test(value), 'Use a single model identifier.')
    .optional(),
  reasoningEffort: z.enum(['low', 'medium', 'high', 'xhigh']).optional(),
});
export type OllamaConnectionConfig = z.infer<typeof OllamaConnectionConfigSchema>;
export type DeepSeekConnectionConfig = z.infer<typeof DeepSeekConnectionConfigSchema>;
export type ManagedRuntimeConfig = z.infer<typeof ManagedRuntimeConfigSchema>;
export type NativeRuntimeConfig = z.infer<typeof NativeRuntimeConfigSchema>;

const assertType = (actual: string, expected: string) => {
  if (actual !== expected) throw new Error('This configuration uses a different contribution.');
};
export function parseOllamaConnection(connection: ResourceConnection) {
  assertType(connection.provider, 'ollama');
  return OllamaConnectionConfigSchema.parse(connection.config);
}
export function parseDeepSeekConnection(connection: ResourceConnection) {
  assertType(connection.provider, 'deepseek');
  return DeepSeekConnectionConfigSchema.parse(connection.config);
}
export function parseManagedRuntime(runtime: RuntimeDefinition) {
  assertType(runtime.backend, 'managed');
  return ManagedRuntimeConfigSchema.parse(runtime.config);
}
export function parseNativeRuntime(runtime: RuntimeDefinition) {
  assertType(runtime.backend, 'codex');
  return NativeRuntimeConfigSchema.parse(runtime.config);
}
