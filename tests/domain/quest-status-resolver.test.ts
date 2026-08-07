import { describe, expect, it } from "vitest";

import {
  createQuestStatusResolver,
  getQuestStatistics,
  recommendQuests,
} from "../../src/domain/quests";
import {
  aggregateItemRequirements,
  getCollectorQuestChain,
} from "../../src/domain/items";
import type { QuestData } from "../../src/types/data";
import type { ProfileState } from "../../src/types/state";

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
    hideoutLevels: {},
    inventory: {},
    customMarkers: [],
    ...overrides,
  };
}

describe("quest status resolver", () => {
  it("indexes the quest collection once and does not rescan it for repeated status reads", () => {
    const prerequisite = quest("prerequisite");
    const target = quest("target", {
      requirements: [
        {
          questId: prerequisite.id,
          requirementType: "complete",
          groupId: 0,
        },
      ],
    });
    const source = [prerequisite, target];
    let collectionReads = 0;
    const quests = new Proxy(source, {
      get(array, property, receiver) {
        if (
          property === Symbol.iterator ||
          property === "length" ||
          (typeof property === "string" && /^\d+$/.test(property))
        ) {
          collectionReads += 1;
        }
        return Reflect.get(array, property, receiver);
      },
    });

    const resolver = createQuestStatusResolver(quests, profile());
    collectionReads = 0;

    expect(resolver.getStatus(target)).toBe("locked");
    expect(resolver.getStatus(prerequisite)).toBe("active");
    expect(resolver.getStatus(target)).toBe("locked");
    expect(collectionReads).toBe(0);
  });

  it("reuses one stable status map across statistics and recommendations", () => {
    const active = quest("active");
    const done = quest("done");
    const quests = [active, done];
    const state = profile({ questProgress: { done: "done" } });
    const resolver = createQuestStatusResolver(quests, state);

    const statuses = resolver.getStatuses();

    expect(resolver.getStatuses()).toBe(statuses);
    expect(statuses.get(active)).toBe("active");
    expect(statuses.get(done)).toBe("done");
    expect(getQuestStatistics(quests, state, resolver)).toMatchObject({
      active: 1,
      done: 1,
    });
    expect(recommendQuests(quests, state, 5, resolver)).toHaveLength(1);
    expect(resolver.getStatuses()).toBe(statuses);
  });

  it("keeps root-relative cycle semantics deterministic while caching top-level results", () => {
    const a = quest("a", {
      requirements: [
        { questId: "b", requirementType: "failed", groupId: 0 },
      ],
    });
    const b = quest("b", {
      requirements: [
        { questId: "a", requirementType: "active", groupId: 0 },
      ],
    });
    const resolver = createQuestStatusResolver([a, b], profile());

    expect(resolver.getStatus(a)).toBe("locked");
    expect(resolver.getStatus(b)).toBe("locked");
    expect(resolver.getStatuses()).toEqual(
      new Map<QuestData, "locked">([
        [a, "locked"],
        [b, "locked"],
      ]),
    );
  });

  it("lets item aggregations reuse the same index instead of rebuilding it per quest", () => {
    const prerequisite = quest("prerequisite");
    const collector = quest("collector", {
      requirements: [
        {
          questId: prerequisite.id,
          requirementType: "complete",
          groupId: 0,
        },
      ],
    });
    const source = [prerequisite, collector];
    let iteratorReads = 0;
    const quests = new Proxy(source, {
      get(array, property, receiver) {
        if (property === Symbol.iterator) iteratorReads += 1;
        return Reflect.get(array, property, receiver);
      },
    });
    const state = profile();
    const resolver = createQuestStatusResolver(quests, state);
    iteratorReads = 0;

    expect(
      aggregateItemRequirements(quests, [], [], state, resolver),
    ).toEqual([]);
    expect(iteratorReads).toBe(0);

    expect(
      getCollectorQuestChain(
        quests,
        state,
        true,
        "collector",
        resolver,
      ).map((candidate) => candidate.id),
    ).toEqual(["collector", "prerequisite"]);
    // One pass is still required for Collector's name/prerequisite lookup.
    expect(iteratorReads).toBe(1);
  });
});
