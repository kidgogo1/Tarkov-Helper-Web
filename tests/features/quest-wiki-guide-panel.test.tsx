import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { QuestWikiGuidePanel } from "../../src/features/quests/QuestWikiGuidePanel";
import type { QuestData, QuestWikiGuide } from "../../src/types/data";

const quest: QuestData = {
  id: "quest-a",
  name: "A Fuel Matter",
  nameEn: "A Fuel Matter",
  normalizedName: "a-fuel-matter",
  trader: "Ragman",
  locations: ["Reserve"],
  kappaRequired: true,
  requirements: [],
  alternativeQuestIds: [],
  followUpQuestIds: [],
  objectives: [
    {
      id: "objective-a",
      sortOrder: 0,
      objectiveType: "mark",
      description: "Mark the first group of fuel tanks with an MS2000 Marker on Reserve",
      requiresFir: false,
      mapName: "Reserve",
      locationPoints: [],
      optionalPoints: [],
    },
  ],
  requiredItems: [],
  wikiPageLink: "https://escapefromtarkov.fandom.com/wiki/A_Fuel_Matter",
};

const guide: QuestWikiGuide = {
  wikiTitle: "A Fuel Matter",
  wikiPageLink: quest.wikiPageLink!,
  wikiRevisionId: 123,
  wikiLocation: ["Reserve"],
  wikiObjectives: ["Mark the first group of fuel tanks with an MS2000 Marker on Reserve"],
  guideSummary: "Find and mark two groups of fuel tanks on Reserve.",
  images: [
    {
      url: "https://static.wikia.nocookie.net/escapefromtarkov_gamepedia/images/example.png",
      caption: "Fuel tanks marked on map",
    },
  ],
};

describe("QuestWikiGuidePanel", () => {
  it("shows verified location, comparison, summary, and Wiki images", () => {
    render(<QuestWikiGuidePanel guide={guide} language="en" quest={quest} />);

    expect(screen.getByRole("region", { name: "Wiki location verification" })).toBeInTheDocument();
    expect(screen.getByText("Matched")).toBeInTheDocument();
    expect(screen.getByText("1/1")).toBeInTheDocument();
    expect(screen.getByText("Find and mark two groups of fuel tanks on Reserve.")).toBeInTheDocument();
    expect(screen.getByRole("img", { name: "Fuel tanks marked on map" })).toHaveAttribute("loading", "lazy");
    expect(screen.getByRole("link", { name: /Open Wiki source/ })).toHaveAttribute("href", guide.wikiPageLink);
  });

  it("fails closed when a page cannot be verified", () => {
    render(<QuestWikiGuidePanel guide={{ ...guide, error: "HTTP_429" }} language="ko" quest={quest} />);

    expect(screen.getByText("확인되지 않음")).toBeInTheDocument();
    expect(screen.getByText(/위키 페이지를 읽지 못했습니다/)).toBeInTheDocument();
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
  });
});
