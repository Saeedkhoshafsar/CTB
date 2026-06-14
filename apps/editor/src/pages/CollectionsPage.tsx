/**
 * Collections page (Data section, P3.5-T3) — per-bot list of collection
 * definitions + the schema builder for create/edit. Admin-only (the route lives
 * behind the same auth gate; the server's role guard blocks operators from
 * /api/collections regardless).
 *
 * GENERIC (invariant I2): this page never names a domain. The demo `products` /
 * `shipping_methods` / `orders` collections are created here entirely in the UI,
 * and the resulting schema JSON is exactly what validates against CollectionSchema.
 */
import type {
  CollectionPackInfo,
  CollectionPublic,
  CreateCollectionBody,
  UpdateCollectionBody,
} from '@ctb/shared';
import { labelText } from '@ctb/shared';
import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api } from '../api/client';
import { useI18n, type MessageKey } from '../i18n';
import { useCollections } from '../stores/collections';
import { RecordsPanel } from './collections/RecordsPanel';
import { SchemaBuilder } from './collections/SchemaBuilder';

type Mode =
  | { kind: 'list' }
  | { kind: 'new' }
  | { kind: 'gallery' }
  | { kind: 'edit'; collection: CollectionPublic }
  | { kind: 'records'; collection: CollectionPublic };

