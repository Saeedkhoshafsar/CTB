/**
 * Records panel (P3.5-T4) — the auto-generated CRUD list view for one
 * collection: server-side-paginated table, a free-text search box, a filter
 * builder, sortable columns (driven by display hints), and the record form for
 * create/edit. This is the operator's whole world (ARCHITECTURE §13.5) — zero
 * canvas exposure, all writes validated server-side via the shared schema (I5).
 *
 * GENERIC (invariant I2): renders entirely from the collection's `CollectionField`
 * shapes; no domain ("product"/"order") is named anywhere.
 */
import type { CollectionPublic } from '@ctb/shared';
import { labelText } from '@ctb/shared';
import { useEffect, useMemo, useState } from 'react';
import type { Translate } from '../../i18n';
import { useRecords } from '../../stores/records';
import { RecordForm } from './RecordForm';
import {
  type FilterDraft,
  buildFilter,
  cellText,
  filterableFields,
  listColumns,
  nextSort,
  searchableFields,
} from './record-model';

const PAGE_SIZE = 25;

interface Props {
  collection: CollectionPublic;
  collections: CollectionPublic[];
  onBack: () => void;
  t: Translate;
}

type Editing = { kind: 'closed' } | { kind: 'new' } | { kind: 'edit'; id: string };

