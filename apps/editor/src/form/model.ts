/**
 * Form value model (P2-T3) — pure, DOM-free helpers the form engine uses to
 * read/write the params object. Kept separate from React so the acceptance
 * test can drive "form edits" headless and validate the produced params
 * against the real shared Zod schemas.
 *
 * Paths are arrays of keys/indices ("JSON pointer" segments):
 *   ['keyboard','rows',0,1,'text']
 */

export type Path = (string | number)[];

export function getAtPath(value: unknown, path: Path): unknown {
  let cur: unknown = value;
  for (const seg of path) {
    if (cur === null || cur === undefined) return undefined;
    if (typeof seg === 'number') {
      if (!Array.isArray(cur)) return undefined;
      cur = cur[seg];
    } else {
      if (typeof cur !== 'object' || Array.isArray(cur)) return undefined;
      cur = (cur as Record<string, unknown>)[seg];
    }
  }
  return cur;
}

/**
 * Immutable set: returns a new root with `path` set to `next`. Missing
 * intermediate containers are created (object for string seg, array for
 * number seg). Setting `undefined` DELETES the key (so optional params drop
 * out of the JSON instead of lingering as nulls Zod would reject).
 */
export function setAtPath(root: unknown, path: Path, next: unknown): unknown {
  if (path.length === 0) return next;
  const [seg, ...rest] = path as [string | number, ...Path];

  if (typeof seg === 'number') {
    const arr = Array.isArray(root) ? [...root] : [];
    while (arr.length < seg) arr.push(undefined);
    if (rest.length === 0 && next === undefined) {
      arr.splice(seg, 1); // deleting an array slot = remove the row
      return arr;
    }
    arr[seg] = setAtPath(arr[seg], rest, next);
    return arr;
  }

  const obj: Record<string, unknown> =
    root !== null && typeof root === 'object' && !Array.isArray(root)
      ? { ...(root as Record<string, unknown>) }
      : {};
  if (rest.length === 0 && next === undefined) {
    delete obj[seg];
    return obj;
  }
  obj[seg] = setAtPath(obj[seg], rest, next);
  return obj;
}

/** Move an array row up/down (rows widgets). No-op when out of range. */
export function moveRow(root: unknown, path: Path, index: number, dir: -1 | 1): unknown {
  const arr = getAtPath(root, path);
  if (!Array.isArray(arr)) return root;
  const j = index + dir;
  if (index < 0 || index >= arr.length || j < 0 || j >= arr.length) return root;
  const next = [...arr];
  const tmp = next[index];
  next[index] = next[j];
  next[j] = tmp;
  return setAtPath(root, path, next);
}

/**
 * Drop empty-string / undefined / empty-object leaves so optional Zod params
 * pass validation ("" is not a valid enum/duration; an empty `validation:{}`
 * object is fine but `validation:{regex:""}` is noise). Arrays keep their
 * rows (a row the user added is intentional). Called once before the form
 * value is committed to the node.
 */
export function pruneEmpty(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(pruneEmpty);
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const pruned = pruneEmpty(v);
      if (pruned === undefined || pruned === '') continue;
      if (
        pruned !== null &&
        typeof pruned === 'object' &&
        !Array.isArray(pruned) &&
        Object.keys(pruned).length === 0
      )
        continue;
      out[k] = pruned;
    }
    return out;
  }
  return value;
}
