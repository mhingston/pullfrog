export type AzureReviewSeverity = "critical" | "high" | "medium" | "low";

export interface AzureReviewFinding {
  severity: AzureReviewSeverity;
  title: string;
  body: string;
  path?: string | undefined;
  line?: number | undefined;
}

export interface AzureStructuredReview {
  summary: string;
  findings: AzureReviewFinding[];
}

export interface AzureInlineFinding {
  path: string;
  line: number;
  body: string;
}

const SEVERITIES = new Set<AzureReviewSeverity>(["critical", "high", "medium", "low"]);

function unwrapJson(raw: string): string {
  const trimmed = raw.trim();
  const fenced = trimmed.match(/^\`\`\`(?:json)?\s*([\s\S]*?)\s*\`\`\`$/i);
  return (fenced?.[1] ?? trimmed).trim();
}

export function parseAzureStructuredReview(raw: string): AzureStructuredReview {
  let value: unknown;
  try {
    value = JSON.parse(unwrapJson(raw));
  } catch (error) {
    throw new Error(
      "OpenCode returned invalid structured review JSON: " +
        (error instanceof Error ? error.message : String(error))
    );
  }

  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("OpenCode structured review must be a JSON object");
  }

  const record = value as Record<string, unknown>;
  const summary = typeof record.summary === "string" ? record.summary.trim() : "";
  if (!summary) throw new Error("OpenCode structured review is missing a non-empty summary");

  if (!Array.isArray(record.findings)) {
    throw new Error("OpenCode structured review findings must be an array");
  }
  if (record.findings.length > 50) {
    throw new Error("OpenCode structured review returned more than 50 findings");
  }

  const findings = record.findings.map((candidate, index): AzureReviewFinding => {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
      throw new Error("finding " + (index + 1) + " must be an object");
    }
    const finding = candidate as Record<string, unknown>;
    const severity = typeof finding.severity === "string" ? finding.severity : "";
    if (!SEVERITIES.has(severity as AzureReviewSeverity)) {
      throw new Error("finding " + (index + 1) + " has invalid severity");
    }
    const title = typeof finding.title === "string" ? finding.title.trim() : "";
    const body = typeof finding.body === "string" ? finding.body.trim() : "";
    if (!title || !body) {
      throw new Error("finding " + (index + 1) + " must include title and body");
    }

    const rawPath = typeof finding.path === "string" ? finding.path.trim() : "";
    const rawLine = finding.line;
    const hasPath = Boolean(rawPath);
    const hasLine = Number.isInteger(rawLine) && Number(rawLine) > 0;
    if (hasPath !== hasLine) {
      throw new Error(
        "finding " + (index + 1) + " must provide both path and positive line, or neither"
      );
    }

    return {
      severity: severity as AzureReviewSeverity,
      title,
      body,
      ...(hasPath
        ? {
            path: rawPath.replace(/^\/+/, ""),
            line: Number(rawLine),
          }
        : {}),
    };
  });

  return { summary, findings };
}

function locationLabel(finding: AzureReviewFinding): string {
  return finding.path && finding.line ? " — \`" + finding.path + ":" + finding.line + "\`" : "";
}

export function renderAzureReviewMarkdown(
  review: AzureStructuredReview,
  params: { truncatedDiff: boolean }
): string {
  const sections = [
    "## Pullfrog review",
    "",
    ...(params.truncatedDiff
      ? [
          "> ⚠️ **Partial review:** the PR diff exceeded Pullfrog's context cap, so later changes were omitted. The merge-gating status is an error, never green, for a partial review.",
          "",
        ]
      : []),
    review.summary,
  ];

  if (review.findings.length === 0) {
    sections.push("", "✅ No blocking issues found.");
  } else {
    sections.push("", "### Findings");
    for (const finding of review.findings) {
      sections.push(
        "",
        "**" + finding.severity.toUpperCase() + " — " + finding.title + "**" + locationLabel(finding),
        "",
        finding.body
      );
    }
  }

  return sections.join("\n");
}

export function azureReviewStatus(
  review: AzureStructuredReview,
  params: { truncatedDiff: boolean }
): { state: "succeeded" | "failed" | "error"; description: string } {
  if (params.truncatedDiff) {
    return {
      state: "error",
      description: "Pullfrog review was partial because the PR diff exceeded the context cap.",
    };
  }
  if (review.findings.length > 0) {
    return {
      state: "failed",
      description:
        "Pullfrog found " +
        review.findings.length +
        " actionable issue" +
        (review.findings.length === 1 ? "." : "s."),
    };
  }
  return {
    state: "succeeded",
    description: "Pullfrog found no actionable issues.",
  };
}

function rightSideLines(diff: string): Map<string, Set<number>> {
  const linesByFile = new Map<string, Set<number>>();
  let path: string | undefined;
  let newLine = 0;

  for (const line of diff.split("\n")) {
    if (line.startsWith("+++ ")) {
      const raw = line.slice(4).trim();
      path = raw === "/dev/null" ? undefined : raw.replace(/^b\//, "").replace(/^\/+/, "");
      if (path && !linesByFile.has(path)) linesByFile.set(path, new Set());
      continue;
    }

    const hunk = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunk) {
      newLine = Number(hunk[1]);
      continue;
    }
    if (!path || newLine <= 0) continue;

    if (line.startsWith("+") && !line.startsWith("+++")) {
      linesByFile.get(path)?.add(newLine);
      newLine += 1;
    } else if (line.startsWith("-") && !line.startsWith("---")) {
      // Removed lines exist only on the left side.
    } else if (line.startsWith(" ")) {
      linesByFile.get(path)?.add(newLine);
      newLine += 1;
    } else if (!line.startsWith("\\")) {
      // Be conservative around unexpected patch syntax.
      newLine += 1;
    }
  }

  return linesByFile;
}

export function azureInlineFindings(
  review: AzureStructuredReview,
  diff: string
): AzureInlineFinding[] {
  const linesByFile = rightSideLines(diff);
  const seen = new Set<string>();
  const inline: AzureInlineFinding[] = [];

  for (const finding of review.findings) {
    if (!finding.path || !finding.line) continue;
    const path = finding.path.replace(/^\/+/, "");
    if (!linesByFile.get(path)?.has(finding.line)) continue;

    // Azure owns one Pullfrog thread per right-side location. If the model
    // emits two findings for the same line, keep the first rather than creating
    // unstable duplicate threads across reruns.
    const key = path + ":" + finding.line;
    if (seen.has(key)) continue;
    seen.add(key);

    inline.push({
      path,
      line: finding.line,
      body:
        "**" +
        finding.severity.toUpperCase() +
        " — " +
        finding.title +
        "**\n\n" +
        finding.body,
    });
  }

  return inline;
}
