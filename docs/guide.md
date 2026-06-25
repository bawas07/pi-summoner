# PI-EXTENSION-GUIDE — Minimum Pi Docs for This Project

Scoped reference so you don't need to keep opening pi.dev. Covers only what's relevant to building the Scout/Crafter/Gatekeeper system from `prd.md` and `flow.md`. Not a full Pi reference.

**If something here is unclear or you need a feature not covered below, open the full docs:**
👉 https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/extensions.md

Related full docs, only if you go deeper than this guide covers:
- TUI components (for richer `/watch` rendering): https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/tui.md
- Session format internals: https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/session-format.md
- Distributing as an installable package: https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/packages.md

---

## 1. Where files go

```
~/.pi/agent/extensions/*.ts          → global, single file
~/.pi/agent/extensions/*/index.ts    → global, multi-file
.pi/extensions/*.ts                  → project-local, single file
.pi/extensions/*/index.ts            → project-local, multi-file
```

For this project (multiple agents, shared Ledger module, registration logic), use the **multi-file directory style**:

```
~/.pi/agent/extensions/
└── orchestrator/
    ├── index.ts          # entry point, exports default function(pi)
    ├── ledger.ts          # Ledger data structure + read/write logic
    ├── agents.ts          # Agent registration (Scout, Crafter, Gatekeeper)
    ├── commands.ts        # /summon, /watch
    └── ui.ts              # status widget, watch-mode rendering
```

Test locally before installing properly:

```bash
pi -e ./orchestrator/index.ts
```

Hot reload after it's in the right folder:

```
/reload
```

## 2. Minimum extension skeleton

```typescript
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

export default function (pi: ExtensionAPI) {
  pi.on("session_start", async (_event, ctx) => {
    ctx.ui.notify("Orchestrator loaded", "info");
  });

  pi.registerTool({ /* ... */ });
  pi.registerCommand("summon", { /* ... */ });
}
```

The factory can be `async` if you need startup work (e.g. loading user-defined agent configs from disk) — Pi awaits it before continuing startup, so this is the right place to discover and register user-defined agents before the session begins.

## 3. Modeling a "sub-agent"

There are two layers here, and this project uses both:

1. **Surface — a registered tool per agent** (`summon_scout` / `summon_crafter` /
   `summon_gatekeeper`). This is what the Main-Agent LLM calls. Pattern shown below.
2. **Execution — an isolated session via `createAgentSession()`.** Pi *does* expose a
   first-class way to run an isolated sub-agent in-process (own context, tools, model,
   thinking level) — the SDK function `createAgentSession()`, the same mechanism
   `tintinweb/pi-subagents` uses. Each `summon_*` tool's `execute` runs one of these
   sessions and returns its final text. We deliberately do **not** spawn `pi --mode rpc`
   OS subprocesses — `createAgentSession()` is simpler and avoids JSONL-framing fragility.

   ```typescript
   import { createAgentSession } from "@earendil-works/pi-coding-agent";

   const { session } = await createAgentSession({
     cwd,
     tools: ["read", "grep", "find", "ls"], // per-role allowlist; omit for pi defaults
   });
   await session.prompt(task);                // resolves when the turn completes
   const text = extractAssistantText(session.messages); // read final assistant message
   session.dispose();
   ```

   **Read-only enforcement is architectural**: pass a tool allowlist that excludes
   `write`/`edit` for Scout/Gatekeeper. Crafter gets the full coding set.

The tool-registration surface for each agent:

```typescript
import { Type } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";

pi.registerTool({
  name: "summon_scout",
  label: "Scout",
  description: "Finds files, symbols, and builds AST-level dependency graphs. Returns minimal slices, not full files.",
  promptSnippet: "Find files/symbols, map dependencies",
  promptGuidelines: [
    "Use summon_scout before planning any multi-file change, to build a dependency graph first.",
  ],
  parameters: Type.Object({
    scope: Type.String({ description: "Files or directories to scan" }),
  }),
  async execute(toolCallId, params, signal, onUpdate, ctx) {
    onUpdate?.({ content: [{ type: "text", text: "Scanning..." }] });
    const graph = await buildDependencyGraph(params.scope); // your logic
    return {
      content: [{ type: "text", text: JSON.stringify(graph) }],
      details: { graph },
    };
  },
});
```

