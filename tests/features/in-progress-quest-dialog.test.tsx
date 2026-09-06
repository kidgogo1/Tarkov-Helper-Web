import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { InProgressQuestDialog } from "../../src/features/settings/InProgressQuestDialog";
import type { QuestData } from "../../src/types/data";

function quest(id: string, nameKo: string, overrides: Partial<QuestData> = {}): QuestData {
  return {
    id,
    normalizedName: id,
    name: id,
    nameEn: id,
    nameKo,
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

const root = quest("root", "첫 번째 퀘스트");
const branch = quest("branch", "두 번째 퀘스트", {
  requirements: [{ questId: "root", requirementType: "complete", groupId: 0 }],
});
const target = quest("target", "진행 중인 퀘스트", {
  trader: "Therapist",
  requirements: [{ questId: "branch", requirementType: "complete", groupId: 0 }],
});

describe("InProgressQuestDialog", () => {
  it("previews recursive unfinished prerequisites and applies only those completions", () => {
    const onApply = vi.fn();
    render(
      <InProgressQuestDialog
        onApply={onApply}
        onClose={vi.fn()}
        open
        progress={{ root: "done" }}
        quests={[root, branch, target]}
      />,
    );

    fireEvent.click(screen.getByRole("checkbox", { name: /진행 중인 퀘스트/ }));

    const preview = screen.getByRole("region", { name: "완료할 선행 퀘스트" });
    expect(within(preview).getByText("두 번째 퀘스트")).toBeInTheDocument();
    expect(within(preview).queryByText("첫 번째 퀘스트")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "선행 퀘스트 완료 적용" }));
    expect(onApply).toHaveBeenCalledWith(["target"], ["branch"]);
  });

  it("filters selectable quests by search and trader", () => {
    render(
      <InProgressQuestDialog
        onApply={vi.fn()}
        onClose={vi.fn()}
        open
        progress={{}}
        quests={[root, branch, target]}
      />,
    );

    fireEvent.change(screen.getByRole("combobox", { name: "상인 필터" }), {
      target: { value: "Therapist" },
    });
    expect(screen.getByRole("checkbox", { name: /진행 중인 퀘스트/ })).toBeInTheDocument();
    expect(screen.queryByRole("checkbox", { name: /첫 번째 퀘스트/ })).not.toBeInTheDocument();

    fireEvent.change(screen.getByRole("searchbox", { name: "퀘스트 검색" }), {
      target: { value: "없는 이름" },
    });
    expect(screen.getByText("선택할 수 있는 퀘스트가 없습니다.")).toBeInTheDocument();
  });

  it.each(["Forester’s Duty", "forestersduty", "  Forester's   Duty  "])(
    "finds a quest by its title despite punctuation or spacing: %s",
    (search) => {
      const forester = quest("foresters-duty", "Forester's Duty", {
        name: "Forester's Duty",
        nameEn: "Forester's Duty",
        trader: "Jaeger",
      });
      render(
        <InProgressQuestDialog
          onApply={vi.fn()}
          onClose={vi.fn()}
          open
          progress={{}}
          quests={[forester, root]}
        />,
      );

      fireEvent.change(screen.getByRole("searchbox", { name: "퀘스트 검색" }), {
        target: { value: search },
      });

      expect(screen.getByRole("checkbox", { name: /Forester's Duty/ })).toBeInTheDocument();
      expect(screen.queryByRole("checkbox", { name: /첫 번째 퀘스트/ })).not.toBeInTheDocument();
    },
  );

  it("matches legacy names without bypassing completion or trader filters", () => {
    const aliases = ["사냥꾼의 길 - 구역 확보"];
    const renamed = quest("renamed", "현재 퀘스트 이름", { nameAliases: aliases });
    const completed = quest("completed", "완료된 퀘스트", { nameAliases: aliases });
    const otherTrader = quest("other-trader", "다른 상인의 퀘스트", {
      nameAliases: aliases,
      trader: "Jaeger",
    });
    render(
      <InProgressQuestDialog
        onApply={vi.fn()}
        onClose={vi.fn()}
        open
        progress={{ completed: "done" }}
        quests={[renamed, completed, otherTrader]}
      />,
    );

    fireEvent.change(screen.getByRole("combobox", { name: "상인 필터" }), {
      target: { value: "Prapor" },
    });
    fireEvent.change(screen.getByRole("searchbox", { name: "퀘스트 검색" }), {
      target: { value: "사냥꾼의길—구역확보" },
    });

    expect(screen.getByRole("checkbox", { name: /현재 퀘스트 이름/ })).toBeInTheDocument();
    expect(screen.queryByRole("checkbox", { name: /완료된 퀘스트/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("checkbox", { name: /다른 상인의 퀘스트/ })).not.toBeInTheDocument();
  });
});
