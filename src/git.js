import { spawnSync, execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { IGNORE_PATTERNS, BINARY_EXTENSIONS } from "./config.js";

export function getFileDiff(filePath) {
  try {
    // Check if binary or huge
    const ext = path.extname(filePath).toLowerCase();
    if (BINARY_EXTENSIONS.includes(ext)) {
      return `(Binary file: ${filePath})`;
    }
    if (IGNORE_PATTERNS.some((p) => filePath.includes(p))) {
      return `(Ignored file: ${filePath})`;
    }

    // Use -- to separate paths from revisions (fixes ambiguity if file is deleted)
    const diff = execSync(`git diff --staged -- "${filePath}"`, {
      encoding: "utf-8",
    });
    return diff || `(No content change or new empty file: ${filePath})`;
  } catch (e) {
    return `(Error reading diff for ${filePath}: ${e.message})`;
  }
}

export function getCommentSyntax(filePath, message) {
  const ext = path.extname(filePath).toLowerCase();
  const content = `TODO: [AI] ${message}`;

  // Hash style
  if (
    [".yml", ".yaml", ".py", ".sh", ".rb", ".dockerfile", ".toml"].includes(ext)
  ) {
    return `# ${content}`;
  }
  // CSS style
  if ([".css", ".scss", ".less", ".saas"].includes(ext)) {
    return `/* ${content} */`;
  }
  // HTML style
  if ([".html", ".xml", ".md", ".jsx", ".tsx"].includes(ext)) {
    if (ext === ".md") return `<!-- ${content} -->`; // MD specific
    // return `<!-- ${content} -->`; // HTML specific
  }
  // C-style (Default)
  return `// ${content}`;
}

export function editCommitMessage(initialMessage) {
  const tempFile = path.join(process.cwd(), ".COMMIT_EDITMSG_TEMP");
  fs.writeFileSync(tempFile, initialMessage);
  const editor = process.env.EDITOR || "vim";
  try {
    spawnSync(editor, [tempFile], { stdio: "inherit" });
    if (fs.existsSync(tempFile)) {
      const newMessage = fs.readFileSync(tempFile, "utf-8").trim();
      fs.unlinkSync(tempFile);
      return newMessage;
    }
    return initialMessage;
  } catch (e) {
    console.error("❌ Editor error:", e.message);
    return initialMessage;
  }
}