export function RecordsPanel({ collection, collections, onBack, t }: Props) {
  const { records, total, loading, error, query, deleteRecord } = useRecords();
  const [search, setSearch] = useState('');
  const [filters, setFilters] = useState<FilterDraft[]>([]);
  const [sort, setSort] = useState<{ field: string; dir: 'asc' | 'desc' } | null>(
    collection.display.defaultSort ?? null,
  );
  const [page, setPage] = useState(0);
  const [editing, setEditing] = useState<Editing>({ kind: 'closed' });

  const columns = useMemo(() => listColumns(collection), [collection]);
  const filterable = useMemo(() => filterableFields(collection.schema), [collection]);
  const searchable = useMemo(() => searchableFields(collection.schema), [collection]);

  const runQuery = useMemo(
    () => () =>
      void query(
        collection.id,
        buildFilter({
          schema: collection.schema,
          search,
          filters,
          sort,
          limit: PAGE_SIZE,
          offset: page * PAGE_SIZE,
        }),
      ),
    [collection.id, collection.schema, search, filters, sort, page, query],
  );

  // Refetch whenever the query inputs change.
  useEffect(() => {
    runQuery();
  }, [runQuery]);

  const editRecord = editing.kind === 'edit' ? records.find((r) => r.id === editing.id) : undefined;

  const toggleSort = (field: string) => {
    setSort((cur) => nextSort(cur, field));
    setPage(0);
  };

  const handleSaved = () => {
    setEditing({ kind: 'closed' });
    runQuery();
  };

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  if (editing.kind === 'new' || editing.kind === 'edit') {
    return (
      <RecordForm
        collection={collection}
        collections={collections}
        existing={editRecord}
        onSaved={handleSaved}
        onCancel={() => setEditing({ kind: 'closed' })}
        t={t}
      />
    );
  }

  return (
    <div className="records-panel" data-testid="records-panel">
      <div className="page-head">
        <h2>
          {collection.icon && <span style={{ marginInlineEnd: '0.4rem' }}>{collection.icon}</span>}
          {collection.name}
          <span className="sub" style={{ marginInlineStart: '0.5rem' }}>
            {t('records.count', { n: total })}
          </span>
        </h2>
        <div style={{ display: 'flex', gap: '0.5rem' }}>
          <button className="primary" onClick={() => setEditing({ kind: 'new' })}>
            {t('records.new')}
          </button>
          <button className="ghost" onClick={onBack}>
            {t('records.back')}
          </button>
        </div>
      </div>

      <div className="records-toolbar">
        {searchable.length > 0 && (
          <input
            type="search"
            className="records-search"
            placeholder={t('records.search.placeholder')}
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              setPage(0);
            }}
          />
        )}
        <button
          className="ghost"
          onClick={() => setFilters((f) => [...f, { field: filterable[0]?.key ?? '', op: 'eq', value: '' }])}
          disabled={filterable.length === 0}
        >
          {t('records.filter.add')}
        </button>
      </div>

      {filters.length > 0 && (
        <div className="filter-rows">
          {filters.map((row, i) => (
            <div className="filter-row" key={i}>
              <select
                value={row.field}
                onChange={(e) => updateFilter(setFilters, setPage, i, { field: e.target.value })}
              >
                {filterable.map((f) => (
                  <option key={f.key} value={f.key}>
                    {labelText(f.label, f.key)}
                  </option>
                ))}
              </select>
              <select
                value={row.op}
                onChange={(e) =>
                  updateFilter(setFilters, setPage, i, { op: e.target.value as FilterDraft['op'] })
                }
              >
                {(['eq', 'ne', 'contains', 'gt', 'gte', 'lt', 'lte', 'in', 'exists'] as const).map((op) => (
                  <option key={op} value={op}>
                    {t(`records.op.${op}` as Parameters<Translate>[0])}
                  </option>
                ))}
              </select>
              {row.op !== 'exists' && (
                <input
                  type="text"
                  value={row.value}
                  placeholder={row.op === 'in' ? 'a, b, c' : ''}
                  onChange={(e) => updateFilter(setFilters, setPage, i, { value: e.target.value })}
                />
              )}
              <button
                className="ghost danger"
                onClick={() => {
                  setFilters((f) => f.filter((_, idx) => idx !== i));
                  setPage(0);
                }}
              >
                ×
              </button>
            </div>
          ))}
        </div>
      )}

      {error && (
        <div className="alert" role="alert">
          {error}
        </div>
      )}

      {loading ? (
        <div className="splash">{t('app.loading')}</div>
      ) : records.length === 0 ? (
        <div className="empty">{t('records.empty')}</div>
      ) : (
        <table className="records-table">
          <thead>
            <tr>
              {columns.map((c) => (
                <th key={c.key}>
                  <button className="ghost sort-header" onClick={() => toggleSort(c.key)}>
                    {labelText(c.label, c.key)}
                    {sort?.field === c.key && <span>{sort.dir === 'asc' ? ' ▲' : ' ▼'}</span>}
                  </button>
                </th>
              ))}
              <th className="actions-col">{t('records.col.actions')}</th>
            </tr>
          </thead>
          <tbody>
            {records.map((rec) => (
              <tr key={rec.id} data-record-id={rec.id}>
                {columns.map((c) => (
                  <td key={c.key} title={c.key}>
                    {cellText(c, rec.data[c.key])}
                  </td>
                ))}
                <td className="actions-col">
                  <button onClick={() => setEditing({ kind: 'edit', id: rec.id })}>
                    {t('records.action.edit')}
                  </button>
                  <button
                    className="danger"
                    onClick={() => {
                      if (window.confirm(t('records.delete.confirm'))) {
                        void deleteRecord(collection.id, rec.id);
                      }
                    }}
                  >
                    {t('records.action.delete')}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {totalPages > 1 && (
        <div className="pager">
          <button className="ghost" disabled={page === 0} onClick={() => setPage((p) => p - 1)}>
            {t('records.pager.prev')}
          </button>
          <span className="sub">{t('records.pager.page', { page: page + 1, total: totalPages })}</span>
          <button
            className="ghost"
            disabled={page + 1 >= totalPages}
            onClick={() => setPage((p) => p + 1)}
          >
            {t('records.pager.next')}
          </button>
        </div>
      )}
    </div>
  );
}

/** Patch one filter row in place + reset to the first page. */
function updateFilter(
  setFilters: React.Dispatch<React.SetStateAction<FilterDraft[]>>,
  setPage: React.Dispatch<React.SetStateAction<number>>,
  index: number,
  patch: Partial<FilterDraft>,
): void {
  setFilters((f) => f.map((row, idx) => (idx === index ? { ...row, ...patch } : row)));
  setPage(0);
}
