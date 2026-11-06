let prompt = "";
process.stdin.setEncoding("utf8");
for await (const chunk of process.stdin) prompt += chunk;

if (process.argv.includes("--die")) {
  // Stands in for the agentic CLI blowing its wall-clock budget: the review
  // must ride on the other generator rather than reporting that it did not run.
  process.stderr.write("CLI exceeded its budget\n");
  process.exitCode = 1;
} else if (
  process.argv.includes("--reject-hidden") &&
  /[\u202A-\u202E\u2066-\u2069\u200B]|[\u{E0000}-\u{E007F}]/u.test(prompt)
) {
  // Stands in for the model reading a character the diff view never showed.
  process.stderr.write("hidden character reached the CLI\n");
  process.exitCode = 4;
} else if (process.argv.includes("--empty")) {
  // Successful process with no completion must not become a clean review.
} else if (!prompt.includes("SYSTEM SENTINEL") || !prompt.includes("USER SENTINEL")) {
  process.stderr.write("expected both prompts on stdin\n");
  process.exitCode = 2;
} else {
  process.stdout.write('{"findings":[]}\n');
}
