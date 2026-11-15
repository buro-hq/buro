import { createHash } from 'node:crypto';
export function fingerprint(input: unknown) {
  const canonical = (value: any): any =>
    Array.isArray(value)
      ? value.map(canonical)
      : value && typeof value === 'object'
        ? Object.fromEntries(
            Object.keys(value)
              .sort()
              .map((k) => [k, canonical(value[k])]),
          )
        : value;
  return createHash('sha256')
    .update(JSON.stringify(canonical(input)))
    .digest('hex');
}
