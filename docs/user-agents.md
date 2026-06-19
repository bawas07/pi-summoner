# User-Defined Agents

You can add your own agents that work alongside Scout, Crafter, and Gatekeeper.
They're registered through the same flat interface — no special-casing.

## Where to put config

| Scope | Path |
|---|---|
| **Project-local** | `<project>/.pi/agents.json` |
| **Global** (all projects) | `~/.pi/agent/agents.json` |

Both are loaded automatically on session start. Project config takes precedence if
both define an agent with the same name.

## Config format

```json
[
  {
    "name": "docs-writer",
    "description": "Writes and updates Markdown documentation. Summon after code changes that affect APIs or architecture.",
    "handlerPath": "./agents/docs-writer.ts"
  },
  {
    "name": "linter-fixer",
    "description": "Fixes ESLint and Prettier issues. Summon when lint errors block a PR.",
    "memory": true,
    "handlerPath": "./agents/linter-fixer.ts"
  }
]
```

### Fields

| Field | Required | Description |
|---|---|---|
| `name` | ✅ | Unique agent name. Becomes the tool `summon_<name>`. Use kebab-case. |
| `description` | ✅ | **LLM-readable.** This is how Main Agent decides WHEN to summon your agent. Be specific about triggers. |
| `memory` | ❌ | If `true`, the agent keeps session-scoped memory. Default: `false`. |
| `handlerPath` | ❌ | Path to the handler module (relative to the config file). Without this, the agent is descriptive-only — the LLM knows about it but can't execute it. |

### Handler module

Your handler file must export a default function:

```typescript
// .pi/agents/docs-writer.ts
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

export default async function (task: string, ctx: ExtensionContext) {
  // Your logic here — read files, call APIs, etc.

  return {
    content: [{ type: "text", text: "Documentation updated." }],
    details: { status: "done" },
  };
}
```

The handler receives:
- `task` — the task string passed by the LLM when summoning your agent
- `ctx` — the Pi extension context (cwd, ui, sessionManager, etc.)

Returns:
- `content` — what the LLM sees (text or images)
- `details` — machine-readable result (not shown to the LLM, useful for logging)

## How the LLM decides to summon

The `description` field is EVERYTHING. The LLM reads it and decides whether your
agent is relevant. Be explicit:

**Good descriptions:**
```
"Fixes ESLint and Prettier issues. Summon when lint errors block a PR."
"Generates SQL migration files from schema changes. Summon after modifying Prisma models."
```

**Bad descriptions:**
```
"A helper agent."
"Does stuff."
```

## Verification

After reloading Pi (`/reload`), check that your agent appears:

```
/summon <tab>     # should autocomplete your agent name
```

Or check the console log:
```
[agent-summoner] Registered user agent: docs-writer
```

## Example: A doc-writer agent

**.pi/agents.json:**
```json
[
  {
    "name": "docs-writer",
    "description": "Writes and updates project documentation. Summon after any code change that affects public APIs, architecture, or developer workflows.",
    "handlerPath": "./agents/docs-writer.ts"
  }
]
```

**.pi/agents/docs-writer.ts:**
```typescript
import { writeFile, readFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

export default async function (task: string, ctx: ExtensionContext) {
  const docsDir = join(ctx.cwd, "docs");

  // Ensure docs directory exists
  await mkdir(docsDir, { recursive: true });

  // Write a simple changelog entry
  const changelogPath = join(docsDir, "CHANGELOG.md");
  const entry = `- ${new Date().toISOString().slice(0, 10)}: ${task}\n`;

  let existing = "";
  try {
    existing = await readFile(changelogPath, "utf8");
  } catch {
    existing = "# Changelog\n\n";
  }

  await writeFile(changelogPath, existing + entry, "utf8");

  return {
    content: [{ type: "text", text: `Added changelog entry: ${task}` }],
    details: { file: changelogPath },
  };
}
```
