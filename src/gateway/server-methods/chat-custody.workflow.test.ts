import { X509Certificate } from "node:crypto";
import { text as readText } from "node:stream/consumers";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { expect, it, vi } from "vitest";
import { GatewayProtocolRequestError } from "../../../packages/gateway-client/src/protocol-request.js";
import { WebSocket } from "../../../packages/gateway-client/src/websocket.js";
import { writeOpenAiResponsesText } from "../../../test/helpers/openai-responses-sse.js";
import {
  awaitGateBeforeSettlement,
  createDeferred,
  withinTest,
} from "../../../test/helpers/promise.js";
import { observeHostDataSql } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import { TEST_TLS_CERT_PEM, TEST_TLS_KEY_PEM } from "../../../test/helpers/tls-fixture.js";
import * as dispatchOwner from "../../auto-reply/dispatch.js";
import * as replyAdmission from "../../auto-reply/reply/reply-turn-admission.js";
import {
  appendTranscriptMessage,
  loadTranscriptEventsSync,
  replaceSessionEntry,
} from "../../config/sessions/session-accessor.js";
import { listSessionPendingInputs } from "../../config/sessions/session-accessor.pending-inputs.js";
import * as custody from "../../config/sessions/session-accessor.pending-inputs.js";
import { listSessionPendingInputReceipts } from "../../config/sessions/session-accessor.sqlite-pending-input-receipts.js";
import {
  loadOrCreateDeviceIdentity,
  publicKeyRawBase64UrlFromPem,
} from "../../infra/device-identity.js";
import { approveDevicePairing } from "../../infra/device-pairing-approval.js";
import { requestDevicePairing } from "../../infra/device-pairing.js";
import { withServer } from "../../plugin-sdk/test-helpers/http-test-server.js";
import { getGlobalPluginRegistry } from "../../plugins/hook-runner-global.js";
import type { PluginHookBeforeMessageWriteEvent } from "../../plugins/types.js";
import { getSessionWorkAdmissionRelease } from "../../sessions/session-lifecycle-admission.js";
import * as skillSelection from "../../skills/library/selection.js";
import * as skillService from "../../skills/library/service.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import * as queuedTurnOwner from "../chat-queued-turns.js";
import { refusePendingInputCommit } from "../pending-input-commit.test-support.js";
import { loadSessionEntry as loadGatewaySession } from "../session-utils.js";
import {
  connectGatewayClient,
  disconnectGatewayClient,
  startGatewayWithClient,
} from "../test-helpers.e2e.js";
import { buildMockOpenAiResponsesProvider } from "../test-openai-responses-model.js";
import { readChatPendingInputs } from "./chat-pending-inputs.js";
import * as chatDispatch from "./chat-send-agent-dispatch.js";
import * as chatDiagnostics from "./chat-send-diagnostics.js";
import * as chatSetup from "./chat-send-setup.js";
import * as sessionChangeEvent from "./session-change-event.js";

function expectAssistantMessages(
  events: ReturnType<typeof loadTranscriptEventsSync>,
  count: number,
  text: string,
) {
  expect(
    events.filter((event) => event.type === "message" && event.message?.role === "assistant"),
  ).toMatchObject(
    Array.from({ length: count }, () => ({
      type: "message",
      message: { role: "assistant", content: [{ type: "text", text }] },
    })),
  );
}

