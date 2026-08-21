import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

async function readJson(relativePath) {
  return JSON.parse(await readFile(path.join(root, relativePath), "utf8"));
}

describe("Wiki quest guide index", () => {
  it("contains only verified Wiki links and the expected quest coverage", async () => {
    const [guides, data] = await Promise.all([
      readJson("public/data/quest-wiki-guides.json"),
      readJson("public/data/tarkov-data.json"),
    ]);
    expect(guides.schemaVersion).toBe(1);
    expect(guides.questCount).toBe(data.quests.length);
    expect(Object.keys(guides.entries)).toHaveLength(data.quests.length);
    const verified = Object.values(guides.entries).filter((entry) => !entry.error);
    expect(verified.length).toBeGreaterThan(400);
    for (const entry of verified) {
      expect(entry.wikiPageLink).toMatch(/^https:\/\/escapefromtarkov\.fandom\.com\/wiki\//);
      for (const image of entry.images) {
        expect(image.url).toMatch(/^https:\/\/static\.wikia\.nocookie\.net\//);
        expect(image.caption.length).toBeGreaterThan(0);
      }
    }
  });

  it("keeps the Wiki-confirmed location corrections in the app pack", async () => {
    const data = await readJson("public/data/tarkov-data.json");
    const locations = new Map(data.quests.map((quest) => [quest.nameEn, quest.locations]));
    expect(locations.get("Stirrup")).toEqual(["Factory"]);
    expect(locations.get("The Tarkov Import")).toEqual(["Lighthouse", "Reserve"]);
    expect(locations.get("Saving Private Roman")).toEqual(["Woods", "Lighthouse"]);
    expect(locations.get("Stick to It")).toEqual(["Lighthouse"]);
    expect(data.meta.sources.wikiLocationCorrections).toBe(5);
  });

  it("keeps every quest-required item connected to a current Wiki page", async () => {
    const data = await readJson("public/data/tarkov-data.json");
    const itemsById = new Map(data.items.map((item) => [item.id, item]));
    const requiredItems = data.quests.flatMap((quest) => quest.requiredItems);

    expect(requiredItems).not.toHaveLength(0);
    for (const requirement of requiredItems) {
      expect(itemsById.get(requirement.itemId)?.wikiPageLink).toMatch(
        /^https:\/\/escapefromtarkov\.fandom\.com\/wiki\//,
      );
    }

    expect(data.items.find((item) => item.name === "Arena poster 1")?.wikiPageLink).toBe(
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
    expect(byName.get("Painkiller")).not.toHaveProperty("wikiPageLink");

    const painkiller = data.quests.find((quest) => quest.nameEn === "Painkiller");
    expect(guides.entries[painkiller.id]).toMatchObject({ error: "NO_WIKI_LINK" });
    expect(data.meta.sources.wikiLinkUnverifiedQuests).toBeGreaterThan(0);
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
