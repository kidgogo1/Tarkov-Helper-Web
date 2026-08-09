import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { afterEach, expect, it } from "vitest";

afterEach(() => {
  globalThis.document.head.replaceChildren();
  globalThis.document.body.replaceChildren();
});

it("keeps quest search text clear of its icon after global input styles load", () => {
  const style = globalThis.document.createElement("style");
  style.textContent = [
    readFileSync(resolve("src/styles/quests.css"), "utf8"),
    readFileSync(resolve("src/styles/global.css"), "utf8"),
  ].join("\n");
  globalThis.document.head.append(style);

  const search = globalThis.document.createElement("div");
  search.className = "quest-search";
  search.innerHTML = '<input type="search" placeholder="퀘스트 이름 검색">';
  globalThis.document.body.append(search);

  expect(globalThis.getComputedStyle(search.querySelector("input")).paddingLeft).toBe("32px");
});