it("carries registered chat custody through real reply admission and external model delivery", async ({
  signal,
}) => {
  const sessionKey = "agent:main:custody-workflow";
  const runId = "custody-workflow-run";
  const modelEntered = createDeferred<unknown>();
  const releaseModel = createDeferred();
  const admissions: string[] = [];
  const busyEntered = createDeferred();
  const releaseBusy = createDeferred();
  let holdNextModel = false;
  const withdrawnRegistered =
    createDeferred<Parameters<typeof queuedTurnOwner.registerQueuedChatTurn>[0]>();
  const registrationWaiters = new Map<string, ReturnType<typeof createDeferred<void>>>();
  const registerActual = queuedTurnOwner.registerQueuedChatTurn;
  const registered = vi
    .spyOn(queuedTurnOwner, "registerQueuedChatTurn")
    .mockImplementation((params) => {
      const result = registerActual(params);
      if (result) registrationWaiters.get(params.runId)?.resolve();
      if (result && params.runId === "queued-discarded") withdrawnRegistered.resolve(params);
      return result;
    });
  const terminalWaiters = new Map<
    string,
    ReturnType<typeof createDeferred<Record<string, unknown>>>
  >();
  const extraClients: Awaited<ReturnType<typeof connectGatewayClient>>[] = [];
  let gateEnabled = false;
  let heldInputId = runId;
  let custodyEntered = createDeferred();
  let releaseCustody = createDeferred();
  let observeSend: ((payload: Record<string, unknown>) => void) | undefined;
  const emitActual = sessionChangeEvent.emitSessionsChanged;
  const published = vi
    .spyOn(sessionChangeEvent, "emitSessionsChanged")
    .mockImplementation((...args) => {
      const result = emitActual(...args);
      observeSend?.(args[1]);
      return result;
    });
  const stageActual = custody.stageSessionPendingInput;
  const staged = vi
    .spyOn(custody, "stageSessionPendingInput")
    .mockImplementation(async (...args) => {
      if (gateEnabled && args[1].runId === heldInputId) {
        custodyEntered.resolve();
        await releaseCustody.promise;
      }
      return stageActual(...args);
    });
  let providerCalls = 0;
  const actualAdmit = replyAdmission.admitReplyTurn;
  const observed = vi.spyOn(replyAdmission, "admitReplyTurn").mockImplementation(async (params) => {
    const result = await actualAdmit(params);
    if (params.sessionKey === sessionKey) admissions.push(result.status);
    return result;
  });
  try {
    await withServer(
      (request, response) => {
        void (async () => {
          if (!request.url?.endsWith("/responses")) throw new Error("Unexpected provider route");
          providerCalls += 1;
          modelEntered.resolve(JSON.parse(await readText(request)));
          if (holdNextModel) {
            holdNextModel = false;
            busyEntered.resolve();
            await releaseBusy.promise;
          } else await releaseModel.promise;
          writeOpenAiResponsesText(response, {
            text: "Committed custody reply",
            messageId: "custody-message",
            responseId: "custody-response",
          });
        })().catch((error: unknown) =>
          response.destroy(error instanceof Error ? error : undefined),
        );
      },
      async (baseUrl) => {
        await withOpenClawTestState(
          {
            scenario: "minimal",
            env: {
              OPENCLAW_SKIP_CHANNELS: "1",
              OPENCLAW_SKIP_CRON: "1",
              // The controlled provider is local, independent of host proxy configuration.
              NO_PROXY: "127.0.0.1,localhost",
              no_proxy: "127.0.0.1,localhost",
            },
          },
          async (state) => {
            const provider = buildMockOpenAiResponsesProvider(baseUrl + "/v1", "custody-model");
            const pairClient = async (id: string, mode: string) => {
              const name = (id + "-" + mode + "-" + process.platform + "-none-operator")
                .replace(/[^a-zA-Z0-9._-]+/g, "_")
                .toLowerCase();
              const identity = loadOrCreateDeviceIdentity({
                path: state.statePath("test-device-identities", name + ".sqlite"),
              });
              const requested = await requestDevicePairing({
                deviceId: identity.deviceId,
                publicKey: publicKeyRawBase64UrlFromPem(identity.publicKeyPem),
                role: "operator",
                scopes: ["operator.read", "operator.write"],
                clientId: id,
                clientMode: mode,
                platform: process.platform,
                browserOrigin: "https://custody.example.test",
                silent: false,
              });
              expect(
                (
                  await approveDevicePairing(requested.request.requestId, {
                    callerScopes: ["operator.read", "operator.write"],
                  })
                )?.status,
              ).toBe("approved");
              return identity;
            };
            await pairClient("openclaw-control-ui", "webchat");
            const certPath = await state.writeText("tls/cert.pem", TEST_TLS_CERT_PEM);
            const keyPath = await state.writeText("tls/key.pem", TEST_TLS_KEY_PEM);
            const tlsFingerprint = new X509Certificate(TEST_TLS_CERT_PEM).fingerprint256;
            const email = "custody-alice@example.test";
            const auth = {
              mode: "trusted-proxy" as const,
              trustedProxy: {
                userHeader: "x-forwarded-user",
                requiredHeaders: ["x-forwarded-proto"],
                allowLoopback: true,
                deviceAutoApprove: { enabled: true, scopes: ["operator.read", "operator.write"] },
              },
            };
            const headers = {
              "x-forwarded-for": "203.0.113.50",
              "x-forwarded-proto": "https",
              "x-forwarded-user": email,
            };
            const config = {
              agents: {
                defaults: {
                  workspace: state.workspaceDir,
                  skipBootstrap: true,
                  heartbeat: { every: "0m" },
                  model: { primary: provider.modelRef },
                  models: {
                    [provider.modelRef]: {
                      agentRuntime: { id: "openclaw" },
                      params: { transport: "sse", openaiWsWarmup: false },
                    },
                  },
                },
              },
              models: {
                mode: "replace",
                providers: {
                  [provider.providerId]: {
                    ...provider.config,
                    request: { allowPrivateNetwork: true },
                  },
                },
              },
              plugins: { slots: { memory: "none" } },
              tools: { profile: "minimal" },
              gateway: {
                auth,
                tls: { enabled: true, autoGenerate: false, certPath, keyPath },
                trustedProxies: ["127.0.0.1"],
                controlUi: { allowedOrigins: ["https://custody.example.test"] },
              },
            };
            const gateway = await startGatewayWithClient({
              cfg: config,
              configPath: state.configPath,
              auth,
              edgeAuthHeaders: headers,
              secure: true,
              tlsFingerprint,
              clientName: "openclaw-control-ui",
              mode: "webchat",
              origin: "https://custody.example.test",
              scopes: ["operator.read", "operator.write"],
              onEvent: (event) => {
                const payload = event.payload as Record<string, unknown> | undefined;
                if (
                  event.event === "chat" &&
                  typeof payload?.runId === "string" &&
                  ["final", "error", "aborted"].includes(String(payload.state))
                ) {
                  terminalWaiters.get(payload.runId)?.resolve(payload);
                }
              },
            });
            const scope = {
              agentId: "main",
              sessionKey,
              sessionId: "custody-workflow-session",
              storePath: loadGatewaySession(sessionKey).storePath,
            };
            let sending: Promise<unknown> | undefined;
            let refusal: ReturnType<typeof refusePendingInputCommit> | undefined;
            const sql = observeHostDataSql();
            try {
              const self = await gateway.client.request<{ profile: { id: string } }>(
                "users.self",
                {},
              );
              await replaceSessionEntry(scope, {
                sessionId: scope.sessionId,
                lifecycleRevision: "custody-lifecycle",
                updatedAt: Date.now(),
                status: "done",
                queueDebounceMs: 0,
                createdActor: { type: "human", source: "profile", id: self.profile.id },
              });
              const input = {
                sessionKey,
                sessionId: scope.sessionId,
                message: "Preserve this exact accepted input",
                idempotencyKey: runId,
              };
              refusal = refusePendingInputCommit({
                operation: "stage",
                message: "Synthetic custody commit refusal",
                sessionId: scope.sessionId,
                runId,
              });
              await expect(gateway.client.request("chat.send", input)).rejects.toThrow(
                "Synthetic custody commit refusal",
              );
              await gateway.client.request("health", {});
              expect((await listSessionPendingInputs(scope)).items).toEqual([]);
              expect(loadTranscriptEventsSync(scope)).toEqual([]);
              expect(providerCalls).toBe(0);
              expect(admissions).toEqual([]);
              refusal.mockRestore();
              gateEnabled = true;
              const terminal = createDeferred<Record<string, unknown>>();
              terminalWaiters.set(runId, terminal);
              const heldSend = async (
                client: typeof gateway.client,
                request: typeof input & { queueMode?: string },
                assertHeld: () => Promise<void>,
              ) => {
                gateEnabled = true;
                heldInputId = request.idempotencyKey;
                custodyEntered = createDeferred();
                releaseCustody = createDeferred();
                let acknowledged = false;
                const ack = client
                  .request<{ runId: string; status: string; messageSeq?: number }>(
                    "chat.send",
                    request,
                  )
                  .then((value) => {
                    acknowledged = true;
                    return value;
                  });
                sending = ack;
                try {
                  await withinTest(
                    awaitGateBeforeSettlement(
                      custodyEntered.promise,
                      ack,
                      "ACK preceded custody entry",
                    ),
                    signal,
                  );
                  // A later RPC response fences delivery without sleeping or polling.
                  await client.request("health", {});
                  expect(acknowledged).toBe(false);
                  await assertHeld();
                } finally {
                  releaseCustody.resolve();
                }
                return await ack;
              };
              const ack = await heldSend(gateway.client, input, async () => {
                expect((await listSessionPendingInputs(scope)).items).toEqual([]);
                expect(loadTranscriptEventsSync(scope)).toEqual([]);
              });
              expect(ack).toMatchObject({ runId, status: "started", messageSeq: 1 });
              expect(loadTranscriptEventsSync(scope)).toContainEqual(
                expect.objectContaining({
                  message: expect.objectContaining({
                    role: "user",
                    content: "Preserve this exact accepted input",
                    idempotencyKey: runId + ":user",
                  }),
                }),
              );
              await withinTest(
                Promise.race([
                  modelEntered.promise,
                  terminal.promise.then((event) => {
                    throw new Error(
                      "Run ended before provider entry: " + JSON.stringify({ event, admissions }),
                    );
                  }),
                ]),
                signal,
              );
              expect(admissions).toContain("owned");
              expect((await listSessionPendingInputs(scope)).items).toEqual([]);
              const completed = getSessionWorkAdmissionRelease({
                scope: scope.storePath,
                identities: [sessionKey, scope.sessionId],
              });
              expect(completed).toBeDefined();
              releaseModel.resolve();
              expect(await withinTest(terminal.promise, signal)).toMatchObject({ state: "final" });
              await withinTest(completed!, signal);
              const transcript = loadTranscriptEventsSync(scope);
              expectAssistantMessages(transcript, 1, "Committed custody reply");
              expect(
                transcript.filter(
                  (event) => event.type === "message" && event.message?.role === "user",
                ),
              ).toHaveLength(1);
              const admissionCount = admissions.length;
              const stageCount = staged.mock.calls.length;
              const replay = await gateway.client.request<{ runId: string }>("chat.send", input);
              expect(replay.runId).toBe(runId);
              expect(admissions).toHaveLength(admissionCount);
              expect(staged.mock.calls).toHaveLength(stageCount);
              expect(providerCalls).toBe(1);
              expect(loadTranscriptEventsSync(scope)).toEqual(transcript);
              // Reuse the same real runtime; only the provider response is held while
              // authenticated transports publish, then consume, their queued input.
              const registry = getGlobalPluginRegistry();
              if (!registry) throw new Error("Missing active hook registry");
              const originalHooks = registry.typedHooks.slice();
              const approvals: string[] = [];
              registry.typedHooks.push({
                pluginId: "custody-workflow-approval",
                hookName: "before_message_write",
                source: "test",
                handler: ({ message }: PluginHookBeforeMessageWriteEvent) => {
                  if (
                    message.role !== "user" ||
                    typeof message.content !== "string" ||
                    !message.content.startsWith("Raw queued ")
                  )
                    return;
                  approvals.push(message.content);
                  return {
                    message: {
                      ...message,
                      content: message.content.replace("Raw queued ", "Approved queued "),
                    },
                  };
                },
              });
              try {
                const busyRunId = "custody-busy-run";
                const busyTerminal = createDeferred<Record<string, unknown>>();
                terminalWaiters.set(busyRunId, busyTerminal);
                holdNextModel = true;
                await gateway.client.request("chat.send", {
                  ...input,
                  idempotencyKey: busyRunId,
                  message: "Keep the native runtime busy",
                });
                await withinTest(busyEntered.promise, signal);
                const activeTranscript = loadTranscriptEventsSync(scope);
                await replaceSessionEntry(
                  { agentId: "main", sessionKey: "agent:main:custody-unrelated" },
                  {
                    sessionId: "unrelated-browser-session",
                    updatedAt: Date.now(),
                    skillsSnapshot: {
                      prompt: "Unrelated session context. ".repeat(128),
                      skills: [],
                    },
                  },
                );
                const queued: Array<{
                  id: string;
                  content: string;
                  terminal: ReturnType<typeof createDeferred<Record<string, unknown>>>;
                }> = [];
                const transportRows = [
                  { id: "openclaw-control-ui", mode: "webchat", displayName: "Web" },
                  { id: "cli", mode: "cli", displayName: "CLI" },
                  { id: "openclaw-macos", mode: "ui", displayName: "macOS" },
                  { id: "gateway-client", mode: "backend", displayName: "Automation" },
                ] as const;
                for (const clientInfo of transportRows) {
                  const deviceIdentity = await pairClient(clientInfo.id, clientInfo.mode);
                  const client = await connectGatewayClient({
                    url: "wss://127.0.0.1:" + gateway.port,
                    tlsFingerprint,
                    edgeAuthHeaders: headers,
                    origin: "https://custody.example.test",
                    clientName: clientInfo.id,
                    mode: clientInfo.mode,
                    clientDisplayName: clientInfo.displayName,
                    scopes: ["operator.read", "operator.write"],
                    deviceIdentity,
                  });
                  extraClients.push(client);
                  expect(
                    (await client.request<{ profile: { id: string } }>("users.self", {})).profile
                      .id,
                  ).toBe(self.profile.id);
                  const id = "queued-" + clientInfo.id;
                  const content = "Approved queued " + clientInfo.id;
                  const terminal = createDeferred<Record<string, unknown>>();
                  terminalWaiters.set(id, terminal);
                  const queueRegistration = createDeferred();
                  registrationWaiters.set(id, queueRegistration);
                  const notification =
                    createDeferred<Awaited<ReturnType<typeof listSessionPendingInputs>>>();
                  let publicationObserved = false;
                  observeSend = (payload) => {
                    if (payload.reason === "send" && payload.sessionKey === sessionKey) {
                      publicationObserved = true;
                      void listSessionPendingInputs(scope).then(
                        notification.resolve,
                        notification.reject,
                      );
                    }
                  };
                  const clone = vi.spyOn(globalThis, "structuredClone");
                  try {
                    const ack = await heldSend(
                      client,
                      {
                        ...input,
                        idempotencyKey: id,
                        message: "Raw queued " + clientInfo.id,
                        queueMode: "followup",
                      },
                      async () => {
                        expect(publicationObserved).toBe(false);
                        expect(
                          (await listSessionPendingInputs(scope)).items.some(
                            (item) => item.runId === id,
                          ),
                        ).toBe(false);
                      },
                    );
                    expect(ack).toMatchObject({ runId: id, status: "started" });
                    expect(ack).not.toHaveProperty("messageSeq");
                    expect(publicationObserved).toBe(true);
                    expect(loadTranscriptEventsSync(scope)).toEqual(activeTranscript);
                    const pending = (await listSessionPendingInputs(scope)).items;
                    expect(pending).toHaveLength(queued.length + 1);
                    expect(pending.find((item) => item.runId === id)).toMatchObject({
                      state: "queued",
                      message: {
                        role: "user",
                        content,
                        idempotencyKey: id + ":user",
                        __openclaw: {
                          senderId: self.profile.id,
                          senderIdentity: { type: "profile", id: self.profile.id },
                          transport: { clients: [clientInfo] },
                        },
                      },
                    });
                    expect(await withinTest(notification.promise, signal)).toEqual({
                      items: pending,
                      total: pending.length,
                    });
                    await withinTest(queueRegistration.promise, signal);
                    expect(
                      clone.mock.calls.filter(
                        ([entry]) =>
                          isRecord(entry) && entry.sessionId === "unrelated-browser-session",
                      ).length,
                    ).toBeLessThanOrEqual(1);
                    queued.push({ id, content, terminal });
                  } finally {
                    clone.mockRestore();
                    observeSend = undefined;
                  }
                }
                const discardedId = "queued-discarded";
                const discardedTerminal = createDeferred<Record<string, unknown>>();
                const discardInput = {
                  ...input,
                  idempotencyKey: discardedId,
                  message: "Raw queued discarded",
                  queueMode: "followup",
                };
                const admissionsBeforeFailure = admissions.length;
                refusal = refusePendingInputCommit({
                  operation: "stage",
                  message: "Queued custody unavailable",
                  sessionId: scope.sessionId,
                  runId: discardedId,
                });
                {
                  using setup = vi.spyOn(chatSetup, "prepareAndAdmitChatSend");
                  using dispatch = vi.spyOn(chatDispatch, "startChatDispatch");
                  const failure = await gateway.client
                    .request("chat.send", discardInput)
                    .catch((error: unknown) => error);
                  const prepared = await setup.mock.results[0]?.value;
                  try {
                    expect(failure).toBeInstanceOf(GatewayProtocolRequestError);
                    expect(failure).toMatchObject({
                      message: expect.stringContaining("Queued custody unavailable"),
                      responsePayload: { status: "error", runId: discardedId },
                    });
                    expect(prepared?.session.clientRunId).toBe(discardedId);
                    expect(prepared?.admission.activeRunAbort.registered).toBe(true);
                    expect(
                      setup.mock.calls[0]?.[0].context.chatAbortControllers.has(discardedId),
                    ).toBe(false);
                    expect(prepared?.admission.gatewayWorkAdmission.isActive()).toBe(false);
                    await withinTest(prepared!.admission.gatewayWorkAdmission.released, signal);
                    expect(
                      dispatch.mock.calls.some(
                        ([params]) => params.session.clientRunId === discardedId,
                      ),
                    ).toBe(false);
                  } finally {
                    prepared?.admission.activeRunAbort.cleanup();
                    prepared?.admission.releaseSourceWorkAdmission();
                  }
                }
                expect(
                  (await listSessionPendingInputs(scope)).items.some(
                    (item) => item.runId === discardedId,
                  ),
                ).toBe(false);
                expect(admissions).toHaveLength(admissionsBeforeFailure);
                expect(loadTranscriptEventsSync(scope)).toEqual(activeTranscript);
                expect(providerCalls).toBe(2);
                refusal.mockRestore();
                await gateway.client.request("health", {});
                terminalWaiters.set(discardedId, discardedTerminal);
                expect(await gateway.client.request("chat.send", discardInput)).toMatchObject({
                  runId: discardedId,
                  status: "started",
                });
                const removable = await withinTest(withdrawnRegistered.promise, signal);
                const pendingBeforeRemoval = await listSessionPendingInputs(scope);
                expect(
                  pendingBeforeRemoval.items.find((item) => item.runId === discardedId),
                ).toMatchObject({
                  state: "queued",
                  message: { content: "Approved queued discarded" },
                });
                const refuseWithdrawal = refusePendingInputCommit({
                  operation: "withdraw",
                  message: "Synthetic withdrawal commit refusal",
                  sessionId: scope.sessionId,
                  runId: discardedId,
                });
                const discard = { sessionKey, runId: discardedId, discardPendingInput: true };
                try {
                  await expect(gateway.client.request("chat.abort", discard)).rejects.toThrow(
                    "Synthetic withdrawal commit refusal",
                  );
                  expect(await listSessionPendingInputs(scope)).toEqual(pendingBeforeRemoval);
                  expect(removable.controller.signal.aborted).toBe(false);
                  expect(loadTranscriptEventsSync(scope)).toEqual(activeTranscript);
                  expect(providerCalls).toBe(2);
                } finally {
                  refuseWithdrawal.mockRestore();
                }
                expect(await gateway.client.request("chat.abort", discard)).toEqual({
                  ok: true,
                  aborted: true,
                  runIds: [discardedId],
                });
                expect(await withinTest(discardedTerminal.promise, signal)).toMatchObject({
                  state: "aborted",
                });
                expect(removable.controller.signal.aborted).toBe(true);
                const withdrawn = (await listSessionPendingInputs(scope)).items.find(
                  (item) => item.runId === discardedId,
                );
                expect(withdrawn).toMatchObject({
                  state: "cancelled",
                  message: { display: false },
                });
                const page = await readChatPendingInputs(scope, { limit: 20, maxChars: 1000 });
                expect(
                  page.items.find((item) => item.runId === discardedId)?.message,
                ).toMatchObject({ display: false, content: [] });
                expect(JSON.stringify(page)).not.toContain("Approved queued discarded");
                expect(listSessionPendingInputReceipts(scope, { runIds: [discardedId] })).toEqual([
                  { runId: discardedId, state: "pending", cancelled: true },
                ]);
                const completeQueue = getSessionWorkAdmissionRelease({
                  scope: scope.storePath,
                  identities: [sessionKey, scope.sessionId],
                });
                expect(completeQueue).toBeDefined();
                releaseBusy.resolve();
                expect(await withinTest(busyTerminal.promise, signal)).toMatchObject({
                  state: "final",
                });
                for (const row of queued)
                  expect(await withinTest(row.terminal.promise, signal)).toMatchObject({
                    state: "final",
                  });
                await withinTest(completeQueue!, signal);
                expect((await listSessionPendingInputs(scope)).items).toEqual([withdrawn]);
                const committed = loadTranscriptEventsSync(scope);
                for (const [index, row] of queued.entries()) {
                  const messages = committed.filter(
                    (event) =>
                      event.type === "message" &&
                      event.message?.idempotencyKey === row.id + ":user",
                  );
                  expect(messages).toMatchObject([
                    {
                      message: {
                        role: "user",
                        content: row.content,
                        __openclaw: {
                          senderIdentity: { type: "profile", id: self.profile.id },
                          transport: { clients: [transportRows[index]] },
                        },
                      },
                    },
                  ]);
                }
                expect(approvals).toEqual([
                  ...transportRows.map((row) => "Raw queued " + row.id),
                  "Raw queued discarded",
                  "Raw queued discarded",
                ]);
                expectAssistantMessages(committed, 6, "Committed custody reply");
                expect(providerCalls).toBe(6);
              } finally {
                releaseBusy.resolve();
                registry.typedHooks.splice(0, registry.typedHooks.length, ...originalHooks);
              }
              gateEnabled = false;
              // Each fault has its own durable history, but shares the initialized runtime.
              for (const [preparation, outcome, expectedState] of [
                ["selection", "dispatch", "final"],
                ["authoring", "dispatch", "final"],
                ["authoring", "failure", "error"],
                ["authoring", "cancel", "aborted"],
              ] as const) {
                const id = "prep-" + preparation + "-" + outcome;
                const target = { ...scope, sessionKey: sessionKey + "-" + id, sessionId: id };
                await replaceSessionEntry(target, {
                  sessionId: id,
                  lifecycleRevision: id + "-lifecycle",
                  updatedAt: Date.now(),
                  status: "done",
                  createdActor: { type: "human", source: "profile", id: self.profile.id },
                });
                await appendTranscriptMessage(target, {
                  message: { role: "user", content: "Earlier preparation history", timestamp: 1 },
                });
                const prefix = loadTranscriptEventsSync(target);
                const message = "Private preparation input " + id;
                const entered = createDeferred();
                const release = createDeferred();
                let released = false;
                const terminal = createDeferred<Record<string, unknown>>();
                terminalWaiters.set(id, terminal);
                const wait = async () => {
                  entered.resolve();
                  await release.promise;
                  if (outcome === "failure") throw new Error("Skill authoring preparation failed");
                };
                const seed = skillSelection.seedSkillLibrarySelection;
                const present = skillService.resolveSkillLibraryPresentation;
                const preparationSpy =
                  preparation === "selection"
                    ? vi
                        .spyOn(skillSelection, "seedSkillLibrarySelection")
                        .mockImplementation(async (...args) => {
                          await wait();
                          return seed(...args);
                        })
                    : vi
                        .spyOn(skillService, "resolveSkillLibraryPresentation")
                        .mockImplementation(async (...args) => {
                          await wait();
                          return present(...args);
                        });
                const actualDispatch = dispatchOwner.dispatchInboundMessageWithProjectedDispatcher;
                const dispatchedWhileHeld: boolean[] = [];
                const dispatch = vi
                  .spyOn(dispatchOwner, "dispatchInboundMessageWithProjectedDispatcher")
                  .mockImplementation((params) => {
                    dispatchedWhileHeld.push(!released);
                    return actualDispatch(params);
                  });
                const phaseLogs: Array<[string, Record<string, unknown>?]> = [];
                const diagnostics = chatDiagnostics.startChatSendDiagnostics;
                const log = vi
                  .spyOn(chatDiagnostics, "startChatSendDiagnostics")
                  .mockImplementation((sink) =>
                    diagnostics({
                      info: (...args) => {
                        phaseLogs.push(args);
                        sink.info(...args);
                      },
                    }),
                  );
                const wire = vi.spyOn(WebSocket.prototype, "send");
                const responses = () =>
                  wire.mock.calls.filter(([data]) => {
                    const frame: unknown = typeof data === "string" ? JSON.parse(data) : undefined;
                    return (
                      isRecord(frame) &&
                      frame.type === "res" &&
                      isRecord(frame.payload) &&
                      frame.payload.runId === id
                    );
                  });
                const calls = providerCalls;
                const sending = gateway.client.request("chat.send", {
                  sessionKey: target.sessionKey,
                  sessionId: id,
                  idempotencyKey: id,
                  message,
                });
                try {
                  await withinTest(
                    awaitGateBeforeSettlement(
                      entered.promise,
                      terminal.promise,
                      "Run ended before preparation entry",
                    ),
                    signal,
                  );
                  expect(responses()).toHaveLength(1);
                  expect(await sending).toMatchObject({
                    runId: id,
                    status: "started",
                    messageSeq: 2,
                  });
                  await gateway.client.request("health", {});
                  const admitted = loadTranscriptEventsSync(target);
                  expect(admitted.slice(0, prefix.length)).toEqual(prefix);
                  expect(admitted).toHaveLength(prefix.length + 1);
                  expect(admitted.at(-1)).toMatchObject({
                    message: {
                      role: "user",
                      content: message,
                      idempotencyKey: id + ":user",
                    },
                  });
                  expect(dispatch).not.toHaveBeenCalled();
                  expect(providerCalls).toBe(calls);
                  for (const name of ["chat.send.inputCustody", "chat.send.inputTranscript"]) {
                    const phases = phaseLogs.filter(
                      ([text, facts]) => text === "run phase" && facts?.name === name,
                    );
                    expect(phases.map(([, facts]) => facts?.status)).toEqual(["entry", "success"]);
                    for (const [, facts] of phases)
                      expect(facts).toMatchObject({
                        owner: "chat",
                        runId: id,
                        sessionId: id,
                        lifecycleGeneration: expect.any(String),
                      });
                  }
                  expect(JSON.stringify(phaseLogs)).not.toContain(message);
                  const complete = getSessionWorkAdmissionRelease({
                    scope: target.storePath,
                    identities: [target.sessionKey, target.sessionId],
                  });
                  expect(complete).toBeDefined();
                  if (outcome === "cancel")
                    expect(
                      await gateway.client.request("chat.abort", {
                        sessionKey: target.sessionKey,
                        runId: id,
                      }),
                    ).toEqual({ ok: true, aborted: true, runIds: [id] });
                  released = true;
                  release.resolve();
                  const result = await withinTest(terminal.promise, signal);
                  expect(result.state).toBe(expectedState);
                  if (outcome === "failure")
                    expect(result.errorMessage).toContain("Skill authoring preparation failed");
                  await withinTest(complete!, signal);
                  expect(responses()).toHaveLength(1);
                  expect(loadTranscriptEventsSync(target).slice(0, admitted.length)).toEqual(
                    admitted,
                  );
                  if (outcome === "dispatch") {
                    expect(dispatch).toHaveBeenCalledOnce();
                    expect(dispatchedWhileHeld).toEqual([false]);
                    expect(dispatch.mock.calls[0]?.[0]).toMatchObject({
                      ctx: { Body: message, MessageSid: id },
                      replyOptions: { skillLibraryAuthoring: { target: "personal" } },
                    });
                    expect(providerCalls).toBe(calls + 1);
                    expectAssistantMessages(
                      loadTranscriptEventsSync(target),
                      1,
                      "Committed custody reply",
                    );
                  } else {
                    expect(dispatch).not.toHaveBeenCalled();
                    expect(providerCalls).toBe(calls);
                  }
                } finally {
                  release.resolve();
                  await sending.catch(() => {});
                  preparationSpy.mockRestore();
                  dispatch.mockRestore();
                  log.mockRestore();
                  wire.mockRestore();
                }
              }
              expect(
                sql.queries.filter((query) =>
                  /\b(?:insert\s+into|update|delete\s+from)\s+["`]?session_(?:pending_inputs|input_completions)\b/i.test(
                    query,
                  ),
                ),
              ).toEqual([]);
            } finally {
              releaseCustody.resolve();
              refusal?.mockRestore();
              sql.restore();
              await sending?.catch(() => {});
              releaseModel.resolve();
              releaseBusy.resolve();
              await Promise.all(extraClients.map(disconnectGatewayClient));
              await disconnectGatewayClient(gateway.client);
              await gateway.server.close();
            }
          },
        );
      },
    );
  } finally {
    registered.mockRestore();
    published.mockRestore();
    observed.mockRestore();
    staged.mockRestore();
  }
});
