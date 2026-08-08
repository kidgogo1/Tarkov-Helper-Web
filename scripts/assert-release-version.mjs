import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { assertReleaseContext } from "./release-utils.mjs";

function parseArguments(argv) {
  const values = {};
  const booleanOptions = new Set(["--require-repository"]);
  const valueOptions = new Map([
    ["--project-root", "projectRoot"],
    ["--tag", "tag"],
    ["--commit", "commit"],
    ["--repository", "repository"],
  ]);

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (booleanOptions.has(argument)) {
      if (values.requireRepository) throw new Error(`Duplicate argument: ${argument}`);
      values.requireRepository = true;
      continue;
    }
    const key = valueOptions.get(argument);
    const value = argv[index + 1];
    if (!key || !value || value.startsWith("--")) throw new Error(`Unknown or incomplete argument: ${argument}`);
    if (values[key] !== undefined) throw new Error(`Duplicate argument: ${argument}`);
    values[key] = value;
    index += 1;
  }
  return values;
}

export async function runAssertReleaseVersion(argv = process.argv.slice(2)) {
  const values = parseArguments(argv);
  const projectRoot = path.resolve(values.projectRoot ?? path.resolve(import.meta.dirname, ".."));
  const context = await assertReleaseContext({ ...values, projectRoot });
  return {
    commit: context.commit,
    repository: context.repository,
    tag: context.tag,
    version: context.version,
  };
}

const isCommandLine = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isCommandLine) {
  try {
    const result = await runAssertReleaseVersion();
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    process.stderr.write(`Release version check failed: ${error?.message ?? error}\n`);
    process.exitCode = 1;
  }
}
