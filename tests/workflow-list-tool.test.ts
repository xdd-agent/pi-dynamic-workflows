import assert from "node:assert/strict";
import test from "node:test";
import { Check } from "typebox/value";
import type { WorkflowListItem } from "../src/workflow-list-tool.js";
import { createWorkflowListTool } from "../src/workflow-list-tool.js";
import type { SavedWorkflow, WorkflowStorage } from "../src/workflow-saved.js";

// ── Stubs ──

function saved(
  name: string,
  location: "project" | "user" = "project",
  description = `${name} description`,
  parameters?: SavedWorkflow["parameters"],
): SavedWorkflow {
  return {
    name,
    description,
    script: `export const meta = { name: '${name}', description: '${description}' }; return await agent('x')`,
    location,
    parameters,
    path: "/fake/" + name + ".json",
    savedAt: "2026-07-30T12:00:00.000Z",
  };
}

function fakeStorage(savedWorkflows: SavedWorkflow[]): WorkflowStorage {
  return {
    list: () => savedWorkflows,
    load: () => null,
    save: () => {
      throw new Error("unexpected save in test");
    },
    delete: () => false,
  } as unknown as WorkflowStorage;
}

async function execute(storage: WorkflowStorage, params: Record<string, unknown> = {}) {
  const tool = createWorkflowListTool({ storage });
  return (tool.execute as any)("list-call", params, undefined, undefined, {});
}

function text(result: Awaited<ReturnType<typeof execute>>): string {
  return result.content[0].text;
}

function workflows(result: Awaited<ReturnType<typeof execute>>): WorkflowListItem[] {
  return result.details.workflows as WorkflowListItem[];
}

// ── Schema ──

test("workflow_list schema accepts optional filter and rejects unknown keys", () => {
  const storage = fakeStorage([]);
  const tool = createWorkflowListTool({ storage });

  assert.equal(tool.name, "workflow_list");
  assert.equal((tool.parameters as { type?: string }).type, "object");

  // Valid inputs
  assert.equal(Check(tool.parameters, {}), true);
  assert.equal(Check(tool.parameters, { filter: "audit" }), true);

  // Unknown key rejected (additionalProperties: false)
  assert.equal(Check(tool.parameters, { action: "list" }), false);
  assert.equal(Check(tool.parameters, { filter: "x", extra: 1 }), false);
});

// ── Listing ──

test("empty storage with only built-ins returns built-in workflows", async () => {
  const storage = fakeStorage([]);
  const result = await execute(storage);
  const t = text(result);

  assert.match(t, /^action=list result=ok workflows=\d+/);
  // The 5 built-ins should be present
  assert.match(t, /name="deep-research"/);
  assert.match(t, /name="adversarial-review"/);
  assert.match(t, /name="code-review"/);
  assert.match(t, /name="multi-perspective"/);
  assert.match(t, /name="codebase-audit"/);
  assert.match(t, /kind=built-in/);

  assert.equal(workflows(result).length, 5);
  assert.deepEqual(
    workflows(result).every((w: WorkflowListItem) => w.kind === "built-in"),
    true,
  );
});

test("saved workflows appear alongside built-ins without duplicates", async () => {
  const storage = fakeStorage([saved("deep-research", "project", "My custom research")]);
  const result = await execute(storage);
  const t = text(result);

  // The saved deep-research should appear instead of the built-in
  assert.match(t, /name="deep-research"/);
  assert.match(t, /kind=saved-project/);
  assert.match(t, /description="My custom research"/);

  // The built-in deep-research must NOT appear
  const items = workflows(result);
  const deepResearch = items.filter((w: WorkflowListItem) => w.name === "deep-research");
  assert.equal(deepResearch.length, 1);
  assert.equal(deepResearch[0]!.kind, "saved-project");
  assert.equal(deepResearch[0]!.description, "My custom research");

  // Other 4 built-ins still present
  assert.equal(items.length, 5);
});

