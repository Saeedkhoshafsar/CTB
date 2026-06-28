/**
 * Skeleton loaders (UX) — shimmer placeholders shown while list data loads, so
 * the layout doesn't pop/shift when the real rows arrive (PLAN5 P2-T5 / B5).
 *
 * `SkeletonRow` mimics the `.row` list-item shape (title + sub on the start,
 * controls on the end). `SkeletonList` renders N of them. The shimmer animation
 * is gated behind `prefers-reduced-motion` in styles.css.
 */

export function SkeletonRow() {
  return (
    <div className="row skeleton-row" aria-hidden="true">
      <div className="grow">
        <div className="skeleton skeleton-title" />
        <div className="skeleton skeleton-sub" />
      </div>
      <div className="skeleton skeleton-badge" />
      <div className="skeleton skeleton-btn" />
      <div className="skeleton skeleton-btn" />
    </div>
  );
}

export interface SkeletonListProps {
  /** Number of placeholder rows to render. */
  rows?: number;
  /** Optional localized label announced to assistive tech. */
  label?: string;
}

export function SkeletonList({ rows = 4, label }: SkeletonListProps) {
  return (
    <div className="row-list" role="status" aria-busy="true" aria-label={label}>
      {Array.from({ length: rows }, (_, i) => (
        <SkeletonRow key={i} />
      ))}
    </div>
  );
}
