import type { BuildNode, WeaponBuild } from "../../types/weapon-modding";

export const MAX_BUILD_HISTORY = 40;

export interface BuildHistory {
  past: WeaponBuild[];
  present: WeaponBuild;
  future: WeaponBuild[];
}

export type BuildHistoryAction =
  | { type: "commit"; build: WeaponBuild }
  | { type: "undo" }
  | { type: "redo" };

export function createBuildHistory(build: WeaponBuild): BuildHistory {
  return { past: [], present: build, future: [] };
}

export function sameBuildContext(left?: WeaponBuild, right?: WeaponBuild): boolean {
  return left?.weaponId === right?.weaponId &&
    left?.catalogDataVersion === right?.catalogDataVersion;
}

/** Assembly equality ignores generated instance IDs, not repeated parts or slot placement. */
export function sameBuildAssembly(left: WeaponBuild, right: WeaponBuild): boolean {
  return left.weaponId === right.weaponId && sameNodeAssembly(left.root, right.root);
}

function sameNodeAssembly(left: BuildNode, right: BuildNode): boolean {
  if (left.itemId !== right.itemId || left.slotId !== right.slotId ||
      left.children.length !== right.children.length) return false;
  const rightChildren = new Map(right.children.map((child) => [child.slotId, child]));
  return left.children.every((child) => {
    const other = rightChildren.get(child.slotId);
    return other !== undefined && sameNodeAssembly(child, other);
  });
}

/** Only immutable, already validated builds enter the session history; prices and named saves do not. */
export function transitionBuildHistory(history: BuildHistory, action: BuildHistoryAction): BuildHistory {
  if (action.type === "commit") {
    if (!sameBuildContext(history.present, action.build)) return createBuildHistory(action.build);
    if (sameBuildAssembly(history.present, action.build)) return history;
    return {
      past: [...history.past, history.present].slice(-MAX_BUILD_HISTORY),
      present: action.build,
      future: [],
    };
  }
  if (action.type === "undo") {
    const previous = history.past.at(-1);
    if (!previous) return history;
    return {
      past: history.past.slice(0, -1),
      present: previous,
      future: [history.present, ...history.future].slice(0, MAX_BUILD_HISTORY),
    };
  }
  const next = history.future[0];
  if (!next) return history;
  return {
    past: [...history.past, history.present].slice(-MAX_BUILD_HISTORY),
    present: next,
    future: history.future.slice(1),
  };
}
