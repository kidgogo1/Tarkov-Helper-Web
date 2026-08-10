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
    expect(data.meta.sources.wikiLocationCorrections).toBe(4);
  });
});
