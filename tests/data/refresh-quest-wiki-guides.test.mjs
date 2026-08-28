import { execFile } from "node:child_process";
import { copyFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const root = path.resolve(import.meta.dirname, "../..");
const refreshScript = path.join(root, "scripts", "refresh-quest-wiki-guides.mjs");
const currentGuides = path.join(root, "public", "data", "quest-wiki-guides.json");

async function runRefresh(extraArguments = []) {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "quest-wiki-refresh-test-"));
  const output = path.join(temporary, "quest-wiki-guides.json");
  const counter = path.join(temporary, "fetch-count.txt");
  const preload = path.join(temporary, "mock-fetch.mjs");
  await copyFile(currentGuides, output);
  await writeFile(preload, `
    import { appendFileSync } from "node:fs";
    globalThis.fetch = async (url) => {
      appendFileSync(process.env.WIKI_FETCH_COUNTER, "1\\n", "utf8");
      const page = new URL(url).searchParams.get("page") || "Test quest";
      return {
        ok: true,
        status: 200,
        async json() {
          return {
            parse: {
              title: page,
              revid: 123,
              wikitext: "== Objectives ==\\n* Inspect the current page\\n\\n== Guide ==\\nThis current guide summary is long enough to be retained after a live refresh.",
              text: "",
            },
          };
        },
      };
    };
  `, "utf8");

  try {
    const result = await execFileAsync(process.execPath, [
      "--import",
      pathToFileURL(preload).href,
      refreshScript,
      "--output",
      output,
      ...extraArguments,
    ], {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env, WIKI_FETCH_COUNTER: counter },
      maxBuffer: 8 * 1024 * 1024,
      timeout: 30_000,
    });
    const fetchCount = await readFile(counter, "utf8")
      .then((value) => value.trim().split(/\r?\n/).filter(Boolean).length)
      .catch((error) => {
        if (error?.code === "ENOENT") return 0;
        throw error;
      });
    return { fetchCount, report: JSON.parse(result.stdout) };
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

describe("Wiki guide refresh cache policy", () => {
  it("checks current Wiki pages by default even when every cached guide is reusable", async () => {
    const { fetchCount, report } = await runRefresh();

    expect(report.fetchedPages).toBeGreaterThan(0);
    expect(fetchCount).toBe(report.fetchedPages);
    expect(report.reused).toBe(0);
  });

  it("reuses verified cached pages only when explicitly requested", async () => {
    const { fetchCount, report } = await runRefresh(["--reuse-verified"]);

    expect(report.fetchedPages).toBe(0);
    expect(fetchCount).toBe(0);
    expect(report.reused).toBeGreaterThan(0);
  });
});
