import { describe, expect, it } from "vitest";

import type { QuestData, QuestObjective } from "../../src/types/data";
import type { ProfileState } from "../../src/types/state";
import {
  areQuestPrerequisitesMet,
  completeQuest,
  getQuestStatistics,
  getQuestStatus,
  groupQuestRequirementsForDisplay,
  isEditionRequirementMet,
  isScavKarmaRequirementMet,
  recommendQuests,
  resetAllQuestProgress,
  resetQuest,
} from "../../src/domain/quests";

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

function objective(description: string): QuestObjective {
  return {
    id: description,
    sortOrder: 0,
    objectiveType: "custom",
    description,
    requiresFir: false,
    locationPoints: [],
    optionalPoints: [],
  };
}

function profile(overrides: Partial<ProfileState> = {}): ProfileState {
  return {
    level: 20,
    scavRep: 1,
    dspDecodeCount: 0,
    hasEodEdition: false,
    hasUnheardEdition: false,
    prestigeLevel: 0,
    faction: "usec",
    questProgress: {},
    objectiveProgress: {},
    trackedQuestIds: [],
    mapRouteQuestIds: [],
    hideoutLevels: {},
    inventory: {},
    customMarkers: [],
    ...overrides,
  };
}

describe("quest status", () => {
  it("gives a saved terminal state precedence over profile restrictions", () => {
    const restricted = quest("restricted", {
      normalizedName: "restricted-name",
      requiredEdition: "edge_of_darkness",
      faction: "bear",
      requiredPrestigeLevel: 9,
    });

    expect(
      getQuestStatus(
        restricted,
        [restricted],
        profile({ questProgress: { restricted: "done" } }),
      ),
    ).toBe("done");
    expect(
      getQuestStatus(
        restricted,
        [restricted],
        profile({ questProgress: { "restricted-name": "failed" } }),
      ),
    ).toBe("failed");
  });

  it("applies unavailable, locked, and level-locked profile rules in source order", () => {
    expect(
      getQuestStatus(
        quest("edition", { requiredEdition: "eod" }),
        [],
        profile(),
      ),
    ).toBe("unavailable");
    expect(
      getQuestStatus(
        quest("excluded", { excludedEdition: "the_unheard" }),
        [],
        profile({ hasUnheardEdition: true }),
      ),
    ).toBe("unavailable");
    expect(
      getQuestStatus(
        quest("prestige", { requiredPrestigeLevel: 2 }),
        [],
        profile({ prestigeLevel: 1 }),
      ),
    ).toBe("unavailable");
    expect(
      getQuestStatus(
        quest("faction", { faction: "bear" }),
        [],
        profile({ faction: "usec" }),
      ),
    ).toBe("unavailable");
    expect(
      getQuestStatus(
        quest("unselected-faction", { faction: "bear" }),
        [],
        profile({ faction: null }),
      ),
    ).toBe("active");
    expect(
      getQuestStatus(
        quest("dsp", { requiredDecodeCount: 2 }),
        [],
        profile({ dspDecodeCount: 3 }),
      ),
    ).toBe("locked");
    expect(
      getQuestStatus(
        quest("level", { minLevel: 21 }),
        [],
        profile({ level: 20 }),
      ),
    ).toBe("levelLocked");
    expect(
      getQuestStatus(
        quest("bad-karma", { minScavKarma: -2 }),
        [],
        profile({ scavRep: -1 }),
      ),
    ).toBe("levelLocked");
  });

  it("exposes edition and signed scav-karma requirement helpers", () => {
    expect(
      isEditionRequirementMet(
        quest("eod", { requiredEdition: "EOD" }),
        profile({ hasEodEdition: true }),
      ),
    ).toBe(true);
    expect(
      isScavKarmaRequirementMet(
        quest("negative", { minScavKarma: -2 }),
        profile({ scavRep: -2.1 }),
      ),
    ).toBe(true);
    expect(
      isScavKarmaRequirementMet(
        quest("positive", { minScavKarma: 2 }),
        profile({ scavRep: 1.99 }),
      ),
    ).toBe(false);
  });

  it("supports AND requirements, one-success-per-OR-group, and status aliases", () => {
    const done = quest("done");
    const active = quest("active");
    const failed = quest("failed");
    const target = quest("target", {
      requirements: [
        { questId: "done", requirementType: "Complete", groupId: 0 },
        { questId: "active", requirementType: "Accept", groupId: 1 },
        { questId: "failed", requirementType: "Complete", groupId: 1 },
        { questId: "failed", requirementType: "Fail", groupId: 2 },
      ],
    });
    const quests = [done, active, failed, target];
    const state = profile({
      questProgress: { done: "done", failed: "failed" },
    });

    expect(areQuestPrerequisitesMet(target, quests, state)).toBe(true);
    expect(getQuestStatus(target, quests, state)).toBe("active");
    expect(
      areQuestPrerequisitesMet(
        target,
        quests,
        profile({ questProgress: { failed: "failed" } }),
      ),
    ).toBe(false);
  });

  it("skips missing AND references but fails an OR group with no resolvable choice", () => {
    const missingAnd = quest("and", {
      requirements: [
        { questId: "missing", requirementType: "complete", groupId: 0 },
      ],
    });
    const missingOr = quest("or", {
      requirements: [
        { questId: "missing", requirementType: "complete", groupId: 1 },
      ],
    });

    expect(areQuestPrerequisitesMet(missingAnd, [missingAnd], profile())).toBe(
      true,
    );
    expect(areQuestPrerequisitesMet(missingOr, [missingOr], profile())).toBe(
      false,
    );
  });

  it("does not recurse forever for circular prerequisite status checks", () => {
    const a = quest("a", {
      requirements: [
        { questId: "b", requirementType: "complete", groupId: 0 },
      ],
    });
    const b = quest("b", {
      requirements: [
        { questId: "a", requirementType: "complete", groupId: 0 },
      ],
    });

    expect(getQuestStatus(a, [a, b], profile())).toBe("locked");
  });
});