Register one tool per agent role (`summon_scout`, `summon_crafter`, `summon_gatekeeper`), plus a generic registration path for user-defined agents (see §7). The Main Agent — i.e. Pi's own LLM loop in this session — decides when to call these tools, same as any other tool.

**For multiple parallel Crafter instances:** call `execute()` concurrently for each Crafter invocation (Pi's parallel tool execution mode already runs sibling tool calls from the same assistant message concurrently — see §5 on the file mutation queue, which matters a lot here).

## 4. The Ledger — where to put it

The Ledger (per `flow.md` §2) needs to:
- Persist across the whole task (survive multiple tool calls / turns)
- Be readable/writable only through Main Agent's logic, not directly by Crafter instances

Two real options in Pi's model:

**Option A — in-memory module state** (simplest, good enough for a single session):
```typescript
// ledger.ts
type FileEntry = { status: "pending" | "in_progress" | "done" | "blocked"; phase: number; owner: string | null; summary?: string };
const ledger: Record<string, FileEntry> = {};

export function getLedger() { return ledger; }
export function setFileStatus(path: string, entry: Partial<FileEntry>) {
  ledger[path] = { ...ledger[path], ...entry } as FileEntry;
}
```
Import this module from `agents.ts` and `commands.ts`. Since extensions are just TypeScript modules, this is plain closure state — it lives as long as the extension runtime does.

**Option B — persisted via `pi.appendEntry()`** (survives `/reload` and session resume):
```typescript
pi.appendEntry("ledger-update", { path: "lib/api.js", status: "done" });

// Reconstruct on session_start:
pi.on("session_start", async (_event, ctx) => {
  for (const entry of ctx.sessionManager.getEntries()) {
    if (entry.type === "custom" && entry.customType === "ledger-update") {
      applyLedgerUpdate(entry.data);
    }
  }
});
```
Use this if you want the Ledger to survive a crash or session restart mid-task — important for long-running multi-phase work. **Recommended for this project** given phases can be long-running.

Note: `pi.appendEntry()` data does **not** participate in LLM context — exactly what you want, since the Ledger is bookkeeping, not something that should bloat Main Agent's context window.

### Where this actually gets saved

`pi.appendEntry()` doesn't write to a separate database or config file — it writes a new line directly into the **same session JSONL file** the whole conversation already lives in. Specifically:

```
~/.pi/agent/sessions/--<cwd-with-slashes-replaced-by-dashes>--/<timestamp>_<uuid>.jsonl
```

So if you're working in `/home/kawan/edubridge`, the session file lives at something like:

```
~/.pi/agent/sessions/--home-kawan-edubridge--/2026-06-17T10-30-00_a1b2c3d4.jsonl
```

Each line in that file is one JSON object. A normal conversation turn is one line (`{"type":"message", ...}`); your Ledger update via `appendEntry("ledger-update", {...})` is just another line (`{"type":"custom", "customType":"ledger-update", "data": {...}, "id": "...", "parentId": "...", ...}`) appended to the same file, in the same tree-with-id/parentId structure as everything else.

**Practical implications for this project:**
- The Ledger's persistence is tied to the session. If you `/new` or `/resume` a different session, you get a fresh (or different) Ledger — there's no global cross-session Ledger store unless you build one yourself outside this mechanism.
- Since entries are appended in tree order with id/parentId, the Ledger reconstruction logic in `session_start` (looping over `ctx.sessionManager.getEntries()`) naturally replays updates in the order they happened — useful if a phase had several status transitions and you need the latest one to win.
- You never touch the file path directly. Always go through `pi.appendEntry()` to write and `ctx.sessionManager.getEntries()` to read — treat the actual `.jsonl` location as an implementation detail, not something your extension code should hardcode or open directly.

## 5. Critical: file mutation queue for Crafter

Since Crafter writes files and multiple Crafters can run in the same phase, **this is the single most important API for avoiding silent data loss**:

```typescript
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

async execute(toolCallId, params, signal, onUpdate, ctx) {
  const absolutePath = resolve(ctx.cwd, params.path);

  return withFileMutationQueue(absolutePath, async () => {
    const current = await readFile(absolutePath, "utf8");
    const next = applyChange(current, params);
    await writeFile(absolutePath, next, "utf8");
    return { content: [{ type: "text", text: `Updated ${params.path}` }], details: {} };
  });
}
```

Without this, two Crafters touching the same file in the same tool-call batch can both read the old contents and the second write silently clobbers the first — exactly the corruption scenario the whole Ledger/phase design exists to prevent. **Always wrap Crafter's read-modify-write logic in `withFileMutationQueue`, even though phases should already prevent same-file collisions by design** — this is the safety net underneath the safety net.

## 6. Tool output truncation (Scout's job especially)

Pi caps tool output at **50KB / 2000 lines** by default. Since Scout's entire purpose is returning minimal slices (per `prd.md` §4), you should truncate proactively rather than relying on Pi's hard cutoff:

```typescript
import { truncateHead, formatSize } from "@earendil-works/pi-coding-agent";

const truncation = truncateHead(scoutOutput, { maxLines: 200, maxBytes: 10_000 });
let result = truncation.content;
if (truncation.truncated) {
  result += `\n[Truncated: ${truncation.outputLines}/${truncation.totalLines} lines]`;
}
```

## 7. User-defined agents (flat registration, per `prd.md` §3)

Since built-in and user-defined agents are treated identically, expose a simple registration helper rather than hardcoding three tools:

```typescript
// agents.ts
type AgentDefinition = {
  name: string;
  description: string;
  memory?: boolean;
  handler: (task: string, ctx: any) => Promise<{ content: any[]; details: any }>;
};

export function registerAgent(pi: ExtensionAPI, def: AgentDefinition) {
  pi.registerTool({
    name: `summon_${def.name}`,
    label: def.name,
    description: def.description,
    parameters: Type.Object({ task: Type.String() }),
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      return def.handler(params.task, ctx);
    },
  });
}
```

Built-in Scout/Crafter/Gatekeeper just call `registerAgent(pi, { name: "scout", ... })` the same way a user's own config would. Discover user-defined agents at startup (async factory function, see §2) by reading a config directory, then call `registerAgent` for each one found.

## 8. `/summon` and `/watch` commands

```typescript
// commands.ts
pi.registerCommand("summon", {
  description: "Summon an agent for a task",
  getArgumentCompletions: (prefix) => {
    const agents = ["scout", "crafter", "gatekeeper"]; // + user-defined names
    return agents.filter(a => a.startsWith(prefix)).map(a => ({ value: a, label: a }));
  },
  handler: async (args, ctx) => {
    pi.sendUserMessage(`Use summon_${args} now.`); // nudges the LLM to call the right tool
  },
});

pi.registerCommand("watch", {
  description: "Read-only live view of a summoned agent",
  handler: async (args, ctx) => {
    await ctx.ui.custom<void>((tui, theme, keybindings, done) => {
      // Render live status pulled from your in-memory agent activity log
      // Esc handling:
      const component = buildWatchView(args, theme); // your render logic
      component.onKey = (key) => { if (key === "escape") done(); return true; };
      return component;
    });
  },
});
```

`ctx.ui.custom()` is the right primitive for the full-takeover watch view described in `prd.md` §5.2 — it temporarily replaces the editor until `done()` is called, and accepts no input besides what you wire up yourself (so naturally read-only unless you explicitly add handlers — which, per the design, we don't).

## 9. Status widget (always-visible agent states)

```typescript
ctx.ui.setWidget("agent-status", () => [
  "🟢 crafter-1   dashboard.js   (working)",
  "🟡 crafter-2   waiting (phase gate)",
  "✅ crafter-3   settings.js    (done)",
]);
```

Update this any time the Ledger changes (call it from inside your Ledger's `setFileStatus` helper so the widget and Ledger never drift out of sync).

## 10. Quick gotchas worth knowing upfront

- **`StringEnum` not `Type.Union`** for any enum-like tool parameter (e.g. trust mode choice) — `Type.Union`/`Type.Literal` breaks on Google's API.
- **Throw to signal tool failure.** Returning a value never sets `isError`, regardless of what's in it.
- **Tools register live** — `pi.registerTool()` works after startup too (e.g. from inside a command handler), no `/reload` needed for newly registered tools to become callable.
- **`ctx.signal`** is only defined during active turns (tool_call, tool_result, etc.) — don't expect it in idle contexts like commands fired while Pi is sitting idle.

---

This guide intentionally omits: themes, custom providers/OAuth, vim-mode editors, session forking/tree navigation, and RPC/JSON mode — none of these are needed for Scout/Crafter/Gatekeeper. If a future requirement touches those, go straight to the full docs link at the top.

## 11. Install / Uninstall

### While building (loose `.ts` files, no `package.json` yet)

No install command needed — Pi auto-discovers extensions dropped into the right folder (`prd.md`/`flow.md` assume the `orchestrator/` directory structure from §1).

```bash
# Install — global (all projects)
cp -r orchestrator ~/.pi/agent/extensions/

# Install — project-local (this project only)
cp -r orchestrator .pi/extensions/

# Reload without restarting Pi
/reload
```

```bash
# Uninstall — just delete the folder
rm -rf ~/.pi/agent/extensions/orchestrator        # global
rm -rf .pi/extensions/orchestrator                # project-local
```

### Once packaged (has its own `package.json`, shared via npm/git, or just want it tracked in settings)

Pi has real package management commands for this:

```bash
pi install ./orchestrator              # global, from local path
pi install ./orchestrator -l            # project-local
pi install git:github.com/you/orchestrator@v1
pi install npm:your-package-name

pi remove ./orchestrator                # or: pi uninstall ./orchestrator
pi list                                  # see what's currently installed
pi update --extension ./orchestrator     # update just this one
```

By default, `install`/`remove` write to `~/.pi/agent/settings.json` — this is what makes uninstall *clean*, since it removes both the files and the settings reference. The manual `rm -rf` approach above works fine for local dev, but if you ever add it to `settings.json`'s `extensions` array manually, use `pi remove`/`pi uninstall` instead of deleting the folder directly, or you'll leave a dangling reference Pi tries to load on next startup.

**One gotcha:** if this ever becomes an npm package, installing it with plain `npm install your-package` does **not** register it with Pi — it has to go through `pi install npm:your-package`, or Pi has no idea the extension exists even though the files are on disk.

### If you put it on GitHub

No npm publish needed — Pi can install straight from a git URL. Both forms work:

```bash
pi install git:github.com/<your-username>/<repo>           # latest default branch
pi install git:github.com/<your-username>/<repo>@v1         # pinned to a tag/branch/commit
pi install https://github.com/<your-username>/<repo>        # raw URL also works
```

For project-local instead of global, add `-l`:

```bash
pi install git:github.com/<your-username>/<repo> -l
```

Uninstall is the mirror:

```bash
pi remove git:github.com/<your-username>/<repo>
# or
pi uninstall git:github.com/<your-username>/<repo>
```

**Updating** after you push new commits to the repo:

```bash
pi update --extension git:github.com/<your-username>/<repo>
# or update everything at once:
pi update --extensions
```

If you pinned to `@v1` and you push a new `v2` tag, `pi update` reconciles pinned git refs — worth knowing if you tag releases rather than just pushing to `main`.

**What the repo needs to actually work as a pi package:** a `package.json` at the root (even a minimal one) so Pi recognizes it as installable, plus your `orchestrator/` extension files. The structure from §1 (`index.ts`, `ledger.ts`, `agents.ts`, `commands.ts`, `ui.ts`) can live as-is inside the repo — Pi reads the package metadata to know where the extension entry point is.

**Security note worth remembering for your own README:** anyone who runs `pi install git:github.com/you/orchestrator` is letting your code execute with their full system permissions — same caution Pi gives for any third-party package applies to yours once it's public. Worth a line in your repo's README saying as much, since that's the convention other pi packages follow.

**Private repos:** `pi install git:...` shells out to git under the hood, so it follows whatever git auth you already have configured locally (SSH key, credential helper, etc.) — nothing pi-specific to set up, but it does mean a private repo only installs cleanly on machines that already have access to clone it.