#!/usr/bin/env node

import * as p from "@clack/prompts";
import chalk from "chalk";
import dotenv from "dotenv";
import fs from "node:fs";
import process from "node:process";
import { execSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { generateReviewAndCommit } from "../src/ai.js";
import { getFileDiff, editCommitMessage } from "../src/git.js";
import { I18n } from "../src/i18n.js";
import { printTitle } from "../src/ui.js";
import { handleCancel, wrapText, boxMessage } from "../src/utils.js";

// Load .env — try CWD first (per-repo usage), then package root (dev)
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.join(__dirname, "..");
dotenv.config();
dotenv.config({ path: path.join(packageRoot, ".env") });

// Default Korean; pass --lang=en or -e for English
const args = process.argv.slice(2);
const lang = args.includes("--lang=en") || args.includes("-e") ? "en" : "ko";
const i18n = new I18n(lang);

function removeHeyItem(item) {
  if (!fs.existsSync(item.filePath)) return false;

  const content = fs.readFileSync(item.filePath, "utf-8");
  const lines = content.split("\n");
  let targetIdx = -1;

  if (item.contextLine) {
    targetIdx = lines.findIndex((l) => l.includes(item.contextLine.trim()));
  }

  if (targetIdx === -1 && item.lineNumber) {
    const num = parseInt(item.lineNumber);
    if (!isNaN(num) && num >= 1 && num <= lines.length) {
      targetIdx = num - 1;
    }
  }

  if (targetIdx === -1) return false;

  lines.splice(targetIdx, 1);
  fs.writeFileSync(item.filePath, lines.join("\n"));
  return true;
}

async function main() {
  printTitle(i18n);

  if (!process.env.GEMINI_API_KEY) {
    p.cancel(i18n.t("errors.no_api_key"));
    process.exit(1);
  }

  // 1. STAGE CHECK
  try {
    const stagedCheck = execSync("git diff --staged --name-only")
      .toString()
      .trim();
    if (!stagedCheck) {
      const statusCheck = execSync("git status --porcelain").toString().trim();
      if (!statusCheck) {
        p.cancel(i18n.t("errors.nothing_to_commit"));
        process.exit(0);
      }

      p.log.warn(i18n.t("errors.no_staged"));
      const shouldStage = handleCancel(
        await p.confirm({
          message: i18n.t("errors.stage_all_confirm"),
          initialValue: true,
        }),
        i18n
      );

      if (shouldStage) {
        const s = p.spinner();
        s.start(i18n.t("ui.re_stage_info"));
        execSync("git add .");
        s.stop(chalk.green("Staged!"));
      } else {
        p.cancel(i18n.t("common.cancelled"));
        process.exit(0);
      }
    }
  } catch (e) {
    p.cancel(i18n.t("common.error") + ": " + e.message);
    process.exit(1);
  }

  // 2. GET DIFF
  const stagedFiles = execSync("git diff --staged --name-only")
    .toString()
    .trim()
    .split("\n");
  let fullDiff = "";
  for (const file of stagedFiles) {
    if (!file) continue;
    fullDiff += `File: ${file}\n`;
    fullDiff += getFileDiff(file);
    fullDiff += "\n\n";
  }

  // 3. AI ANALYSIS
  const s = p.spinner();
  s.start(i18n.t("ui.analyzing"));

  let result;
  try {
    result = await generateReviewAndCommit(fullDiff, i18n);
  } catch (e) {
    s.stop(chalk.red("Error"));

    let displayMsg = e.message || "";
    if (
      displayMsg.includes("429") ||
      displayMsg.includes("Too Many Requests")
    ) {
      const match = displayMsg.match(
        /(\[429 Too Many Requests\].*?)(?=\s*\[\{"@type")/s
      );
      if (match && match[1]) displayMsg = match[1].trim();
      else displayMsg = displayMsg.split('[{"@type"')[0].trim();
    } else {
      const statusMatch = displayMsg.match(
        /\[(4\d{2}|5\d{2})\s+.*?\](.*?)(?=\[|\n|$)/s
      );
      if (statusMatch) displayMsg = statusMatch[0].trim();
    }

    p.note(chalk.red(wrapText(displayMsg, 0, process)), "AI Error");
    process.exit(1);
  }

  s.stop(chalk.green(i18n.t("common.done")));

  const { commitMessage, review } = result;
  let currentMessage = commitMessage;

  // 4. CRITICAL ISSUES — block commit
  if (review?.critical?.length > 0) {
    console.log("");
    p.log.error(chalk.bold.red(i18n.t("ui.critical_issues")));
    review.critical.forEach((c) => {
      const loc = `[${c.filePath}:${c.lineNumber || "?"}]`;
      console.log(chalk.red(` ${loc} ${c.message}`));
    });
    console.log("");
    p.cancel(i18n.t("ui.critical_block"));
    process.exit(1);
  }

  // 5. HEY! ISSUES — warn only
  let heyItems = [...(review?.hey || [])];

  if (heyItems.length > 0) {
    console.log("");
    p.log.warn(chalk.bgYellow.black(i18n.t("ui.hey_issues")));
    console.log("");
    heyItems.forEach((c) => {
      const loc = `[${c.filePath}:${c.lineNumber || "?"}]`;
      console.log(chalk.bgYellow.black(` ${loc} `));
      if (c.contextLine) {
        console.log(chalk.dim(`  ${c.contextLine.trim()}`));
      }
      console.log(
        chalk.yellow(wrapText(c.message, process.stdout.columns - 8, process))
      );
      console.log("");
    });
  }

  // 6. ACTION LOOP
  while (true) {
    console.log("");
    console.log(
      boxMessage(i18n.t("ui.title_fallback").trim(), currentMessage, process)
    );

    const options = [
      { value: "commit", label: i18n.t("ui.action_commit") },
    ];

    if (heyItems.length > 0) {
      options.push({
        value: "hey-autofix",
        label: i18n.t("ui.action_hey_autofix"),
      });
    }

    options.push(
      { value: "edit", label: i18n.t("ui.action_edit") },
      { value: "cancel", label: i18n.t("ui.action_cancel") }
    );

    const action = handleCancel(
      await p.select({
        message:
          heyItems.length > 0
            ? i18n.t("ui.hey_confirm")
            : i18n.t("ui.confirm_commit"),
        options,
      }),
      i18n
    );

    if (action === "cancel") {
      p.cancel(i18n.t("common.cancelled"));
      process.exit(0);
    }

    if (action === "commit") {
      // If hey! items exist, ask for confirmation before proceeding
      if (heyItems.length > 0) {
        const proceed = handleCancel(
          await p.confirm({
            message: i18n.t("ui.hey_proceed_confirm"),
            initialValue: false,
          }),
          i18n
        );
        if (!proceed) continue;
      }

      const commitResult = spawnSync("git", ["commit", "-m", currentMessage], {
        stdio: "inherit",
      });
      if (commitResult.status !== 0) {
        p.log.error(i18n.t("errors.commit_failed"));
        process.exit(1);
      }
      p.outro(chalk.green(i18n.t("ui.generated_commit")));
      process.exit(0);
    }

    if (action === "edit") {
      currentMessage = editCommitMessage(currentMessage);
    }

    if (action === "hey-autofix") {
      let removedCount = 0;
      const failedItems = [];

      for (const item of heyItems) {
        if (removeHeyItem(item)) {
          removedCount++;
        } else {
          failedItems.push(item);
        }
      }

      if (removedCount > 0) {
        const stageSpinner = p.spinner();
        stageSpinner.start(i18n.t("ui.re_stage_info"));
        execSync("git add .");
        stageSpinner.stop(chalk.green(`${removedCount}개 항목 자동 제거 완료`));
      }

      if (failedItems.length > 0) {
        p.log.warn(
          `${failedItems.length}개 항목을 자동 제거할 수 없어 건너뜠어요:`
        );
        failedItems.forEach((item) => {
          console.log(
            chalk.dim(
              `  [${item.filePath}:${item.lineNumber || "?"}] ${item.contextLine || ""}`
            )
          );
        });
      }

      heyItems = failedItems;

      // Label says "자동 제거 후 커밋" — commit automatically if all resolved
      if (heyItems.length === 0) {
        console.log("");
        const commitResult = spawnSync("git", ["commit", "-m", currentMessage], {
          stdio: "inherit",
        });
        if (commitResult.status !== 0) {
          p.log.error(i18n.t("errors.commit_failed"));
          process.exit(1);
        }
        p.outro(chalk.green(i18n.t("ui.generated_commit")));
        process.exit(0);
      }
    }
  }
}

main().catch(console.error);
