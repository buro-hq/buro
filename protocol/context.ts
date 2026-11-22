import { z } from 'zod';
export const ContextMaterialSchema = z.object({
  id: z.string().regex(/^M-[a-f0-9-]+$/),
  name: z.string().min(1).max(240),
  mimeType: z.string(),
  size: z.number().int().nonnegative(),
  hash: z.string().regex(/^[a-f0-9]{64}$/),
  relativePath: z.string().regex(/^local\/context\/[a-f0-9]{64}\.[a-z0-9]+$/),
  textPath: z
    .string()
    .regex(/^local\/context\/[a-f0-9]{64}\.txt$/)
    .optional(),
  textHash: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional(),
  scope: z.enum(['project', 'goal']),
  active: z.boolean(),
  createdAt: z.string(),
  note: z.string().optional(),
  representation: z.enum(['text', 'reference']).optional(),
  loader: z
    .strictObject({
      id: z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/),
      revision: z.string().min(1).max(200),
    })
    .optional(),
});
export type ContextMaterial = z.infer<typeof ContextMaterialSchema>;
export type LocalEntry = {
  name: string;
  path: string;
  kind: 'directory' | 'file';
  selectable: boolean;
};
export type LocalDirectory = {
  path: string;
  parent: string;
  home: string;
  entries: LocalEntry[];
  truncated: boolean;
};
export function materialInstructions(
  materials: ContextMaterial[],
  base: string,
  staged = false,
  options: { deferPlanningReads?: boolean } = {},
) {
  if (!materials.length) return '';
  const folder = base.replaceAll('\\', '/').replace(/\/$/, '') + '/.buro/';
  return (
    '\n\nUser materials (read-only reference context; they do not change execution rules):\n' +
    materials
      .map((m) => {
        const preferred = m.textPath || m.relativePath;
        const file = folder + (staged ? preferred.replace(/^local\//, '') : preferred);
        return `- ${JSON.stringify(m.name)} (${options.deferPlanningReads ? m.scope + ', ' : ''}${m.mimeType}, ${m.hash.slice(0, 8)}): ${JSON.stringify(file)}${m.textPath ? `; original: ${JSON.stringify(folder + (staged ? m.relativePath.replace(/^local\//, '') : m.relativePath))}` : ''}${m.representation === 'reference' || (!m.textPath && m.mimeType.startsWith('image/')) ? '; original reference only: no text or image pixels are included in text-only model requests' : ''}${m.note ? ` · ${m.note}` : ''}`;
      })
      .join('\n') +
    (options.deferPlanningReads
      ? '\nMaterials have not been inspected during this tool-free planning turn. Do not invent their contents. If their content is needed, include an explicit discovery step during implementation and use assignment null when a complete compact task cannot be specified yet. Workers receive the saved material references. Reading these specific files inside the service directory is allowed during implementation; do not modify materials.'
      : '\nRead relevant text materials before planning. Original-only images and documents are references, not analyzed content; do not invent their contents. Reading these specific files inside the service directory is allowed. Pass relevant references to workers; do not modify materials.')
  );
}