export function CollectionsPage() {
  const t = useI18n((s) => s.t);
  const { botId = '' } = useParams<{ botId: string }>();
  const { collections, loading, error, load, createCollection, updateCollection, deleteCollection, recordCount } =
    useCollections();
  const [botName, setBotName] = useState('');
  const [mode, setMode] = useState<Mode>({ kind: 'list' });
  const [packs, setPacks] = useState<CollectionPackInfo[]>([]);
  const [importing, setImporting] = useState<string | null>(null);
  const [packMsg, setPackMsg] = useState<string | null>(null);

  useEffect(() => {
    void load(botId);
    api
      .getBot(botId)
      .then((b) => setBotName(b.name))
      .catch(() => setBotName(botId));
  }, [botId, load]);

  const openGallery = async () => {
    setPackMsg(null);
    setMode({ kind: 'gallery' });
    try {
      setPacks(await api.listCollectionPacks());
    } catch (err) {
      setPackMsg(err instanceof Error ? err.message : String(err));
    }
  };

  const importPack = async (packId: string) => {
    setImporting(packId);
    setPackMsg(null);
    try {
      const res = await api.importCollectionPack(botId, packId);
      await load(botId);
      setPackMsg(
        t('packs.imported', {
          created: res.collections.length,
          skipped: res.skippedCollections.length,
          flows: res.flows.length,
        }),
      );
      setMode({ kind: 'list' });
    } catch (err) {
      setPackMsg(err instanceof Error ? err.message : String(err));
    } finally {
      setImporting(null);
    }
  };

  const relationTargets = collections
    .map((c) => c.slug)
    .filter((s) => mode.kind !== 'edit' || s !== mode.collection.slug);

  // The records panel takes over the whole page (no collections chrome).
  if (mode.kind === 'records') {
    return (
      <div className="page">
        <RecordsPanel
          collection={mode.collection}
          collections={collections}
          onBack={() => setMode({ kind: 'list' })}
          t={t}
        />
      </div>
    );
  }

  const handleSave = async (body: CreateCollectionBody, kind: 'create' | 'update') => {
    if (kind === 'create') {
      await createCollection(botId, body);
    } else if (mode.kind === 'edit') {
      const patch: UpdateCollectionBody = {
        name: body.name,
        ...(body.icon !== undefined ? { icon: body.icon } : {}),
        schema: body.schema,
        ...(body.display ? { display: body.display } : {}),
      };
      await updateCollection(mode.collection.id, patch);
    }
    setMode({ kind: 'list' });
  };

  return (
    <div className="page">
      <div className="page-head">
        <h1>
          {t('collections.title')}
          {botName && <span className="sub" style={{ marginInlineStart: '0.5rem' }}>— {botName}</span>}
        </h1>
        <div style={{ display: 'flex', gap: '0.5rem' }}>
          {mode.kind === 'list' && (
            <>
              <button className="primary" onClick={() => setMode({ kind: 'new' })}>
                {t('collections.new')}
              </button>
              <button onClick={() => void openGallery()}>{t('packs.use')}</button>
            </>
          )}
          <Link className="btn ghost" to="/bots">
            {t('collections.back')}
          </Link>
        </div>
      </div>

      {error && <div className="alert">{error}</div>}
      {packMsg && <div className="alert info">{packMsg}</div>}

      {mode.kind === 'gallery' && (
        <div className="pack-gallery">
          <div className="page-head">
            <h2>{t('packs.title')}</h2>
            <button className="btn ghost" onClick={() => setMode({ kind: 'list' })}>
              {t('collections.back')}
            </button>
          </div>
          <p className="sub">{t('packs.intro')}</p>
          {packs.length === 0 ? (
            <div className="empty">{t('app.loading')}</div>
          ) : (
            <div className="row-list">
              {packs.map((p) => (
                <div className="row" key={p.id}>
                  <div className="grow">
                    <div className="title">{t(p.labelKey as MessageKey)}</div>
                    <div className="sub">{t(p.descriptionKey as MessageKey)}</div>
                    <div className="badges" style={{ marginTop: '0.25rem' }}>
                      {p.collectionSlugs.map((s) => (
                        <span className="badge" key={s} dir="ltr">
                          {s}
                        </span>
                      ))}
                      {p.flowNames.map((n) => (
                        <span className="badge ghost" key={n}>
                          {n}
                        </span>
                      ))}
                    </div>
                  </div>
                  <button
                    className="primary"
                    disabled={importing !== null}
                    onClick={() => void importPack(p.id)}
                  >
                    {importing === p.id ? t('packs.importing') : t('packs.import')}
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {mode.kind === 'new' && (
        <SchemaBuilder
          relationTargets={relationTargets}
          onSave={handleSave}
          onCancel={() => setMode({ kind: 'list' })}
          t={t}
        />
      )}

      {mode.kind === 'edit' && (
        <SchemaBuilder
          existing={mode.collection}
          relationTargets={relationTargets}
          recordCount={() => recordCount(mode.collection.id)}
          onSave={handleSave}
          onCancel={() => setMode({ kind: 'list' })}
          t={t}
        />
      )}

      {mode.kind === 'list' &&
        (loading ? (
          <div className="splash">{t('app.loading')}</div>
        ) : collections.length === 0 ? (
          <div className="empty">{t('collections.empty')}</div>
        ) : (
          <div className="row-list">
            {collections.map((c) => (
              <div className="row" key={c.id}>
                <div className="grow">
                  <div className="title">
                    {c.icon && <span style={{ marginInlineEnd: '0.4rem' }}>{c.icon}</span>}
                    {c.name}
                  </div>
                  <div className="sub" dir="ltr">
                    {c.slug} · {t('collections.fieldCount', { n: c.schema.fields.length })}
                  </div>
                  <div className="badges" style={{ marginTop: '0.25rem' }}>
                    {c.schema.fields.map((f) => (
                      <span className="badge" key={f.key} title={f.type}>
                        {labelText(f.label, f.key)}
                      </span>
                    ))}
                  </div>
                </div>
                <button className="primary" onClick={() => setMode({ kind: 'records', collection: c })}>
                  {t('collections.action.records')}
                </button>
                <button onClick={() => setMode({ kind: 'edit', collection: c })}>
                  {t('collections.action.edit')}
                </button>
                <button
                  className="danger"
                  onClick={() => {
                    if (window.confirm(t('collections.delete.confirm', { name: c.name }))) {
                      void deleteCollection(c.id);
                    }
                  }}
                >
                  {t('collections.action.delete')}
                </button>
              </div>
            ))}
          </div>
        ))}
    </div>
  );
}
