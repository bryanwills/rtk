/**
 * AI Comprehension Quality Benchmark
 *
 * Validates that RTK's filtered output preserves semantic content
 * by asking an LLM the same questions on raw vs filtered output
 * and comparing answers against ground truth.
 *
 * Requires: ANTHROPIC_API_KEY environment variable
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

/**
 * Ask Claude a question about command output.
 *
 * Strategy (in order):
 * 1. `claude` CLI with --print (uses Claude Code's OAuth — no API key needed)
 * 2. ANTHROPIC_API_KEY direct API call (fallback)
 * 3. Skip if neither available
 */
async function askLLM(output: string, question: string): Promise<string> {
  // Cap output to ~4000 tokens worth (~16K chars) to avoid blowing budget
  const cappedOutput = output.slice(0, 16_000);
  const prompt = `Here is the output of a development command:\n\n\`\`\`\n${cappedOutput}\n\`\`\`\n\n${question}\n\nAnswer concisely in 1-3 sentences. Only state facts from the output above.`;

  // Strategy 1: Claude CLI (uses existing Claude Code auth, no API key needed)
  try {
    const { $ } = await import("bun");
    const result = await $`echo ${prompt} | claude -p --model haiku --max-turns 1 --no-session-persistence 2>/dev/null`
      .quiet()
      .nothrow()
      .timeout(30_000);
    if (result.exitCode === 0 && result.stdout.toString().trim()) {
      return result.stdout.toString().trim();
    }
  } catch {
    // Claude CLI not available, fall through
  }

  // Strategy 2: Anthropic API direct
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return "[SKIP: no claude CLI or ANTHROPIC_API_KEY]";

  const body = JSON.stringify({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 300,
    messages: [{ role: "user", content: prompt }],
  });

  try {
    const resp = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body,
    });
    const data = (await resp.json()) as {
      content?: { text?: string }[];
      error?: { message?: string };
    };
    if (data.error) return `[API error: ${data.error.message}]`;
    return data.content?.[0]?.text ?? "[empty response]";
  } catch (e) {
    return `[fetch error: ${e}]`;
  }
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

  let md = `## AI Comprehension Quality Benchmark\n\n`;
  md += `**Model**: claude-haiku-4-5 (cheapest, fastest — if Haiku understands it, any model will)\n`;
  md += `**Method**: Same factual question asked on raw output vs RTK filtered output\n\n`;
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