describe("quest progress transitions", () => {
  it("shows singleton numbered groups as ordinary prerequisites and true choices as OR", () => {
    const direct = { questId: "direct", requirementType: "complete", groupId: 0 };
    const singleton = { questId: "singleton", requirementType: "complete", groupId: 2 };
    const choiceA = { questId: "choice-a", requirementType: "complete", groupId: 1 };
    const choiceB = { questId: "choice-b", requirementType: "complete", groupId: 1 };

    expect(
      groupQuestRequirementsForDisplay([direct, singleton, choiceA, choiceB]),
    ).toEqual({
      direct: [direct, singleton],
      alternatives: [{ groupId: 1, requirements: [choiceA, choiceB] }],
    });
  });

  it("recursively completes ordinary prerequisites without looping on cycles", () => {
    const a = quest("a", {
      requirements: [
        { questId: "b", requirementType: "complete", groupId: 0 },
      ],
    });
    const b = quest("b", {
      requirements: [
        { questId: "a", requirementType: "complete", groupId: 0 },
      ],
    });

    expect(completeQuest("a", [a, b], {})).toEqual({ a: "done", b: "done" });
  });

  it("leaves mutually exclusive prerequisites for the user and fails alternatives of the completed quest", () => {
    const branchA = quest("branch-a", { alternativeQuestIds: ["branch-b"] });
    const branchB = quest("branch-b", { alternativeQuestIds: ["branch-a"] });
    const target = quest("target", {
      requirements: [
        { questId: "branch-a", requirementType: "complete", groupId: 0 },
      ],
      alternativeQuestIds: ["other-ending"],
    });
    const otherEnding = quest("other-ending");

    expect(
      completeQuest("target", [branchA, branchB, target, otherEnding], {}),
    ).toEqual({ target: "done", "other-ending": "failed" });
  });

  it("does not overwrite an already completed alternative", () => {
    const selected = quest("selected", { alternativeQuestIds: ["alternative"] });
    const alternative = quest("alternative");

    expect(
      completeQuest("selected", [selected, alternative], {
        alternative: "done",
      }),
    ).toEqual({ alternative: "done", selected: "done" });
  });

  it("can apply a log-backed completion without inventing prerequisite progress", () => {
    const prerequisite = quest("prerequisite");
    const target = quest("target", {
      requirements: [
        { questId: "prerequisite", requirementType: "complete", groupId: 0 },
      ],
      alternativeQuestIds: ["alternative"],
    });
    const alternative = quest("alternative");

    expect(
      completeQuest("target", [prerequisite, target, alternative], {}, {
        completePrerequisites: false,
      }),
    ).toEqual({ target: "done", alternative: "failed" });
  });

  it("resets ID/name migration keys and can reset all progress records", () => {
    const task = quest("id", { normalizedName: "normalized" });
    expect(
      resetQuest({ id: "done", normalized: "failed", untouched: "done" }, task),
    ).toEqual({ untouched: "done" });
    expect(
      resetAllQuestProgress({ id: "done" }, { objective: true }),
    ).toEqual({ questProgress: {}, objectiveProgress: {} });
  });

  it("counts every calculated status", () => {
    const done = quest("done");
    const failed = quest("failed");
    const active = quest("active");
    const locked = quest("locked", {
      requirements: [
        { questId: "active", requirementType: "complete", groupId: 0 },
      ],
    });
    const levelLocked = quest("level", { minLevel: 99 });
    const unavailable = quest("bear", { faction: "bear" });
    const quests = [done, failed, active, locked, levelLocked, unavailable];

    expect(
      getQuestStatistics(
        quests,
        profile({ questProgress: { done: "done", failed: "failed" } }),
      ),
    ).toEqual({
      total: 6,
      locked: 1,
      active: 1,
      done: 1,
      failed: 1,
      levelLocked: 1,
      unavailable: 1,
    });
  });
});

