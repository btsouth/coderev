import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it } from "node:test";

const repoRoot = resolve(import.meta.dirname, "..");

describe("action script hardening", () => {
  it("never templates an expression into the shell script body", () => {
    // ${{ }} inside run: is pasted into the script before bash parses it, so
    // any input containing a quote becomes code. Inputs go through env.
    const action = readFileSync(resolve(repoRoot, "action.yml"), "utf8");
    const script = action.split(/^\s+run: \|$/m)[1] ?? "";
    assert.notEqual(script, "");
    assert.doesNotMatch(script, /\$\{\{/);
  });
});

describe("Grok action wrapper invariants", () => {
  it("routes the grok preset through the trusted stdin wrapper", () => {
    const action = readFileSync(resolve(repoRoot, "action.yml"), "utf8");

    assert.match(action, /REVIEW_EXEC_COMMAND" == "grok"/);
    assert.match(
      action,
      /C:\\\\Windows\\\\System32\\\\WindowsPowerShell\\\\v1\.0\\\\powershell\.exe .*grok-stdin\.ps1/,
    );
  });

  it("keeps Grok able to inspect the repo, with room to finish", () => {
    // This invariant was originally inverted: it asserted --tools none,
    // --permission-mode dontAsk, and the absence of --max-turns. Those are
    // the exact flags that made Grok contribute nothing for two days.
    // Measured against the real CLI: dontAsk DENIES tool calls rather than
    // auto-approving them, so the agent emitted a planning preamble, asked to
    // read a file, was refused, and ended with stopReason "cancelled" at exit
    // code 0 — indistinguishable from a clean review. Grok is an agentic
    // reviewer; reading the surrounding code is the whole point of using it.
    const wrapper = readFileSync(resolve(repoRoot, "bin", "grok-stdin.ps1"), "utf8");
    const invocation = wrapper
      .split(/\r?\n/)
      .filter((line) => line.trimStart().startsWith("& grok ") || line.trimStart().startsWith("--"))
      .join(" ");

    assert.ok(invocation, "the wrapper must invoke Grok");
    assert.match(invocation, /--prompt-file \$promptPath/);
    // Tools stay enabled and auto-approved, and neither disabling flag returns.
    assert.match(invocation, /--always-approve/);
    assert.doesNotMatch(invocation, /--tools none/);
    assert.doesNotMatch(invocation, /--permission-mode dontAsk/);
    // A turn budget is required, and small budgets starve the inspection:
    // nine of twenty-five fleet runs died at "Max turns reached" with 20.
    const turns = invocation.match(/--max-turns (\d+)/);
    assert.ok(turns, "the wrapper must set a turn budget");
    assert.ok(Number(turns[1]) >= 60, `turn budget too small: ${turns[1]}`);
    assert.match(invocation, /--disable-web-search/);
    // The reviewer gets an ALLOWLIST of read tools and no shell. On toolport
    // PR 813 twelve of thirty-three turns were `run_terminal_command curl
    // https://docs.devin.ai/...` — about four hundred seconds reading a
    // vendor's docs instead of the diff, which is what pushed that review past
    // its budget. --disable-web-search removes the search tool and leaves a
    // shell that reaches the internet anyway.
    //
    // It must be --tools. --disallowed-tools is accepted and ignored: with
    // `--disallowed-tools run_terminal_command` the agent still ran echo on
    // its first turn.
    const allowed = invocation.match(/--tools ([\w,]+)/);
    assert.ok(allowed, "the wrapper must pass a tool allowlist");
    const tools = (allowed[1] ?? "").split(",");
    assert.ok(!tools.includes("run_terminal_command"), "the reviewer gets no shell");
    assert.ok(!tools.includes("web_fetch"), "the reviewer reads the repo, not the web");
    // Too small an allowlist is the other failure: `--tools none` produced a
    // silent zero-finding review on every run for two days, because reading
    // the surrounding code is the whole reason for an agentic reviewer.
    for (const needed of ["read_file", "grep", "list_dir"]) {
      assert.ok(tools.includes(needed), `the reviewer must keep ${needed}`);
    }
    // Subagents stay OFF. Enabling them hung the fleet: the extra narration
    // reset the idle timer on every chunk, so runs could only end at the total
    // cap, and one held a runner for forty-seven minutes while five pull
    // requests queued. Depth is not worth an unbounded review.
    assert.match(invocation, /--no-subagents/);
    // The model is pinned so the reviewer cannot change under us on a release.
    assert.match(invocation, /--model \$model/);
    assert.match(invocation, /--no-memory/);
    // Output is streamed, not buffered: plain mode printed nothing until the
    // agent finished, so a ten-minute review looked exactly like a hang. The
    // wrapper narrates events on stderr and prints only the final message on
    // stdout, which is why --verbatim is gone and this flag is required.
    assert.match(invocation, /--output-format streaming-messages-json/);
    assert.doesNotMatch(invocation, /--verbatim/);
  });

  it("runs the reviewer in a grok home that declares no MCP server", () => {
    // The interactive home declares a Toolport MCP gateway. On 2026-08-19 that
    // gateway stopped completing its handshake and grok blocked before reading
    // the prompt -- sixty-six consecutive reviews produced zero bytes of stdout
    // and died at the idle budget with nothing in the job log. The reviewer
    // needs read_file and grep, not a fan-out to a dozen SaaS APIs, so it gets
    // its own home and shares only the credential file.
    const wrapper = readFileSync(resolve(repoRoot, "bin", "grok-stdin.ps1"), "utf8");

    assert.match(wrapper, /\$env:GROK_HOME\s*=\s*\$reviewHome/);
    assert.match(wrapper, /\.grok-coderev/);
    // Credentials stay shared: a `grok login` at the terminal must authorise
    // the fleet, or every token refresh becomes a manual step on this machine.
    assert.match(wrapper, /\$env:GROK_AUTH_PATH\s*=\s*Join-Path \$personalHome "auth\.json"/);

    // The config the wrapper writes is the whole point of the isolation.
    const config = wrapper.split("@'")[1]?.split("'@")[0] ?? "";
    assert.ok(config.includes("[cli]"), "the wrapper must write a config for the review home");
    // Declaring no server is not enough, and this is the part that took a
    // second pass to find. Grok scans other harnesses by default: with a clean
    // review home the gateway came straight back, sourced from `~/.claude.json
    // [claude]`. `grok inspect` names the origin; these switches close it.
    assert.match(config, /\[compat\.claude\][\s\S]*?mcps = false/);
    assert.match(config, /\[compat\.cursor\][\s\S]*?mcps = false/);
    // The same scan imports the harness's command hooks, which run on every
    // tool call — a stall risk, and a console window per hook on a machine
    // somebody is sitting at.
    assert.match(config, /\[compat\.claude\][\s\S]*?hooks = false/);
    assert.match(config, /\[compat\.cursor\][\s\S]*?hooks = false/);
    assert.match(config, /disabled_mcp_servers = \["toolport"\]/);
    // Top-level key: below a table header TOML reads it as that table's member
    // and it silently does nothing.
    assert.ok(
      config.indexOf("disabled_mcp_servers") < config.indexOf("["),
      "disabled_mcp_servers must precede the first table header",
    );
    // The reviewer never declares a server of its own.
    assert.doesNotMatch(config, /\[mcp_servers\./);
    // A self-update inside a review is a stall, not an upgrade.
    assert.match(config, /auto_update = false/);
    assert.match(config, /permission_mode = "always-approve"/);

    // Env vars carry the same intent without depending on the file being
    // found, parsed, or still saying this tomorrow.
    assert.match(wrapper, /\$env:GROK_CLAUDE_MCPS_ENABLED = "0"/);
    assert.match(wrapper, /\$env:GROK_CURSOR_MCPS_ENABLED = "0"/);

    // A BOM makes the TOML unparseable and the isolation a no-op, so the
    // config must not go through Set-Content's UTF-8.
    assert.match(wrapper, /WriteAllText\([\s\S]*?UTF8Encoding\]::new\(\$false\)\)/);
  });
});
