import { copyFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";

const outputDirectory = resolve("dist");
const releaseDocuments = ["LICENSE", "README.md", "THIRD_PARTY_NOTICES.md"];

mkdirSync(outputDirectory, { recursive: true });

for (const filename of releaseDocuments) {
  copyFileSync(resolve(filename), resolve(outputDirectory, filename));
}
