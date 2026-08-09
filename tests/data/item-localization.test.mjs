// @vitest-environment node

import { describe, expect, it } from "vitest";

import { localizeItemData } from "../../scripts/item-localization.mjs";

describe("item localization", () => {
  it("uses a matching Fandom page to add Korean and English item names", () => {
    const data = {
      items: [{
        id: "legacy-m4",
        name: "Colt M4A1 5.56x45 assault rifle",
        nameEn: "Colt M4A1 5.56x45 assault rifle",
        nameKo: "Colt M4A1 5.56x45 assault rifle",
        wikiPageLink: "https://escapefromtarkov.fandom.com/wiki/Colt_M4A1_5.56x45_assault_rifle",
      }],
    };
    const catalog = {
      items: [{
        nameEn: "Colt M4A1 5.56x45 assault rifle",
        nameKo: "Colt M4A1 5.56x45 \uB3CC\uACA9\uC18C\uCD1D",
        shortNameEn: "M4A1",
        shortNameKo: "M4A1",
        wikiLink: "https://escapefromtarkov.fandom.com/wiki/Colt_M4A1_5.56x45_assault_rifle",
      }],
    };

    expect(localizeItemData(data, catalog)).toEqual({ matched: 1, changed: 1 });
    expect(data.items[0]).toMatchObject({
      nameEn: "Colt M4A1 5.56x45 assault rifle",
      nameKo: "Colt M4A1 5.56x45 \uB3CC\uACA9\uC18C\uCD1D",
      shortNameEn: "M4A1",
      shortNameKo: "M4A1",
    });
  });

  it("leaves an item unchanged when the catalog has no unambiguous page match", () => {
    const data = {
      items: [{
        id: "legacy-key",
        name: "Dorm room 214 key",
        nameEn: "Dorm room 214 key",
        nameKo: "Dorm room 214 key",
        wikiPageLink: "https://escapefromtarkov.fandom.com/wiki/Dorm_room_214_key",
      }],
    };

    expect(localizeItemData(data, { items: [] })).toEqual({ matched: 0, changed: 0 });
    expect(data.items[0].nameKo).toBe("Dorm room 214 key");
  });
});
