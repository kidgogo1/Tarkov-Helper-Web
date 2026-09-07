import { describe, expect, it } from "vitest";

import {
  createBuildHistory,
  sameBuildAssembly,
  transitionBuildHistory,
} from "../../src/features/modding/weapon-build-history";
import type { WeaponBuild } from "../../src/types/weapon-modding";

function build(part = "stock", weaponId = "weapon", dataVersion = "catalog-1"): WeaponBuild {
  return {
    schemaVersion: 1,
    catalogDataVersion: dataVersion,
    weaponId,
    root: {
      instanceId: `root:${weaponId}`,
      itemId: weaponId,
      children: [{
        instanceId: "root:weapon/stock",
        itemId: part,
        slotId: "stock-slot",
        children: [{ instanceId: "pad", itemId: `${part}-pad`, slotId: "pad-slot", children: [] }],
      }],
    },
  };
}

describe("weapon build edit history", () => {
  it("undoes and redoes a whole replacement including removed descendants", () => {
    const original = build();
    const replacement = build("replacement");
    const initial = createBuildHistory(original);
    const edited = transitionBuildHistory(initial, { type: "commit", build: replacement });
    const undone = transitionBuildHistory(edited, { type: "undo" });
    const redone = transitionBuildHistory(undone, { type: "redo" });

    expect(undone.present).toEqual(original);
    expect(redone.present).toEqual(replacement);
    expect(initial).toEqual({ past: [], present: original, future: [] });
    expect(redone.past).toHaveLength(1);
    expect(redone.future).toEqual([]);
  });

  it("clears redo only when a genuinely different assembly is committed", () => {
    const first = createBuildHistory(build());
    const changed = transitionBuildHistory(first, { type: "commit", build: build("second") });
    const undone = transitionBuildHistory(changed, { type: "undo" });
    const repeated = transitionBuildHistory(undone, { type: "commit", build: build() });
    const branched = transitionBuildHistory(repeated, { type: "commit", build: build("third") });

    expect(repeated).toBe(undone);
    expect(repeated.future).toHaveLength(1);
    expect(branched.future).toEqual([]);
    expect(transitionBuildHistory(branched, { type: "redo" })).toBe(branched);
  });

  it("compares assembly slots rather than generated instance IDs or child array order", () => {
    const original = build();
    original.root.children.push({ instanceId: "sight", itemId: "sight", slotId: "sight-slot", children: [] });
    const reordered = structuredClone(original);
    reordered.root.instanceId = "another-root";
    reordered.root.children.reverse();
    reordered.root.children[1].instanceId = "another-stock";
    expect(sameBuildAssembly(original, reordered)).toBe(true);
    reordered.root.children[1].children[0].itemId = "different-pad";
    expect(sameBuildAssembly(original, reordered)).toBe(false);
  });

  it("keeps the latest forty changes and never mutates saved snapshots", () => {
    let history = createBuildHistory(build("0"));
    for (let index = 1; index <= 45; index += 1) {
      history = transitionBuildHistory(history, { type: "commit", build: build(String(index)) });
    }
    expect(history.past).toHaveLength(40);
    for (let index = 0; index < 40; index += 1) {
      history = transitionBuildHistory(history, { type: "undo" });
    }
    expect(history.present).toEqual(build("5"));
    expect(history.future).toHaveLength(40);
    expect(transitionBuildHistory(history, { type: "undo" })).toBe(history);
  });

  it("starts a new context for another weapon or catalog instead of undoing across them", () => {
    const initial = transitionBuildHistory(createBuildHistory(build()), { type: "commit", build: build("second") });
    for (const next of [build("stock", "other-weapon"), build("stock", "weapon", "catalog-2")]) {
      const replaced = transitionBuildHistory(initial, { type: "commit", build: next });
      expect(replaced).toEqual({ past: [], present: next, future: [] });
    }
  });

  it("records a factory reset or incomplete preset load as one reversible edit", () => {
    const factory = build();
    const incomplete = { ...factory, root: { ...factory.root, children: [] } };
    const modified = transitionBuildHistory(createBuildHistory(factory), { type: "commit", build: incomplete });
    const reset = transitionBuildHistory(modified, { type: "commit", build: factory });
    expect(transitionBuildHistory(reset, { type: "undo" }).present).toEqual(incomplete);
    expect(transitionBuildHistory(transitionBuildHistory(reset, { type: "undo" }), { type: "undo" }).present).toEqual(factory);
  });
});
