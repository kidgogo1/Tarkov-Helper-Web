import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { useWeaponBuildHistory } from "../../src/features/modding/use-weapon-build-history";
import type { WeaponBuild } from "../../src/types/weapon-modding";

function build(weaponId: string, itemId = "stock", dataVersion = "v1"): WeaponBuild {
  return {
    schemaVersion: 1,
    weaponId,
    catalogDataVersion: dataVersion,
    root: {
      instanceId: `root:${weaponId}`,
      itemId: weaponId,
      children: [{ instanceId: "stock", itemId, slotId: "stock-slot", children: [] }],
    },
  };
}

describe("useWeaponBuildHistory", () => {
  it("clears previous history immediately when a deep link changes and when returning without editing", () => {
    const { result, rerender } = renderHook(({ initial }) => useWeaponBuildHistory(initial), {
      initialProps: { initial: build("first") },
    });
    act(() => result.current.commit(build("first", "changed")));
    expect(result.current.canUndo).toBe(true);

    rerender({ initial: build("second") });
    expect(result.current.build?.weaponId).toBe("second");
    expect(result.current.canUndo).toBe(false);
    rerender({ initial: build("first", "changed") });
    expect(result.current.build?.weaponId).toBe("first");
    expect(result.current.canUndo).toBe(false);
    expect(result.current.canRedo).toBe(false);
  });

  it("keeps edits on same-context rerenders but resets when catalog data changes", () => {
    const { result, rerender } = renderHook(({ initial }) => useWeaponBuildHistory(initial), {
      initialProps: { initial: build("first") },
    });
    act(() => result.current.commit(build("first", "changed")));
    rerender({ initial: build("first") });
    expect(result.current.build).toEqual(build("first", "changed"));
    expect(result.current.canUndo).toBe(true);
    rerender({ initial: build("first", "changed", "v2") });
    expect(result.current.build?.catalogDataVersion).toBe("v2");
    expect(result.current.canUndo).toBe(false);
  });

  it("returns the changed build for persistence and nothing for no-op undo or redo", () => {
    const { result } = renderHook(() => useWeaponBuildHistory(build("first")));
    act(() => expect(result.current.undo()).toBeUndefined());
    act(() => expect(result.current.commit(build("first"))).toBeUndefined());
    act(() => expect(result.current.commit(build("first", "changed"))).toEqual(build("first", "changed")));
    act(() => expect(result.current.undo()).toEqual(build("first")));
    act(() => expect(result.current.redo()).toEqual(build("first", "changed")));
    act(() => expect(result.current.redo()).toBeUndefined());
  });
});
