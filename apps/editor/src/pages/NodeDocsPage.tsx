/**
 * Node library docs site (PD-T4) — a browsable, bilingual (fa/en) reference of
 * every node in the registry, auto-generated from the node CATALOG
 * (GET /api/node-types). No node is hardcoded: the page lists whatever the
 * registry advertises (I5), with each node's params, ports, typed-connection
 * facts, and fa/en label/description resolved from the i18n keys in `meta`.
 *
 * "The work is already done, just connect them" — made browsable. An operator
 * (or an external agent's human) can scan the catalog, read each brick's
 * params and ports, and copy the `type` string straight into a v1/MCP call.
 *
 * The transform is pure (node-docs/model.ts); this file is the thin view.
 */
import type { NodeTypeInfo } from '@ctb/shared';
import { useEffect, useMemo, useState } from 'react';
import { api } from '../api/client';
import { useI18n, type MessageKey } from '../i18n';
import {
  buildDocs,
  filterDocs,
  totalNodes,
  type DocNode,
  type DocParam,
} from './node-docs/model';

function ParamRow({ p }: { p: DocParam }) {
  const t = useI18n((s) => s.t);
  return (
    <tr>
      <td className="doc-param-key" dir="ltr">
        <code>{p.key}</code>
        {p.required ? <span className="doc-req" title={t('docs.param.required')}>*</span> : null}
      </td>
      <td className="doc-param-type" dir="ltr">
        <code>{p.typeSummary}</code>
      </td>
      <td className="doc-param-default" dir="ltr">
        {p.defaultText !== null ? <code>{p.defaultText}</code> : <span className="muted">—</span>}
      </td>
      <td className="doc-param-desc">
        {p.description ?? <span className="muted">—</span>}
      </td>
    </tr>
  );
}

function NodeCard({ node }: { node: DocNode }) {
  const t = useI18n((s) => s.t);
  return (
    <article className="doc-node" id={`node-${node.type}`}>
      <header className="doc-node-head">
        <h3>
          {t(node.labelKey as MessageKey)}
          {node.isTrigger ? <span className="doc-tag doc-tag-trigger">{t('docs.tag.trigger')}</span> : null}
        </h3>
        <code className="doc-node-type" dir="ltr">{node.type}</code>
      </header>

      {node.descriptionKey ? (
        <p className="doc-node-desc">{t(node.descriptionKey as MessageKey)}</p>
      ) : null}

      <div className="doc-ports">
        <span className="doc-ports-label">{t('docs.ports.in')}:</span>
        {node.inputs.length > 0 ? (
          node.inputs.map((p) => <code key={p} className="doc-port" dir="ltr">{p}</code>)
        ) : (
          <span className="muted">{t('docs.ports.none')}</span>
        )}
        <span className="doc-ports-label">{t('docs.ports.out')}:</span>
        {node.outputs.length > 0 ? (
          node.outputs.map((p) => <code key={p} className="doc-port" dir="ltr">{p}</code>)
        ) : (
          <span className="muted">{t('docs.ports.dynamic')}</span>
        )}
      </div>

      {node.role || node.inputSlots.length > 0 || node.provides ? (
        <div className="doc-conn">
          {node.role ? (
            <span className="doc-conn-fact">{t('docs.conn.role')}: <code dir="ltr">{node.role}</code></span>
          ) : null}
          {node.inputSlots.length > 0 ? (
            <span className="doc-conn-fact">
              {t('docs.conn.slots')}: {node.inputSlots.map((s) => <code key={s} dir="ltr">{s}</code>)}
            </span>
          ) : null}
          {node.provides ? (
            <span className="doc-conn-fact">{t('docs.conn.provides')}: <code dir="ltr">{node.provides}</code></span>
          ) : null}
        </div>
      ) : null}

      {node.params.length > 0 ? (
        <table className="doc-params">
          <thead>
            <tr>
              <th>{t('docs.param.name')}</th>
              <th>{t('docs.param.type')}</th>
              <th>{t('docs.param.default')}</th>
              <th>{t('docs.param.desc')}</th>
            </tr>
          </thead>
          <tbody>
            {node.params.map((p) => (
              <ParamRow key={p.key} p={p} />
            ))}
          </tbody>
        </table>
      ) : (
        <p className="muted doc-noparams">{t('docs.param.none')}</p>
      )}
    </article>
  );
}

export function NodeDocsPage() {
  const t = useI18n((s) => s.t);
  const [nodeTypes, setNodeTypes] = useState<NodeTypeInfo[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');

  useEffect(() => {
    let alive = true;
    api
      .listNodeTypes()
      .then((nt) => {
        if (alive) setNodeTypes(nt);
      })
      .catch((e: unknown) => {
        if (alive) setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      alive = false;
    };
  }, []);

  const allDocs = useMemo(() => (nodeTypes ? buildDocs(nodeTypes) : []), [nodeTypes]);
  const docs = useMemo(
    () => filterDocs(allDocs, query, (key) => t(key as MessageKey)),
    [allDocs, query, t],
  );

  if (error) {
    return (
      <div className="page docs-page">
        <p className="error">{error}</p>
      </div>
    );
  }
  if (!nodeTypes) {
    return (
      <div className="page docs-page">
        <p className="muted">{t('app.loading')}</p>
      </div>
    );
  }

  const shown = totalNodes(docs);

  return (
    <div className="page docs-page">
      <header className="docs-header">
        <h1>{t('docs.title')}</h1>
        <p className="docs-sub">{t('docs.subtitle', { n: totalNodes(allDocs) })}</p>
        <input
          className="docs-search"
          type="search"
          placeholder={t('docs.search')}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          aria-label={t('docs.search')}
        />
      </header>

      {shown === 0 ? (
        <p className="muted">{t('docs.empty')}</p>
      ) : (
        docs.map((cat) => (
          <section key={cat.category} className="doc-category">
            <h2 className={`doc-cat-title cat-${cat.category}`}>
              {t(`editor.palette.cat.${cat.category}` as MessageKey)}
              <span className="doc-cat-count">{cat.nodes.length}</span>
            </h2>
            <div className="doc-node-grid">
              {cat.nodes.map((node) => (
                <NodeCard key={node.type} node={node} />
              ))}
            </div>
          </section>
        ))
      )}
    </div>
  );
}
