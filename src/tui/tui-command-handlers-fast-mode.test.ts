import type { FastMode } from "@openclaw/normalization-core/string-coerce";
import { describe, expect, it, vi } from "vitest";
import { createTuiCommandHandlersHarness } from "./tui-command-handlers-test-support.js";

describe("tui /fast", () => {
  it.each<{
    command: string;
    params?: NonNullable<Parameters<typeof createTuiCommandHandlersHarness>[0]>;
    patch: object;
  }>([
    {
      command: "/fast on",
      params: { currentSessionKey: "global", currentAgentId: "work" },
      patch: { key: "global", agentId: "work", fastMode: true },
    },
    { command: "/fast off", patch: { key: "agent:main:main", fastMode: false } },
    { command: "/fast auto", patch: { key: "agent:main:main", fastMode: "auto" } },
    { command: "/fast ultrafast", patch: { key: "agent:main:main", fastMode: "ultrafast" } },
    { command: "/fast Ultrafast", patch: { key: "agent:main:main", fastMode: "ultrafast" } },
    {
      command: "/fast default",
      params: { opts: { local: true } },
      patch: { key: "agent:main:main", fastMode: null },
    },
  ])("applies $command through the session setting owner", async ({ command, params, patch }) => {
    const result = { fastMode: "ultrafast" };
    const h = createTuiCommandHandlersHarness({
      ...params,
      patchSession: vi.fn().mockResolvedValue(result),
    });
    await h.handleCommand(command);
    expect(h.patchSession).toHaveBeenCalledWith(patch);
    expect(h.applySessionInfoFromPatch).toHaveBeenCalledWith(result);
    expect(h.refreshSessionInfo).toHaveBeenCalledOnce();
    expect(h.loadHistory).not.toHaveBeenCalled();
    expect(h.addSystem).toHaveBeenCalledWith(`fast mode set to ${command.slice(6)}`);
  });

  it.each<[FastMode | undefined, string]>([
    [undefined, "off"],
    [true, "on"],
    ["auto", "auto"],
    ["ultrafast", "ultrafast"],
  ])("reports %s session fast mode as %s", async (fastMode, label) => {
    const h = createTuiCommandHandlersHarness();
    h.state.sessionInfo.fastMode = fastMode;
    await h.handleCommand("/fast status");
    await h.handleCommand("/fast");
    expect(h.addSystem.mock.calls).toEqual([[`fast mode: ${label}`], [`fast mode: ${label}`]]);
    expect(h.patchSession).not.toHaveBeenCalled();
  });

  it("reports usage for an unknown mode without patching the session", async () => {
    const h = createTuiCommandHandlersHarness();
    await h.handleCommand("/fast hyperspeed");
    expect(h.addSystem).toHaveBeenCalledWith("usage: /fast <status|auto|on|off|ultrafast|default>");
    expect(h.patchSession).not.toHaveBeenCalled();
  });
});
