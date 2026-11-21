import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { digest } from "./artifacts.js";
import { PROJECT_ROOT } from "./paths.js";
export type WorkingProfile = {
  version: string;
  sourceText: string;
  sourceRequirementsDigest: string;
  clauses: Array<{ id: string; quote: string; checker?: string }>;
  [key: string]: unknown;
};
/** Exact source profiles prevent another document's wording from silently becoming this contract. */
export async function workingProfile(
  sourceText: string | undefined,
  year: number,
): Promise<WorkingProfile> {
  const names = ["yishengchang-v002", "controlled-v001"];
  const profiles = await Promise.all(
    names.map(
      async (name) =>
        JSON.parse(
          await readFile(
            resolve(PROJECT_ROOT, `config/interpretations/${name}.json`),
            "utf8",
          ),
        ) as WorkingProfile,
    ),
  );
  for (const profile of profiles)
    if (
      digest(profile.sourceText) !== profile.sourceRequirementsDigest ||
      profile.clauses.some((c) => !profile.sourceText.includes(c.quote))
    )
      throw new Error("Working interpretation source quote or digest mismatch");
  if (sourceText === undefined) return profiles[1];
  const matched = profiles.find(
    (p) => p.sourceRequirementsDigest === digest(sourceText),
  );
  if (matched) return matched;
  const controlled = profiles[1],
    prefix = controlled.sourceText.trimEnd();
  if (sourceText.startsWith(prefix)) {
    const additions = sourceText
      .slice(prefix.length)
      .trim()
      .split(/\r?\n/)
      .filter(Boolean);
    if (additions.length === 1) {
      const rule = additions[0].match(
        /^Version 002: missing-year dates use frozen runYear (20\d\d)\.$/,
      );
      if (rule && Number(rule[1]) === year)
        return {
          ...controlled,
          version: `controlled-v002-year-${year}`,
          sourceText,
          sourceRequirementsDigest: digest(sourceText),
          clauses: [
            ...controlled.clauses,
            {
              id: "declared-year",
              quote: additions[0],
              checker: "etdPriority",
            },
          ],
        };
    }
  }
  return {
    version: `unmapped-${digest(sourceText).slice(0, 12)}`,
    sourceText,
    sourceRequirementsDigest: digest(sourceText),
    clauses: [{ id: "UNMAPPED_REQUIREMENTS", quote: sourceText }],
    unsupported: true,
  };
}
