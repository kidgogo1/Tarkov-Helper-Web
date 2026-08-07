import { describe, expect, it } from "vitest";

import {
  applyAlternativeQuestSelections,
  collectAlternativeQuestGroups,
  getManualPrerequisites,
} from "../../src/domain/quest-sync";
import type { QuestData } from "../../src/types/data";

function quest(id: string, overrides: Partial<QuestData> = {}): QuestData {
  return {
    id,
    normalizedName: id,
    name: id,
    nameEn: id,
    trader: "Prapor",
    locations: [],
    kappaRequired: false,
    requirements: [],
    alternativeQuestIds: [],
    followUpQuestIds: [],
    objectives: [],
    requiredItems: [],
    ...overrides,
  };
}

describe("manual in-progress quest planning", () => {
  it("collects unfinished recursive prerequisites and removes selected quests", () => {
    const root = quest("root");
    const branch = quest("branch", {
      requirements: [{ questId: "root", requirementType: "complete", groupId: 0 }],
    });
    const selectedA = quest("selected-a", {
      requirements: [{ questId: "branch", requirementType: "complete", groupId: 0 }],
    });
    const selectedB = quest("selected-b", {
      requirements: [
        { questId: "root", requirementType: "complete", groupId: 0 },
        { questId: "selected-a", requirementType: "complete", groupId: 0 },
      ],
    });

    expect(
      getManualPrerequisites(
        ["selected-a", "selected-b"],
        [root, branch, selectedA, selectedB],
        { root: "done" },
      ).map(({ id }) => id),
    ).toEqual(["branch"]);
  });
});

describe("alternative prerequisite choices", () => {
  const routeA = quest("route-a", { alternativeQuestIds: ["route-b"] });
  const routeB = quest("route-b", { alternativeQuestIds: ["route-a"] });
  const middle = quest("middle", {
    requirements: [{ questId: "route-a", requirementType: "complete", groupId: 0 }],
  });
  const target = quest("target", {
    requirements: [{ questId: "middle", requirementType: "complete", groupId: 0 }],
  });
  const quests = [routeA, routeB, middle, target];

  it("finds and deduplicates mutually exclusive groups in recursive prerequisites", () => {
    const groups = collectAlternativeQuestGroups(["target", "middle"], quests, {});

    expect(groups).toHaveLength(1);
    expect(groups[0].key).toBe("route-a|route-b");
    expect(groups[0].choices.map(({ quest }) => quest.id)).toEqual(["route-a", "route-b"]);
    expect(groups[0].defaultQuestId).toBe("route-a");
  });

  it("does not ask again when one choice is already completed", () => {
    expect(
      collectAlternativeQuestGroups(["target"], quests, { "route-b": "done" }),
    ).toEqual([]);
  });

  it("completes the selected route and fails every other unfinished choice", () => {
    const groups = collectAlternativeQuestGroups(["target"], quests, { unrelated: "done" });

    expect(
      applyAlternativeQuestSelections(
        { unrelated: "done" },
        groups,
        { "route-a|route-b": "route-b" },
      ),
    ).toEqual({ unrelated: "done", "route-a": "failed", "route-b": "done" });
  });
});
