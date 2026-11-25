import type { RecordQuery, StoredRecord } from './record-store.ts';

/** Evaluates the reference adapter's selection with the same semantics as SQLite. */
export const selectRecords = <T extends StoredRecord>(input: {
  records: T[];
  query?: RecordQuery<T>;
}): T[] => {
  const { records, query = {} } = input;
  const { where = {}, orderBy, descending, before, after, limit, offset = 0 } = query;
  const selected = records.filter((record) => {
    const matches = Object.entries(where).every(
      ([key, value]) => value === undefined || record[key as keyof T] === value,
    );

    if (!matches) return false;

    if (orderBy && before !== undefined && Number(record[orderBy]) >= before) return false;

    if (orderBy && after !== undefined && Number(record[orderBy]) <= after) return false;

    return true;
  });

  if (orderBy)
    selected.sort((left, right) => {
      const a = left[orderBy] as string | number;
      const b = right[orderBy] as string | number;
      const comparison = a < b ? -1 : a > b ? 1 : 0;

      return descending ? -comparison : comparison;
    });
  else if (descending) selected.reverse();

  return selected.slice(offset, limit === undefined ? undefined : offset + limit);
};
