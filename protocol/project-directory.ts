/** Shared storage contract; the legacy spelling is only used during migration. */
export const PROJECT_DIRECTORY = '.buro';
export const LEGACY_PROJECT_DIRECTORY = '.\u043f\u0440\u043e\u0435\u043a\u0442';
const pathFields = new Set([
  'root',
  'directory',
  'dataDirectory',
  'workspace',
  'script',
  'command',
  'path',
  'paths',
  'plannedPaths',
  'protectedPaths',
  'relativePath',
  'textPath',
]);
const escapedLegacy = LEGACY_PROJECT_DIRECTORY.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const legacySegment = new RegExp(`(^|[\\\\/\\s"'=])${escapedLegacy}(?=$|[\\\\/])`, 'g');
/** Relocate operational paths while preserving user content and recorded commands. */
export function migrateMetadataPaths(
  value: unknown,
  field = '',
  ancestors: string[] = [],
): unknown {
  if (typeof value === 'string')
    return pathFields.has(field) && !(field === 'command' && ancestors.includes('commands'))
      ? value.replace(legacySegment, `$1${PROJECT_DIRECTORY}`)
      : value;
  if (Array.isArray(value))
    return value.map((item) => migrateMetadataPaths(item, field, ancestors));
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        migrateMetadataPaths(item, key, [...ancestors, key]),
      ]),
    );
  return value;
}