describe("quest recommendations", () => {
  it("ports the modified fork scoring and returns five active recommendations", () => {
    const ready = quest("ready", {
      kappaRequired: true,
      followUpQuestIds: ["a", "b"],
      requiredItems: [
        {
          id: "ready-item",
          itemId: "fir-item",
          itemName: "FIR Item",
          count: 2,
          requiresFir: true,
          requirementType: "handover",
          sortOrder: 0,
        },
      ],
    });
    const unlocks = quest("unlocks", {
      objectives: [objective("Eliminate 5 PMCs")],
      followUpQuestIds: ["one", "two", "three"],
      requiredItems: [
        {
          id: "missing",
          itemId: "missing-item",
          itemName: "Missing",
          count: 1,
          requiresFir: false,
          requirementType: "handover",
          sortOrder: 0,
        },
      ],
    });
    const kappa = quest("kappa", {
      kappaRequired: true,
      objectives: [objective("Survive the raid")],
      followUpQuestIds: ["one"],
      requiredItems: [
        {
          id: "missing-kappa",
          itemId: "missing-kappa",
          itemName: "Missing Kappa",
          count: 1,
          requiresFir: false,
          requirementType: "handover",
          sortOrder: 0,
        },
      ],
    });
    const handIn = quest("hand-in", {
      requiredItems: [
        {
          id: "owned",
          itemId: "owned",
          itemName: "Owned",
          count: 1,
          requiresFir: false,
          requirementType: "handover",
          sortOrder: 0,
        },
        {
          id: "not-owned",
          itemId: "not-owned",
          itemName: "Not owned",
          count: 1,
          requiresFir: false,
          requirementType: "handover",
          sortOrder: 1,
        },
      ],
    });
    const easy = quest("easy");
    const ignoredDone = quest("ignored-done");
    const quests = [ready, unlocks, kappa, handIn, easy, ignoredDone];
    const state = profile({
      questProgress: { "ignored-done": "done" },
      inventory: {
        "fir-item": { fir: 2, nonFir: 99 },
        owned: { fir: 0, nonFir: 1 },
      },
    });

    const recommendations = recommendQuests(quests, state);

    expect(
      recommendations.map(({ quest: task, type, priority }) => ({
        id: task.id,
        type,
        priority,
      })),
    ).toEqual([
      { id: "ready", type: "readyToComplete", priority: 130 },
      { id: "unlocks", type: "unlocksMany", priority: 90 },
      { id: "kappa", type: "kappaPriority", priority: 75 },
      { id: "hand-in", type: "itemHandInOnly", priority: 70 },
      { id: "easy", type: "easyQuest", priority: 40 },
    ]);
    expect(recommendations[0]?.readyItems[0]).toMatchObject({
      owned: 2,
    });
    expect(recommendations[3]?.missingItems[0]).toMatchObject({ needed: 1 });
  });
});
