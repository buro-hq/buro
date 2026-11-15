import { z } from 'zod';
export const RelativePathSchema = z
  .string()
  .min(1)
  .max(500)
  .refine(
    (p) =>
      !p.startsWith('/') &&
      !p.includes('\\') &&
      !p.split('/').includes('..') &&
      !/[\x00-\x1f]/.test(p),
    'A relative path inside the repository is required.',
  );
