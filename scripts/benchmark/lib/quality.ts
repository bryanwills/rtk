/**
 * AI Comprehension Quality Benchmark
 *
 * Validates that RTK's filtered output preserves semantic content
 * by asking an LLM the same questions on raw vs filtered output
 * and comparing answers against ground truth.
 *
 * Supported LLM backends (auto-detected, no API keys needed):
 *   - claude CLI  (OAuth via Claude Code)
 *   - gemini CLI  (Google auth)
 *   - codex CLI   (OpenAI auth)
 *   - ollama      (local, zero auth)
 *
 * Use setLLMBackend() or --llm flag to force a specific backend.
 */

export interface QualityTest {
  name: string;
  rawCmd: string;
  rtkCmd: string;
  /** Question to ask the LLM about the output */
  question: string;
  /** Function to extract ground truth from raw output */
  extractTruth: (raw: string) => string[];
  /** Function to check if the LLM answer contains the truth */
  checkAnswer: (answer: string, truth: string[]) => boolean;
}

export interface QualityResult {
  name: string;
  rawTokens: number;
  rtkTokens: number;
  savings: number;
  rawCorrect: boolean;
  rtkCorrect: boolean;
  /** true = RTK output lets the LLM answer correctly */
  qualityPreserved: boolean;
  rawAnswer: string;
  rtkAnswer: string;
  truth: string[];
}

const results: QualityResult[] = [];

// ── LLM Backend System ──

export type LLMBackend = "claude" | "gemini" | "codex" | "ollama" | "auto";

let forcedBackend: LLMBackend = "auto";
let detectedBackends: string[] | null = null;

/** Force a specific LLM backend. Called from run.ts based on --llm flag. */
export function setLLMBackend(backend: LLMBackend) {
  forcedBackend = backend;
}

/** Detect which LLM CLIs are available on the host machine. */
async function detectBackends(): Promise<string[]> {
  if (detectedBackends) return detectedBackends;
  const { $ } = await import("bun");
  const backends: string[] = [];

  for (const [name, cmd] of [
    ["claude", "claude --version"],
    ["gemini", "gemini --version"],
    ["codex", "codex --version"],
    ["ollama", "ollama --version"],
  ] as const) {
    try {
      const r = await $`${cmd.split(" ")[0]} ${cmd.split(" ").slice(1)}`.quiet().nothrow().timeout(5_000);
      if (r.exitCode === 0) backends.push(name);
    } catch { /* not installed */ }
  }

  detectedBackends = backends;
  console.log(`  LLM backends detected: ${backends.join(", ") || "none"}`);
  return backends;
}

/** Get the list of backends to use for quality tests. */
export async function getActiveBackends(): Promise<string[]> {
  const available = await detectBackends();
  if (forcedBackend !== "auto") {
    if (available.includes(forcedBackend)) return [forcedBackend];
    console.log(`  WARNING: --llm=${forcedBackend} not available, falling back to auto`);
  }
  return available;
}

/**
 * Ask a question to a specific LLM backend via its CLI.
 * All CLIs support piping a prompt and getting text back.
 */
async function askBackend(
  backend: string,
  prompt: string
): Promise<string> {
  const { $ } = await import("bun");
  // Write prompt to a temp file to avoid shell escaping issues
  const tmpFile = `/tmp/rtk-quality-prompt-${Date.now()}.txt`;
  await Bun.write(tmpFile, prompt);

  try {
    let result;
    switch (backend) {
      case "claude":
        result = await $`cat ${tmpFile} | claude -p --model haiku --max-turns 1 --no-session-persistence`
          .quiet().nothrow().timeout(60_000);
        break;
      case "gemini":
        result = await $`cat ${tmpFile} | gemini -p --model gemini-2.0-flash`
          .quiet().nothrow().timeout(60_000);
        break;
      case "codex":
        result = await $`cat ${tmpFile} | codex -p --model o4-mini`
          .quiet().nothrow().timeout(60_000);
        break;
      case "ollama":
        result = await $`ollama run llama3.2 < ${tmpFile}`
          .quiet().nothrow().timeout(120_000);
        break;
      default:
        return `[unknown backend: ${backend}]`;
    }

    // Clean up temp file
    await $`rm -f ${tmpFile}`.quiet().nothrow();

    if (result.exitCode === 0 && result.stdout.toString().trim()) {
      return result.stdout.toString().trim();
    }
    return `[${backend} returned exit ${result.exitCode}]`;
  } catch (e) {
    await $`rm -f ${tmpFile}`.quiet().nothrow();
    return `[${backend} error: ${e}]`;
  }
}

/**
 * Ask an LLM a question about command output.
 * Tries each active backend and returns the first successful response.
 */
async function askLLM(output: string, question: string): Promise<string> {
  // Cap output to ~4000 tokens worth (~16K chars) to avoid blowing budget
  const cappedOutput = output.slice(0, 16_000);
  const prompt = `Here is the output of a development command:\n\n\`\`\`\n${cappedOutput}\n\`\`\`\n\n${question}\n\nAnswer concisely in 1-3 sentences. Only state facts from the output above.`;

  const backends = await getActiveBackends();
  if (backends.length === 0) return "[SKIP: no LLM backend available]";

  // Use first available backend
  return askBackend(backends[0], prompt);
}

/**
 * Ask ALL active backends the same question and return results per backend.
 * Used when --llm=all to compare comprehension across models.
 */
export async function askAllBackends(
  output: string,
  question: string
): Promise<Record<string, string>> {
  const cappedOutput = output.slice(0, 16_000);
  const prompt = `Here is the output of a development command:\n\n\`\`\`\n${cappedOutput}\n\`\`\`\n\n${question}\n\nAnswer concisely in 1-3 sentences. Only state facts from the output above.`;

  const backends = await getActiveBackends();
  const results: Record<string, string> = {};

  // Run all backends in parallel
  await Promise.all(
    backends.map(async (b) => {
      results[b] = await askBackend(b, prompt);
    })
  );

  return results;
}

