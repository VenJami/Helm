// Per-workspace grid sizing: fr-weights for the pane grid's columns and rows,
// dragged via the gutters (components/GridResizers) and persisted per LAYOUT —
// your 3-column weights survive independently of your 2-column ones, keyed
// "c3"/"c2"/"r2"… (lib/storage.gridWeights). Default = all 1fr (equal).

import { useCallback, useEffect, useState } from 'react';
import { storage } from '../lib/storage';

export type Axis = 'c' | 'r';

export function useGridWeights(wsId: string | null) {
  const [all, setAll] = useState<Record<string, number[]>>({});

  useEffect(() => {
    setAll(wsId ? storage.gridWeights.get(wsId) : {});
  }, [wsId]);

  // Weights for an n-track axis; anything missing/mismatched = equal tracks.
  const weightsFor = useCallback(
    (axis: Axis, n: number): number[] => {
      const w = all[axis + n];
      return w && w.length === n ? w : Array(n).fill(1);
    },
    [all],
  );

  // Live during a drag (persist=false), written to storage on release.
  const setWeights = useCallback(
    (axis: Axis, n: number, w: number[], persist: boolean) => {
      setAll((prev) => {
        const next = { ...prev, [axis + n]: w };
        if (persist && wsId) storage.gridWeights.set(wsId, next);
        return next;
      });
    },
    [wsId],
  );

  // Double-click a gutter → this axis back to equal tracks.
  const resetAxis = useCallback(
    (axis: Axis, n: number) => {
      setWeights(axis, n, Array(n).fill(1), true);
    },
    [setWeights],
  );

  return { weightsFor, setWeights, resetAxis };
}
