import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { createPluginRuntimeMock } from "openclaw/plugin-sdk/plugin-test-runtime";
import { z } from "zod";
import { threadStartResult, turnStartResult } from "./codex-app-server.test-fixtures.js";
import { ownCodexInferenceClient } from "./inference-routing.js";
import { isJsonObject, type JsonObject } from "./protocol.js";
import type { runCodexAppServerAttempt } from "./run-attempt.js";
import { trackIsolatedCodexAppServerClient } from "./shared-client.js";
import { createClientHarness, stubCodexInferenceTransportEnv } from "./test-support.js";
import { CODEX_APP_SERVER_VERSION } from "./version.js";

type Run = typeof runCodexAppServerAttempt;

/** Script only the external server; activation, input custody and settlement stay real. */
export async function runRecoveryQueueAttempt(
  run: Run,
  params: Parameters<Run>[0],
  options: Parameters<Run>[1],
  model: (params: Parameters<Run>[0]) => Promise<unknown>,
) {
  stubCodexInferenceTransportEnv();
  const { placementNodeId } = z
    .object({ placementNodeId: z.string().min(1) })
    .parse(params.sandbox);
  const activated = createDeferred<void>();
  const userPersisted = createDeferred<void>();
  if (params.suppressNextUserMessagePersistence) {
    userPersisted.resolve();
  }
  const runtime = createPluginRuntimeMock({
    nodes: {
      list: async () => ({
        nodes: [
          {
            nodeId: placementNodeId,
            commandFeatures: { "codex.exec-server.stdio.v1": ["github-profile-refresh"] },
          },
        ],
      }),
      openDuplex: async (request) => {
        request.assertCurrent?.();
        const closed = createDeferred<unknown>();
        return {
          send: async () => {
            request.assertCurrent?.();
          },
          onMessage: () => () => {},
          closed: closed.promise,
          close: () => closed.resolve({ ok: true }),
        };
      },
    },
  });
  const threadId = "recovery-thread";
  const turnId = "recovery-turn-" + params.runId;
  let active = false;
  let loaded = false;
  let generation = 0;
  let serverWork: Promise<void> = Promise.resolve();
  const notify = (method: string, fields: JsonObject) =>
    wire.send({ method, params: { threadId, turnId, ...fields } });
  const echo = (request: JsonObject) => {
    notify("item/completed", {
      item: {
        type: "userMessage",
        id: "user-" + generation,
        clientId:
          typeof request.clientUserMessageId === "string" ? request.clientUserMessageId : null,
        content: Array.isArray(request.input) ? request.input : [],
      },
    });
  };
  const complete = (request: JsonObject) => {
    const current = ++generation;
    serverWork = (async () => {
      await activated.promise;
      if (!active || current !== generation) {
        return;
      }
      echo(request);
      // The privileged fixture probe starts after the real host commits its input,
      // rather than racing prompt projection as an out-of-band tool call.
      await userPersisted.promise;
      if (!active || current !== generation) return;
      await model(params);
      if (!active || current !== generation) {
        return;
      }
      notify("item/completed", {
        item: {
          type: "agentMessage",
          id: "answer",
          text: "Accepted native queued input completed",
        },
      });
      active = false;
      notify("turn/completed", { turn: turnStartResult(turnId, "completed").turn });
    })().catch((error: unknown) => {
      active = false;
      notify("turn/completed", {
        turn: {
          ...turnStartResult(turnId, "failed").turn,
          error: { message: error instanceof Error ? error.message : String(error) },
        },
      });
    });
  };
  const respond = (method: string, request: JsonObject): unknown => {
    switch (method) {
      case "initialize":
        return { userAgent: "openclaw/" + CODEX_APP_SERVER_VERSION };
      case "config/read":
        return { config: {}, origins: {}, layers: [] };
      case "configRequirements/read":
        return { requirements: null };
      case "account/read":
        return { account: { type: "apiKey" }, requiresOpenaiAuth: true };
      case "model/list":
        return {
          data: [
            {
              id: params.modelId,
              model: params.modelId,
              displayName: params.modelId,
              supportedReasoningEfforts: [{ reasoningEffort: "medium", description: "Medium" }],
              defaultReasoningEffort: "medium",
              inputModalities: ["text"],
              isDefault: true,
            },
          ],
        };
      case "thread/start":
      case "thread/resume":
        loaded = true;
        return { ...threadStartResult(threadId, params.workspaceDir), model: params.modelId };
      case "thread/read":
        return {
          thread: {
            ...threadStartResult(threadId, params.workspaceDir).thread,
            status: active
              ? { type: "active", activeFlags: [] }
              : { type: loaded ? "idle" : "notLoaded" },
          },
        };
      case "thread/unsubscribe": {
        if (active) {
          throw new Error("cannot unload an active recovery turn");
        }
        const status = loaded ? "unsubscribed" : "notLoaded";
        loaded = false;
        notify("thread/status/changed", { status: { type: "notLoaded" } });
        return { status };
      }
      case "turn/start":
        active = true;
        complete(request);
        return turnStartResult(turnId);
      case "turn/steer":
        if (!active || request.expectedTurnId !== turnId) {
          throw new Error("no matching active turn to steer");
        }
        echo(request);
        return { turnId };
      case "turn/interrupt":
        active = false;
        generation += 1;
        notify("turn/completed", { turn: turnStartResult(turnId, "interrupted").turn });
        return {};
      case "thread/backgroundTerminals/clean":
      case "thread/inject_items":
      case "config/batchWrite":
      case "environment/add":
        return {};
      default:
        throw new Error("Unscripted recovery Codex request: " + method);
    }
  };
  const wire = createClientHarness({
    onWrite(line, send) {
      const message: unknown = JSON.parse(line);
      if (
        !isJsonObject(message) ||
        typeof message.method !== "string" ||
        message.id === undefined
      ) {
        return;
      }
      try {
        send({
          id: message.id,
          result: respond(message.method, isJsonObject(message.params) ? message.params : {}),
        });
      } catch (error) {
        send({
          id: message.id,
          error: { code: -32603, message: error instanceof Error ? error.message : String(error) },
        });
      }
    },
  });
  try {
    return await run(
      {
        ...params,
        onUserMessagePersisted(message) {
          userPersisted.resolve();
          params.onUserMessagePersisted?.(message);
        },
        onExecutionPhase(event) {
          params.onExecutionPhase?.(event);
          if (event.phase === "turn_accepted") {
            activated.resolve();
          }
        },
      },
      {
        ...options,
        runtime,
        clientFactory: async () => {
          trackIsolatedCodexAppServerClient(wire.client);
          await wire.client.initialize();
          ownCodexInferenceClient(wire.client);
          return wire.client;
        },
      },
    );
  } finally {
    active = false;
    activated.resolve();
    userPersisted.resolve();
    await wire.client.closeAndWait();
    await serverWork;
  }
}
