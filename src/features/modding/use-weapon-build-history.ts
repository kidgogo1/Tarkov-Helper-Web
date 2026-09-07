import { useState } from "react";

import type { WeaponBuild } from "../../types/weapon-modding";
import {
  createBuildHistory,
  sameBuildContext,
  transitionBuildHistory,
  type BuildHistoryAction,
} from "./weapon-build-history";

/** Session-local edits. Context switches reset before children can receive stale undo actions. */
export function useWeaponBuildHistory(initialBuild?: WeaponBuild) {
  const [stored, setStored] = useState(() => initialBuild ? createBuildHistory(initialBuild) : undefined);
  let history = stored;
  if (!sameBuildContext(stored?.present, initialBuild)) {
    history = initialBuild ? createBuildHistory(initialBuild) : undefined;
    setStored(history);
  }

  const apply = (action: BuildHistoryAction): WeaponBuild | undefined => {
    if (!history) return undefined;
    const next = transitionBuildHistory(history, action);
    if (next === history) return undefined;
    setStored(next);
    return next.present;
  };

  return {
    build: history?.present,
    canUndo: Boolean(history?.past.length),
    canRedo: Boolean(history?.future.length),
    commit: (build: WeaponBuild) => apply({ type: "commit", build }),
    undo: () => apply({ type: "undo" }),
    redo: () => apply({ type: "redo" }),
  };
}