function countWords(text: string): number {
  return text.split(/\s+/).filter(Boolean).length;
}

/**
 * Run a single quality test: ask the LLM the same question on raw and filtered output.
 */
export async function testQuality(
  test: QualityTest,
  vmExec: (cmd: string, timeout?: number) => Promise<{ stdout: string; stderr: string; exitCode: number }>
): Promise<QualityResult> {
  // Capture raw and RTK outputs
  const raw = await vmExec(test.rawCmd, 120_000);
  const rtk = await vmExec(test.rtkCmd, 120_000);

  const rawOutput = raw.stdout + raw.stderr;
  const rtkOutput = rtk.stdout + rtk.stderr;

  const rawTokens = countWords(rawOutput);
  const rtkTokens = countWords(rtkOutput);
  const savings = rawTokens > 0 ? Math.round((1 - rtkTokens / rawTokens) * 100) : 0;

  // Extract ground truth from raw output
  const truth = test.extractTruth(rawOutput);

  // Ask LLM on both outputs
  const [rawAnswer, rtkAnswer] = await Promise.all([
    askLLM(rawOutput, test.question),
    askLLM(rtkOutput, test.question),
  ]);

  const rawCorrect = test.checkAnswer(rawAnswer, truth);
  const rtkCorrect = test.checkAnswer(rtkAnswer, truth);
  const qualityPreserved = rtkCorrect;

  const result: QualityResult = {
    name: test.name,
    rawTokens,
    rtkTokens,
    savings,
    rawCorrect,
    rtkCorrect,
    qualityPreserved,
    rawAnswer: rawAnswer.slice(0, 200),
    rtkAnswer: rtkAnswer.slice(0, 200),
    truth,
  };

  results.push(result);

  // Print result
  const status = qualityPreserved ? "\x1b[32mPASS\x1b[0m" : "\x1b[31mFAIL\x1b[0m";
  const rawStatus = rawCorrect ? "OK" : "WRONG";
  const rtkStatus = rtkCorrect ? "OK" : "WRONG";
  console.log(
    `  ${status} | ${test.name} | ${rawTokens}→${rtkTokens} (${savings}%) | raw:${rawStatus} rtk:${rtkStatus}`
  );

  return result;
}

/**
 * Helper: check if answer contains ALL expected strings (case-insensitive).
 */
export function containsAll(answer: string, expected: string[]): boolean {
  const lower = answer.toLowerCase();
  return expected.every((e) => lower.includes(e.toLowerCase()));
}

/**
 * Helper: check if answer contains ANY of the expected strings.
 */
export function containsAny(answer: string, expected: string[]): boolean {
  const lower = answer.toLowerCase();
  return expected.some((e) => lower.includes(e.toLowerCase()));
}

/**
 * Helper: check if answer mentions a number within range.
 */
export function mentionsNumberInRange(
  answer: string,
  min: number,
  max: number
): boolean {
  const numbers = answer.match(/\d+/g)?.map(Number) ?? [];
  return numbers.some((n) => n >= min && n <= max);
}

/**
 * Get all results and summary.
 */
export function getQualityResults(): {
  results: QualityResult[];
  totalTests: number;
  qualityPreserved: number;
  qualityLost: number;
  avgSavings: number;
} {
  const totalTests = results.length;
  const qualityPreserved = results.filter((r) => r.qualityPreserved).length;
  const qualityLost = totalTests - qualityPreserved;
  const avgSavings =
    totalTests > 0
      ? Math.round(results.reduce((s, r) => s + r.savings, 0) / totalTests)
      : 0;

  return { results, totalTests, qualityPreserved, qualityLost, avgSavings };
}

/**
 * Format quality results as a markdown table.
 */
export function formatQualityReport(): string {
  const { results: res, totalTests, qualityPreserved, qualityLost, avgSavings } =
    getQualityResults();

  const backends = detectedBackends ?? [];
  let md = `## AI Comprehension Quality Benchmark\n\n`;
  md += `**LLM backends**: ${backends.join(", ") || "none"} (forced: ${forcedBackend})\n`;
  md += `**Method**: Same factual question asked on raw output vs RTK filtered output\n`;
  md += `**Pass criteria**: LLM answers correctly from filtered output (fewer tokens, same comprehension)\n\n`;
  md += `| Test | Raw tokens | RTK tokens | Savings | Raw answer | RTK answer | Quality |\n`;
  md += `|------|----------:|----------:|--------:|:----------:|:----------:|:-------:|\n`;

  for (const r of res) {
    const rawOk = r.rawCorrect ? "OK" : "WRONG";
    const rtkOk = r.rtkCorrect ? "OK" : "WRONG";
    const quality = r.qualityPreserved ? "PRESERVED" : "LOST";
    md += `| ${r.name} | ${r.rawTokens} | ${r.rtkTokens} | ${r.savings}% | ${rawOk} | ${rtkOk} | ${quality} |\n`;
  }

  md += `\n**Summary**: ${qualityPreserved}/${totalTests} tests preserved comprehension quality (${avgSavings}% avg savings)\n`;
  if (qualityLost > 0) {
    md += `\n**Quality lost in ${qualityLost} tests** — RTK removed too much information:\n`;
    for (const r of res.filter((r) => !r.qualityPreserved)) {
      md += `- ${r.name}: expected ${JSON.stringify(r.truth)}, LLM said: "${r.rtkAnswer.slice(0, 100)}..."\n`;
    }
  }

  return md;
}
