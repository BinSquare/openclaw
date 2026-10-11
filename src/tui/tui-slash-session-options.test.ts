import { describe, expect, it, vi } from "vitest";
import type { TuiModelChoice } from "./tui-backend.js";
import { createTuiSlashSessionOptions } from "./tui-slash-session-options.js";
import type { SessionInfo } from "./tui-types.js";

const astra = (overrides: Partial<TuiModelChoice> = {}): TuiModelChoice => ({
  id: "gpt-6-astra",
  name: "GPT-6 Astra",
  provider: "openai",
  available: true,
  serviceTiers: ["priority", "ultrafast"],
  ...overrides,
});

function harness(sessionInfo: SessionInfo, known?: TuiModelChoice[]) {
  const listModels = vi.fn(async () => known ?? []);
  const onCatalogLoaded = vi.fn();
  const state = { currentAgentId: "main", currentSessionKey: "agent:main:main", sessionInfo };
  const client = known ? { listModels, getKnownModels: () => known } : { listModels };
  return {
    listModels,
    onCatalogLoaded,
    options: createTuiSlashSessionOptions(client, state, onCatalogLoaded),
  };
}

const openaiSession = { modelProvider: "openai", model: "gpt-6-astra" } satisfies SessionInfo;

describe("createTuiSlashSessionOptions", () => {
  it.each<{ name: string; models: TuiModelChoice[]; expected: boolean }>([
    { name: "an advertised available model", models: [astra()], expected: true },
    {
      name: "a model without the tier",
      models: [astra({ serviceTiers: ["priority"] })],
      expected: false,
    },
    { name: "unknown tiers", models: [astra({ serviceTiers: undefined })], expected: false },
    { name: "an unavailable model", models: [astra({ available: false })], expected: false },
    { name: "a different model", models: [astra({ id: "gpt-6.1-sol" })], expected: false },
  ])("offers Ultrafast from catalog facts for $name", ({ models, expected }) => {
    expect(harness(openaiSession, models).options().ultrafast).toBe(expected);
  });

  it.each([
    { runtime: "codex", expected: false },
    { runtime: "openclaw", expected: true },
  ])("uses the session's $runtime runtime tiers", ({ runtime, expected }) => {
    const model = astra({
      agentRuntime: { id: "openclaw", source: "model" },
      runtimeChoices: [
        {
          agentRuntime: { id: "codex", source: "model" },
          available: true,
          serviceTiers: ["priority"],
        },
      ],
    });
    const session: SessionInfo = {
      ...openaiSession,
      agentRuntime: { id: runtime, source: "session-key" },
    };
    expect(harness(session, [model]).options().ultrafast).toBe(expected);
  });

  it("loads a catalog once for backends without a live cache", async () => {
    const h = harness(openaiSession);
    h.listModels.mockResolvedValue([astra()]);

    expect(h.options().ultrafast).toBe(false);
    expect(h.options().ultrafast).toBe(false);
    expect(h.listModels).toHaveBeenCalledOnce();
    expect(h.listModels).toHaveBeenCalledWith({ agentId: "main", sessionKey: "agent:main:main" });

    await vi.waitFor(() => expect(h.onCatalogLoaded).toHaveBeenCalledOnce());
    expect(h.options().ultrafast).toBe(true);
    expect(h.listModels).toHaveBeenCalledOnce();
  });
});
