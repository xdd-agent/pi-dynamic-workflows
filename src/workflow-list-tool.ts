import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { type Static, Type } from "typebox";
import { BUILTIN_WORKFLOWS } from "./builtin-workflows.js";
import type { SavedWorkflow, WorkflowStorage } from "./workflow-saved.js";

// ── Schema ──

const workflowListSchema = Type.Object(
  {
    filter: Type.Optional(
      Type.String({ description: "Optional substring to filter workflow names by." }),
    ),
  },
  { additionalProperties: false },
);

export type WorkflowListInput = Static<typeof workflowListSchema>;

// ── Options ──

export interface WorkflowListToolOptions {
  storage: WorkflowStorage;
}

// ── Detail types ──

export interface WorkflowListItem {
  name: string;
  description: string;
  kind: "built-in" | "saved-project" | "saved-user";
  savedAt?: string;
  parameters?: Record<string, { type: string; description?: string; required?: boolean; default?: unknown }>;
}

// ── Result shape ──

type ListResult = {
  content: Array<{ type: "text"; text: string }>;
  details: Record<string, unknown>;
};

// ── Factory ──

export function createWorkflowListTool(
  options: WorkflowListToolOptions,
): ToolDefinition<typeof workflowListSchema, Record<string, unknown>> {
  const { storage } = options;

  return defineTool({
    name: "workflow_list",
    label: "Workflow List",
    description:
      "List all available workflows — both built-in patterns and saved workflows — so the agent can discover what is available to run via workflow({ name }).",
    promptSnippet: "Discover available workflows (built-in patterns and saved workflows) before choosing one to run.",
    promptGuidelines: [
      "Use workflow_list to discover what saved and built-in workflows are available before calling workflow({ name }). A saved workflow with the same name as a built-in takes precedence.",
    ],
    parameters: workflowListSchema,

    async execute(_toolCallId, params) {
      // 1. Collect built-in workflows
      const builtins: WorkflowListItem[] = BUILTIN_WORKFLOWS.map((w) => ({
        name: w.name,
        description: w.description,
        kind: "built-in" as const,
      }));

      // 2. Collect saved workflows from storage
      const saved: WorkflowListItem[] = storage.list().map((w: SavedWorkflow) => ({
        name: w.name,
        description: w.description,
        kind: (w.location === "project" ? "saved-project" : "saved-user") as
          | "saved-project"
          | "saved-user",
        savedAt: w.savedAt,
        parameters: w.parameters,
      }));

      // 3. Merge: saved wins over built-in of same name
      const seen = new Set(saved.map((s) => s.name));
      const merged = [...saved, ...builtins.filter((b) => !seen.has(b.name))];

      // 4. Apply filter if provided
      const filter = typeof params.filter === "string" && params.filter.trim()
        ? params.filter.trim().toLowerCase()
        : null;
      const filtered = filter
        ? merged.filter(
            (w) =>
              w.name.toLowerCase().includes(filter) ||
              w.description.toLowerCase().includes(filter),
          )
        : merged;

      // 5. Format
      const text = filtered.length
        ? `action=list result=ok workflows=${filtered.length}\n${filtered.map(formatItem).join("\n")}`
        : "action=list result=ok workflows=0";

      return {
        content: [{ type: "text", text }],
        details: { action: "list", result: "ok", workflows: filtered },
      } satisfies ListResult;
    },
  });
}

// ── Formatter ──

function formatItem(w: WorkflowListItem): string {
  const parts = [
    `name=${JSON.stringify(w.name)}`,
    `kind=${w.kind}`,
    `description=${JSON.stringify(w.description)}`,
    ...(w.parameters ? [`parameters=${JSON.stringify(w.parameters)}`] : []),
    ...(w.savedAt ? [`savedAt=${JSON.stringify(w.savedAt)}`] : []),
  ];
  return parts.join(" ");
}
