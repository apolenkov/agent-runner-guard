import { RuleConfigSeverity, type UserConfig } from "@commitlint/types";

const config: UserConfig = {
  extends: ["@commitlint/config-conventional"],
  // Dependabot writes "chore(deps-dev): Bump ..." (scope and case outside the
  // rules below); its commits carry this trailer.
  ignores: [
    (message: string): boolean =>
      message.includes("Signed-off-by: dependabot[bot]"),
  ],
  rules: {
    "scope-enum": [
      RuleConfigSeverity.Error,
      "always",
      [
        "watchdog",
        "hook",
        "pi-alert",
        "devin",
        "repo",
        "deps",
        "ci",
        "readme",
        "main",
      ],
    ],
  },
};

export default config;