test("saved project workflow takes precedence over saved user workflow", async () => {
  const storage = fakeStorage([saved("my-wf", "user", "User version"), saved("my-wf", "project", "Project version")]);
  const result = await execute(storage);

  const items = workflows(result);
  const myWf = items.filter((w: WorkflowListItem) => w.name === "my-wf");
  assert.equal(myWf.length, 1);
  assert.equal(myWf[0]!.kind, "saved-project");
  assert.equal(myWf[0]!.description, "Project version");
});

test("text format follows key=value convention", async () => {
  const storage = fakeStorage([saved("audit", "project")]);
  const result = await execute(storage);
  const t = text(result);

  assert.match(t, /^action=list result=ok workflows=/);
  // Each line should have name=, kind=, description=
  for (const line of t.split("\n").slice(1)) {
    assert.match(line, /name=/);
    assert.match(line, /kind=/);
    assert.match(line, /description=/);
  }
});

// ── Filtering ──

test("filter by name substring", async () => {
  const storage = fakeStorage([]);
  const result = await execute(storage, { filter: "code" });
  const items = workflows(result);

  assert.equal(items.length, 2); // code-review + codebase-audit
  assert.deepEqual(items.map((w: WorkflowListItem) => w.name).sort(), ["code-review", "codebase-audit"]);
});

test("filter by description substring", async () => {
  const storage = fakeStorage([saved("explore", "project", "Exploratory audit of codebase")]);
  const result = await execute(storage, { filter: "audit" });
  const items = workflows(result);

  // Should match "codebase-audit" (built-in) and "explore" (saved, description matches)
  const names = items.map((w: WorkflowListItem) => w.name);
  assert.ok(names.includes("codebase-audit"));
  assert.ok(names.includes("explore"));
});

test("filter is case-insensitive", async () => {
  const storage = fakeStorage([]);
  const result = await execute(storage, { filter: "CODE" });
  const items = workflows(result);

  assert.equal(items.length, 2); // code-review + codebase-audit
});

test("filter with no matches returns zero", async () => {
  const storage = fakeStorage([]);
  const result = await execute(storage, { filter: "zzz_nonexistent" });
  const t = text(result);

  assert.equal(t, "action=list result=ok workflows=0");
  assert.deepEqual(workflows(result), []);
});

test("empty string filter returns all results", async () => {
  const storage = fakeStorage([]);
  const result = await execute(storage, { filter: "" });
  assert.equal(workflows(result).length, 5);
});

// ── Display fields ──

test("saved workflows with parameters include them in text output", async () => {
  const storage = fakeStorage([
    saved("my-wf", "project", "With args", {
      topic: { type: "string", description: "Research topic", required: true },
      depth: { type: "string", description: "Depth", required: false, default: "standard" },
    }),
  ]);
  const result = await execute(storage);
  const t = text(result);

  assert.match(t, /parameters=/);
  assert.match(t, /"topic"/);
  assert.match(t, /"type":"string"/);
  assert.match(t, /"required":true/);
});

test("saved workflows without parameters omit the field", async () => {
  const storage = fakeStorage([saved("no-args", "project")]);
  const result = await execute(storage);
  const t = text(result);

  const line = t.split("\n").find((l) => l.includes('name="no-args"'));
  assert.ok(line);
  assert.ok(!line!.includes("parameters="));
});

test("saved workflows include savedAt field", async () => {
  const storage = fakeStorage([saved("audit", "project")]);
  const result = await execute(storage);
  const t = text(result);

  assert.match(t, /savedAt="2026-07-30T12:00:00\.000Z"/);
});

test("built-in workflows omit savedAt field", async () => {
  const storage = fakeStorage([]);
  const result = await execute(storage);
  const t = text(result);

  // Built-in lines should not have savedAt
  const lines = t.split("\n").filter((l) => l.includes("kind=built-in"));
  for (const line of lines) {
    assert.ok(!line.includes("savedAt="));
  }
});
