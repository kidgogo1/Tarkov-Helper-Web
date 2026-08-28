import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

async function readJson(relativePath) {
  return JSON.parse(await readFile(path.join(root, relativePath), "utf8"));
}

function allCatalogQuests(data) {
  const byId = new Map();
  for (const quest of [
    ...data.quests,
    ...Object.values(data.questCatalogs ?? {}).flat(),
  ]) {
    if (!byId.has(quest.id)) byId.set(quest.id, quest);
  }
  return [...byId.values()];
}

describe("Wiki quest guide index", () => {
  it("contains only verified Wiki links and the expected quest coverage", async () => {
    const [guides, data] = await Promise.all([
      readJson("public/data/quest-wiki-guides.json"),
      readJson("public/data/tarkov-data.json"),
    ]);
    expect(guides.schemaVersion).toBe(1);
    const catalogQuests = allCatalogQuests(data);
    expect(guides.questCount).toBe(catalogQuests.length);
    expect(Object.keys(guides.entries)).toHaveLength(catalogQuests.length);
    const verified = Object.values(guides.entries).filter((entry) => !entry.error);
    expect(verified.length).toBeGreaterThan(535);
    expect(Object.values(guides.entries).filter((entry) =>
      ["PAGE_NOT_FOUND", "INVALID_WIKI_LINK"].includes(entry.error),
    )).toEqual([]);
    for (const entry of verified) {
      expect(entry.wikiPageLink).toMatch(/^https:\/\/escapefromtarkov\.fandom\.com\/wiki\//);
      for (const image of entry.images) {
        expect(image.url).toMatch(/^https:\/\/static\.wikia\.nocookie\.net\//);
        expect(image.caption.length).toBeGreaterThan(0);
      }
    }

    for (const quest of catalogQuests) {
      const entry = guides.entries[quest.id];
      expect(entry).toBeDefined();
      if (quest.wikiPageLink && !entry.error) {
        expect(entry.wikiPageLink).toBe(quest.wikiPageLink);
      }
    }
  });

  it("keeps renamed quests attached to their current guide instead of the retired page", async () => {
    const [guides, data] = await Promise.all([
      readJson("public/data/quest-wiki-guides.json"),
      readJson("public/data/tarkov-data.json"),
    ]);
    const secretRecipe = data.quests.find(
      (quest) => quest.bsgId === "64f6aafd67e11a7c6206e0d0",
    );

    expect(secretRecipe).toMatchObject({
      name: "The Secret Recipe",
      wikiPageLink: "https://escapefromtarkov.fandom.com/wiki/The_Secret_Recipe",
    });
    expect(guides.entries[secretRecipe.id]).toMatchObject({
      wikiTitle: "The Secret Recipe",
      wikiPageLink: "https://escapefromtarkov.fandom.com/wiki/The_Secret_Recipe",
      wikiObjectives: [
        expect.stringMatching(/secret ingredient/i),
        expect.stringMatching(/chemical additive/i),
      ],
    });
    expect(guides.entries[secretRecipe.id].guideSummary).not.toMatch(/^\s*[*#-]/);
  });

  it("keeps the Wiki-confirmed location corrections in the app pack", async () => {
    const data = await readJson("public/data/tarkov-data.json");
    const locations = new Map(data.quests.map((quest) => [quest.nameEn, quest.locations]));
    expect(locations.get("Stirrup")).toEqual(["Factory"]);
    expect(locations.get("The Tarkov Import")).toEqual(["Lighthouse", "Reserve"]);
    expect(locations.get("Saving Private Roman")).toEqual(["Woods"]);
    expect(locations.get("Stick to It")).toEqual([
      "Lighthouse",
      "Customs",
      "Shoreline",
      "Woods",
      "Icebreaker",
    ]);
    expect(data.meta.sources.wikiLocationCorrections).toBe(12);
  });

  it("keeps every quest-required item connected to a bundled item record", async () => {
    const data = await readJson("public/data/tarkov-data.json");
    const itemsById = new Map(data.items.map((item) => [item.id, item]));
    const requiredItems = data.quests.flatMap((quest) => quest.requiredItems);

    expect(requiredItems).not.toHaveLength(0);
    for (const requirement of requiredItems) {
      const item = itemsById.get(requirement.itemId);
      expect(item).toBeDefined();
      expect(item.nameEn).toBeTruthy();
      expect(item.wikiPageLink || item.bsgId).toBeTruthy();
    }

    expect(data.items.find((item) => item.name === "Arena advertisement poster")?.wikiPageLink).toBe(
      "https://escapefromtarkov.fandom.com/wiki/Arena_advertisement_poster",
    );
  });

  it("does not ship retired quest URLs after Wiki link correction", async () => {
    const [guides, data] = await Promise.all([
      readJson("public/data/quest-wiki-guides.json"),
      readJson("public/data/tarkov-data.json"),
    ]);
    const byName = new Map(data.quests.map((quest) => [quest.nameEn, quest]));

    expect(byName.get("Oil Run")).toMatchObject({
      wikiPageLink: "https://escapefromtarkov.fandom.com/wiki/Oil_Run",
    });
    expect(byName.get("Oil Run").nameAliases).toContain("BP Depot");
    expect(byName.get("Gunsmith - Model 870")).toMatchObject({
      wikiPageLink: "https://escapefromtarkov.fandom.com/wiki/Gunsmith_-_Model_870",
    });
    expect(byName.get("New Paths")).toMatchObject({
      wikiPageLink: "https://escapefromtarkov.fandom.com/wiki/New_Paths",
    });
    expect(byName.get("The Huntsman Path - Angry Watchman")).toMatchObject({
      wikiPageLink: "https://escapefromtarkov.fandom.com/wiki/The_Huntsman_Path_-_Angry_Watchman",
    });
    expect(byName.get("Charity")).toMatchObject({
      wikiPageLink: "https://escapefromtarkov.fandom.com/wiki/Charity",
    });
    expect(byName.get("Charity").nameAliases).toContain("Painkiller");
    expect(guides.entries[byName.get("Charity").id]).toMatchObject({
      wikiPageLink: "https://escapefromtarkov.fandom.com/wiki/Charity",
    });
    expect(data.meta.sources.wikiLinkUnverifiedQuests).toBe(0);
  });

  it("uses verified legacy pages and mode-neutral Arena links in every catalog", async () => {
    const data = await readJson("public/data/tarkov-data.json");
    const catalogs = [data.quests, data.questCatalogs.pve, data.questCatalogs.pvpSeason];

    for (const quests of catalogs) {
      expect(quests.find((quest) => quest.nameEn === "Mall Cop")?.wikiPageLink).toBe(
        "https://escapefromtarkov.fandom.com/wiki/Gendarmerie_-_Mall_Cop",
      );
      expect(quests.find((quest) => quest.nameEn === "Tickets, Please")?.wikiPageLink).toBe(
        "https://escapefromtarkov.fandom.com/wiki/Gendarmerie_-_Tickets%2C_Please",
      );
      expect(quests.find((quest) => quest.nameEn === "Demonstration Model")?.wikiPageLink).toBe(
        "https://escapefromtarkov.fandom.com/wiki/Demonstration_Model",
      );
    }

    expect(data.questCatalogs.pve
      .find((quest) => quest.nameEn === "Arena Business [PVE ZONE]")?.wikiPageLink).toBe(
      "https://escapefromtarkov.fandom.com/wiki/Arena_Business",
    );
  });

  it("keeps guide entries in the deterministic quest-pack order", async () => {
    const [guides, data] = await Promise.all([
      readJson("public/data/quest-wiki-guides.json"),
      readJson("public/data/tarkov-data.json"),
    ]);
    expect(Object.keys(guides.entries).slice(0, 25)).toEqual(
      data.quests.slice(0, 25).map((quest) => quest.id),
    );
  });
});
