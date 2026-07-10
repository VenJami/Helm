import { useRef, type PointerEvent as ReactPointerEvent, type RefObject } from 'react';
import type { Axis } from '../hooks/useGridWeights';

// Drag handles between grid tracks: a thin vertical gutter per column boundary
// and a horizontal one per row boundary, absolutely positioned over the grid
// (an absolute child of a grid container is out of grid flow). Dragging shifts
// fr-weight between the two adjacent tracks — the grid's total size never
// changes, panes just trade space. Double-click resets the axis to equal.
//
// Gutter positions are the cumulative weight fractions; the 8px grid gap makes
// that approximate by a few px, which a 10px-wide hit area absorbs.

const MIN_W = 0.3; // no track can shrink below 0.3fr — keeps every pane usable

export function GridResizers({
  containerRef,
  colWeights,
  rowWeights,
  onDrag,
  onReset,
}: {
  containerRef: RefObject<HTMLDivElement | null>;
  colWeights: number[];
  rowWeights: number[];
  // Live weights during a drag; persist=true on pointer release.
  onDrag: (axis: Axis, n: number, weights: number[], persist: boolean) => void;
  onReset: (axis: Axis, n: number) => void;
}) {
  // Snapshot at drag start so movement is computed absolutely (no compounding);
  // `last` tracks the most recent live weights so release can persist them.
  const drag = useRef<{
    axis: Axis;
    index: number;
    start: number[];
    last: number[];
    origin: number;
    span: number;
  } | null>(null);

  const begin =
    (axis: Axis, index: number, weights: number[]) => (e: ReactPointerEvent<HTMLDivElement>) => {
      const box = containerRef.current?.getBoundingClientRect();
      if (!box) return;
      drag.current = {
        axis,
        index,
        start: [...weights],
        last: [...weights],
        origin: axis === 'c' ? e.clientX : e.clientY,
        span: axis === 'c' ? box.width : box.height,
      };
      (e.target as HTMLElement).setPointerCapture(e.pointerId);
    };

  const move = (e: ReactPointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d) return;
    const delta = (d.axis === 'c' ? e.clientX : e.clientY) - d.origin;
    const total = d.start.reduce((a, b) => a + b, 0);
    const deltaFr = (delta / d.span) * total;
    const pair = d.start[d.index] + d.start[d.index + 1];
    const w = [...d.start];
    w[d.index] = Math.min(pair - MIN_W, Math.max(MIN_W, d.start[d.index] + deltaFr));
    w[d.index + 1] = pair - w[d.index];
    d.last = w;
    onDrag(d.axis, w.length, w, false);
  };

  const end = (e: ReactPointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d) return;
    drag.current = null;
    (e.target as HTMLElement).releasePointerCapture(e.pointerId);
    onDrag(d.axis, d.last.length, d.last, true); // final weights → storage
  };

  // Cumulative fraction of the tracks before boundary i+1 (gutter position).
  const fractionsBefore = (weights: number[]) => {
    const total = weights.reduce((a, b) => a + b, 0);
    let acc = 0;
    return weights.slice(0, -1).map((w) => {
      acc += w;
      return acc / total;
    });
  };

  return (
    <>
      {colWeights.length > 1 &&
        fractionsBefore(colWeights).map((frac, i) => (
          <div
            key={`c${i}`}
            className="grid-gutter grid-gutter-col"
            style={{ left: `calc(${(frac * 100).toFixed(3)}% - 5px)` }}
            title="Drag to resize columns · double-click to reset"
            onPointerDown={begin('c', i, colWeights)}
            onPointerMove={move}
            onPointerUp={end}
            onDoubleClick={() => onReset('c', colWeights.length)}
          />
        ))}
      {rowWeights.length > 1 &&
        fractionsBefore(rowWeights).map((frac, i) => (
          <div
            key={`r${i}`}
            className="grid-gutter grid-gutter-row"
            style={{ top: `calc(${(frac * 100).toFixed(3)}% - 5px)` }}
            title="Drag to resize rows · double-click to reset"
            onPointerDown={begin('r', i, rowWeights)}
            onPointerMove={move}
            onPointerUp={end}
            onDoubleClick={() => onReset('r', rowWeights.length)}
          />
        ))}
    </>
  );
}
