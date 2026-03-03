#!/usr/bin/env node

import * as p from "@clack/prompts";
import chalk from "chalk";
import dotenv from "dotenv";
import process from "node:process";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { generatePRDescription } from "../src/ai.js";
import { I18n } from "../src/i18n.js";
import { printTitle } from "../src/ui.js";
import { handleCancel, boxMessage } from "../src/utils.js";

// Load .env — try CWD first (per-repo usage), then package root (dev)
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.join(__dirname, "..");
dotenv.config();
dotenv.config({ path: path.join(packageRoot, ".env") });

const args = process.argv.slice(2);
const lang = args.includes("--lang=en") || args.includes("-e") ? "en" : "ko";
const i18n = new I18n(lang);

async function main() {
  printTitle(i18n);

  if (!process.env.GEMINI_API_KEY) {
    p.cancel(i18n.t("errors.no_api_key"));
    process.exit(1);
  }

  // 1. Get current branch name
  let branch;
  try {
    branch = execSync("git branch --show-current").toString().trim();
  } catch (e) {
    p.cancel("Git 브랜치를 가져올 수 없어요: " + e.message);
    process.exit(1);
  }

  if (!branch) {
    p.cancel("현재 브랜치를 확인할 수 없어요. detached HEAD 상태인지 확인하세요.");
    process.exit(1);
  }

  // 2. Extract ticket ID from branch name (e.g. SAK-2838/feature-name → SAK-2838)
  const ticketMatch = branch.match(/^([A-Z]+-\d+)\//);
  if (!ticketMatch) {
    p.cancel(
      `브랜치명 '${branch}'에서 티켓 ID를 찾을 수 없어요.\n예상 형식: SAK-1234/branch-description`
    );
    process.exit(1);
  }
  const ticketId = ticketMatch[1];

  // 3. Get commits since main/master
  let commits = "";
  const bases = ["main", "master"];
  for (const base of bases) {
    try {
      const out = execSync(`git log ${base}..HEAD --oneline`).toString().trim();
      if (out) {
        commits = out;
        break;
      }
    } catch (_) {
      // try next base branch
    }
  }

  if (!commits) {
    p.cancel("베이스 브랜치(main/master) 대비 새 커밋이 없어요.");
    process.exit(0);
  }

  // 4. Generate PR description with AI
  const s = p.spinner();
  s.start("PR 설명 생성 중...");

  let prResult;
  try {
    prResult = await generatePRDescription(commits, ticketId);
  } catch (e) {
    s.stop(chalk.red("Error"));
    p.cancel("PR 설명 생성 실패: " + e.message);
    process.exit(1);
  }

  s.stop(chalk.green("완료! 🥥"));

  const prTitle = `[${ticketId}] ${prResult.title}`;
  const prBodyLines = [`[${ticketId}]`, ...prResult.items.map((item) => `- ${item}`)];
  const prBody = prBodyLines.join("\n");

  // 5. Show preview
  console.log("");
  console.log(boxMessage("PR TITLE", prTitle, process));
  console.log("");
  console.log(boxMessage("PR BODY", prBody, process));
  console.log("");

  // 6. Confirm
  const confirm = handleCancel(
    await p.confirm({
      message: "이 내용으로 PR을 생성할까요?",
      initialValue: true,
    }),
    i18n
  );

  if (!confirm) {
    p.cancel(i18n.t("common.cancelled"));
    process.exit(0);
  }

  // 7. Check gh CLI is available
  try {
    execSync("gh --version", { stdio: "ignore" });
  } catch (_) {
    p.cancel(
      "GitHub CLI(gh)가 설치되지 않았어요.\nhttps://cli.github.com 에서 설치 후 다시 시도하세요."
    );
    process.exit(1);
  }

  // 8. Create PR
  try {
    const { spawnSync } = await import("node:child_process");
    const result = spawnSync(
      "gh",
      ["pr", "create", "--title", prTitle, "--body", prBody],
      { stdio: "inherit" }
    );
    if (result.status !== 0) {
      p.cancel("PR 생성에 실패했어요. gh 로그인 상태를 확인하세요.");
      process.exit(1);
    }
    p.outro(chalk.green("PR이 생성됐어요! 🥥"));
  } catch (e) {
    p.cancel("PR 생성 실패: " + e.message);
    process.exit(1);
  }
}

main().catch(console.error);
