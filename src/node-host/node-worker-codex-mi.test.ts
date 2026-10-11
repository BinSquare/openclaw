import { execFile } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import { loadCodexNodeAppServerTestFixture } from "../../extensions/codex/test-api.js";
import { rawDataToString } from "../../packages/gateway-client/src/websocket-data.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { resetSecretRedactionRegistryForTest } from "../logging/secret-redaction-registry.test-support.js";
import type { OpenClawPluginNodeHostCommandContext } from "../plugins/types.node-host.js";
import { reserveTestPortListener } from "../test-utils/port-claims.js";
import { NODE_WORKSPACE_REPOSITORY_COMMAND } from "../worker/node-workspace-protocol.js";
import { withNodeHostPluginInvocation } from "./invoke-plugin-context.js";
import { captureNodeWorkerManagedIdentityTransport } from "./node-worker-environment.js";
import { NodeWorkerWorkspaceRuntime } from "./node-worker-workspace.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => {
  vi.unstubAllEnvs();
  resetSecretRedactionRegistryForTest();
  vi.restoreAllMocks();
});

it("carries the managed workspace transport through native Codex auth.command and a model turn", async ({
  signal,
}) => {
  const header = "synthetic-codex-provider-header";
  const bearer = "synthetic-codex-provider-bearer";
  const audience = "api://913b0ac3-c7f3-49c7-82d5-7a3712848c42";
  const identity = "22fdd00c-31b3-4b46-ab87-e5203f925a65";
  const root = await fs.realpath(tempDirs.make("node-codex-provider-"));
  const caFile =
    process.platform === "darwin" ? "/etc/ssl/cert.pem" : "/etc/ssl/certs/ca-certificates.crt";
  await fs.access(caFile);
  const platformTrust = Object.freeze({
    REQUESTS_CA_BUNDLE: caFile,
    SSL_CERT_FILE: caFile,
    NODE_EXTRA_CA_CERTS: caFile,
    NODE_USE_SYSTEM_CA: "1",
  });
  const shellProbe = `node -e 'const expected=${JSON.stringify(platformTrust)}; if(!Object.entries(expected).every(([key,value])=>process.env[key]===value))process.exit(1); console.log("CA_TRUST_PASS")'`;
  let origin: string;
  const identityRequests: { headerMatches: boolean; purposeMatches: boolean }[] = [];
  const modelRequests: Array<{ authenticated: boolean; model: unknown }> = [];
  const server = await reserveTestPortListener({
    offsets: [0],
    createListener: () =>
      http.createServer((req, res) => {
        const url = new URL(req.url ?? "", "http://127.0.0.1");
        if (url.pathname === "/identity") {
          identityRequests.push({
            headerMatches: req.headers["x-identity-header"] === header,
            purposeMatches:
              url.searchParams.get("resource") === audience &&
              url.searchParams.get("client_id") === identity,
          });
          res.setHeader("Content-Type", "application/json");
          res.end(
            JSON.stringify({
              access_token: bearer,
              resource: audience,
              expires_on: Math.floor(Date.now() / 1000) + 3600,
            }),
          );
          return;
        }
        if (url.pathname.startsWith("/repo.git/")) {
          void fs.readFile(path.join(origin, ".git", url.pathname.slice("/repo.git/".length))).then(
            (bytes) => res.end(bytes),
            () => res.writeHead(404).end(),
          );
          return;
        }
        if (req.method !== "POST" || url.pathname !== "/v1/responses") {
          res.writeHead(404).end();
          return;
        }
        let body = "";
        req.setEncoding("utf8");
        req.on("data", (chunk: string) => {
          body += chunk;
        });
        req.once("end", () => {
          const authenticated = req.headers.authorization === `Bearer ${bearer}`;
          modelRequests.push({ authenticated, model: JSON.parse(body).model });
          if (!authenticated) {
            res.writeHead(401, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: { message: "synthetic credential unavailable" } }));
            return;
          }
          res.writeHead(200, { "Content-Type": "text/event-stream" });
          const item =
            modelRequests.length === 2
              ? {
                  type: "function_call",
                  call_id: "ca-probe",
                  name: "exec_command",
                  arguments: JSON.stringify({
                    cmd: shellProbe,
                    login: false,
                    max_output_tokens: 1000,
                  }),
                }
              : {
                  type: "message",
                  role: "assistant",
                  id: "fixture-answer",
                  content: [{ type: "output_text", text: `MI_PROVIDER_AUTH_PASS ${header}` }],
                };
          const events = [
            { type: "response.created", response: { id: "fixture-response" } },
            {
              type: "response.output_item.done",
              item,
            },
            {
              type: "response.completed",
              response: {
                id: "fixture-response",
                usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 },
              },
            },
          ];
          res.end(
            events
              .map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
              .join(""),
          );
        });
      }),
  });
  const endpoint = `http://127.0.0.1:${server.claim.port}/identity`;
  const state = path.join(root, "state");
  const configDir = path.join(state, "codex-runtime");
  await fs.mkdir(configDir, { recursive: true, mode: 0o700 });
  await fs.writeFile(path.join(configDir, "version"), "a".repeat(64), { mode: 0o600 });
  const helper = path.join(configDir, "autodev-token.mjs");
  await fs.writeFile(
    path.join(configDir, "config.toml"),
    `model = "codex-test-model"\nmodel_provider = "autodev"\n[model_providers.autodev]\nname = "AutoDev"\nbase_url = "http://127.0.0.1:${server.claim.port}/v1"\nwire_api = "responses"\nsupports_websockets = false\nrequest_max_retries = 0\nstream_max_retries = 0\n[model_providers.autodev.auth]\ncommand = "node"\nargs = [${JSON.stringify(helper)}]\n`,
    { mode: 0o600 },
  );
  await fs.writeFile(
    helper,
    `
    import { get } from "node:http";
    import { writeFileSync } from "node:fs";
    writeFileSync(${JSON.stringify(path.join(configDir, "auth-attempt.json"))}, JSON.stringify({ providerPairPresent: Boolean(process.env.IDENTITY_ENDPOINT && process.env.IDENTITY_HEADER), platformTrustPresent: Object.entries(${JSON.stringify(platformTrust)}).every(([key,value])=>process.env[key]===value) }));
    if (!process.env.IDENTITY_ENDPOINT || !process.env.IDENTITY_HEADER || process.env.OPENCLAW_GATEWAY_TOKEN) {
      process.stderr.write("provider transport unavailable"); process.exit(1);
    }
    const url = new URL(process.env.IDENTITY_ENDPOINT);
    url.search = new URLSearchParams({ resource: ${JSON.stringify(audience)}, client_id: ${JSON.stringify(identity)} }).toString();
    get(url, { headers: { "X-IDENTITY-HEADER": process.env.IDENTITY_HEADER } }, response => {
      response.setEncoding("utf8"); let body = "";
      response.on("data", chunk => body += chunk);
      response.on("end", () => {
        const value = JSON.parse(body);
        if (value.resource !== ${JSON.stringify(audience)} || Number(value.expires_on) * 1000 <= Date.now() + 360000) process.exit(2);
        process.stdout.write(value.access_token + "\\n");
      });
    }).on("error", () => process.exit(3));
  `,
    { mode: 0o600 },
  );
  vi.stubEnv("OPENCLAW_STATE_DIR", state);
  vi.stubEnv("IDENTITY_ENDPOINT", endpoint);
  vi.stubEnv("IDENTITY_HEADER", header);
  vi.stubEnv("OPENCLAW_GATEWAY_TOKEN", "synthetic-gateway-secret");
  const workspace = new NodeWorkerWorkspaceRuntime({
    root: path.join(root, "node-host"),
    env: { HOME: root, PATH: process.env.PATH, ...platformTrust },
    managedIdentityTransport: captureNodeWorkerManagedIdentityTransport(process.env),
    platformTrust,
  });
  vi.stubEnv("IDENTITY_HEADER", "caller-override");
  const owner = {
    gatewayNamespace: "codex-fixture",
    environmentId: "worker-fixture",
    sessionId: "session-fixture",
    generation: 1,
    sessionKey: "agent:main:fixture",
  };
  const created = await workspace.exec({ ...owner, argv: ["node", "-e", ""] });
  const placement = {
    cwd: created.workspaceDir,
    environmentId: owner.environmentId,
    sessionId: owner.sessionId,
    ownerEpoch: owner.generation,
    sessionKey: "agent:main:fixture",
  };
  const fixture = await loadCodexNodeAppServerTestFixture();
  fixture.setManagedCodexPluginRoot(
    fileURLToPath(new URL("../../extensions/codex/", import.meta.url)),
  );
  const command = fixture.createCodexNodeAppServerCommand();
  const leases: Array<Awaited<ReturnType<typeof workspace.acquireManagedWorkspaceAsync>>> = [];
  const context: OpenClawPluginNodeHostCommandContext = {
    sendNodeEvent: async () => undefined,
    acquireManagedWorkspaceAsync: async (request) => {
      const lease = await workspace.acquireManagedWorkspaceAsync(request);
      expect(JSON.stringify(lease)).not.toContain(header);
      expect(JSON.stringify(lease)).not.toContain("IDENTITY_HEADER");
      vi.spyOn(lease, "release");
      if (lease.repositoryReadiness) vi.spyOn(lease.repositoryReadiness, "wait");
      leases.push(lease);
      return lease;
    },
  };
  const raw: string[] = [];
  const connection = async <T>(
    use: (
      frames: ReturnType<typeof fixture.createNodeFrames>,
      request: (id: number, method: string, params: unknown) => Promise<Record<string, unknown>>,
    ) => Promise<T>,
  ) => {
    const frames = fixture.createNodeFrames(signal);
    const send = frames.io.frames!.send;
    frames.io.frames!.send = async (bytes) => {
      raw.push(Buffer.from(bytes).toString("utf8"));
      await send(bytes);
    };
    const running = withNodeHostPluginInvocation(
      {
        context: {
          ...context,
          prepareExecAuthorization: () => () => frames.io.signal.throwIfAborted(),
        },
        sessionKey: placement.sessionKey,
        signal: frames.controller.signal,
      },
      (bound) =>
        command.handle(
          JSON.stringify({ placement, authorization: "session-full" }),
          frames.io,
          bound,
        ),
    );
    void running.catch(() => {});
    const request = async (id: number, method: string, params: unknown) => {
      await frames.send({ id, method, params });
      return frames.waitForMessage((message) => message.id === id);
    };
    try {
      await Promise.race([frames.ready, running]);
      expect(
        await request(1, "initialize", fixture.buildCodexAppServerInitializeParams()),
      ).toHaveProperty("result.userAgent");
      await frames.send({ method: "initialized", params: {} });
      return await use(frames, request);
    } finally {
      frames.controller.abort(new Error("fixture connection completed"));
      await expect(running).rejects.toThrow();
    }
  };
  const git = promisify(execFile);
  origin = path.join(root, "origin");
  await fs.mkdir(origin);
  await git("git", ["init", "--initial-branch=fixture/admitted", origin]);
  await fs.writeFile(path.join(origin, "admitted.txt"), "exact admitted checkout");
  await git("git", ["-C", origin, "add", "admitted.txt"]);
  await git("git", [
    "-C",
    origin,
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "commit",
    "-m",
    "fixture",
  ]);
  await git("git", ["-C", origin, "update-server-info"]);
  const head = (await git("git", ["-C", origin, "rev-parse", "HEAD"])).stdout.trim();
  const repository = {
    workspaceId: "fixture-repository",
    revision: 1,
    branch: "fixture/admitted",
    baseCommit: head,
  };
  const setRepository = (status: "pending" | "ready" | "failed") =>
    workspace.exec({
      ...owner,
      argv: [NODE_WORKSPACE_REPOSITORY_COMMAND],
      repositoryPreparation: { ...repository, status },
    });
  await setRepository("pending");
  const directLease = await context.acquireManagedWorkspaceAsync!({
    workspaceDir: placement.cwd,
    environmentId: owner.environmentId,
    sessionId: owner.sessionId,
    ownerEpoch: owner.generation,
    sessionKey: owner.sessionKey,
  });
  const directAbort = new AbortController();
  const carrier = await fixture.createCodexNodeWorkspaceEnvironment({
    workspace: directLease,
    signal: directAbort.signal,
    assertExecAuthorized: () => directLease.processEnvironment!.assertCurrent(),
  });
  const socket = new WebSocket(carrier.url);
  await once(socket, "open");
  let sequence = 0;
  const processExited = Promise.withResolvers<unknown>();
  const pending = new Map<
    number,
    ReturnType<typeof Promise.withResolvers<Record<string, unknown>>>
  >();
  socket.on("message", (bytes) => {
    const text = rawDataToString(bytes);
    raw.push(text);
    const response = JSON.parse(text) as Record<string, unknown>;
    if (response.method === "process/exited") processExited.resolve(response.params);
    if (typeof response.id === "number") {
      pending.get(response.id)?.resolve(response);
      pending.delete(response.id);
    }
  });
  const direct = (method: string, params: unknown) => {
    const id = ++sequence;
    const result = Promise.withResolvers<Record<string, unknown>>();
    pending.set(id, result);
    socket.send(JSON.stringify({ id, method, params }));
    return result.promise;
  };
  try {
    expect(await direct("initialize", { clientName: "repository-fixture" })).toHaveProperty(
      "result.sessionId",
    );
    socket.send(JSON.stringify({ method: "initialized" }));
    const admittedFile = path.join(placement.cwd, "admitted.txt");
    const commandFile = path.join(placement.cwd, "command-head.txt");
    const reading = direct("fs/readFile", { path: pathToFileURL(admittedFile).href });
    const starting = direct("process/start", {
      processId: "exact-branch-command",
      argv: [
        process.execPath,
        "-e",
        `const fs=require('node:fs');const cp=require('node:child_process');if(process.env.IDENTITY_HEADER==='caller-override')process.exit(6);if(!Object.entries(${JSON.stringify(platformTrust)}).every(([key,value])=>process.env[key]===value)){console.error('DIRECT_CA_TRUST_MISMATCH');process.exit(7);}fs.writeFileSync('command-head.txt',cp.execFileSync('git',['symbolic-ref','--short','HEAD'])+cp.execFileSync('git',['rev-parse','HEAD']));`,
      ],
      cwd: pathToFileURL(placement.cwd).href,
      env: { IDENTITY_HEADER: "caller-override", NODE_EXTRA_CA_CERTS: "/untrusted-caller.pem" },
      tty: false,
      pipeStdin: false,
      arg0: null,
    });
    let directReads = 0;
    void reading.then(() => {
      directReads++;
    });
    void starting.then(() => {
      directReads++;
    });
    expect(await direct("environment/info", {})).toHaveProperty("result.cwd");
    const threadId = await connection(async (frames, request) => {
      const pendingRead = request(20, "fs/readFile", { path: admittedFile });
      let appRead = false;
      void pendingRead.then(
        () => {
          appRead = true;
        },
        () => {},
      );
      const started = await request(2, "thread/start", {
        cwd: placement.cwd,
        modelProvider: "autodev",
        model: "codex-test-model",
      });
      expect(started).toHaveProperty("result.thread.id");
      const id = (started.result as { thread: { id: string } }).thread.id;
      expect(id).toMatch(/^[a-f0-9-]+$/);
      const turn = async (requestId: number) => {
        const from = frames.outbound.length;
        expect(
          await request(requestId, "turn/start", {
            threadId: id,
            input: [{ type: "text", text: "Reply briefly.", text_elements: [] }],
          }),
        ).toHaveProperty("result");
        expect(
          await frames.waitForMessage(
            (message) =>
              frames.outbound.indexOf(message) >= from &&
              message.method === "turn/completed" &&
              isRecord(message.params) &&
              message.params.threadId === id,
          ),
        ).toMatchObject({ params: { threadId: id, turn: { status: "completed" } } });
      };
      await turn(3);
      expect(modelRequests).toEqual([{ authenticated: true, model: "codex-test-model" }]);
      expect(appRead).toBe(false);
      expect(directReads).toBe(0);
      expect(directLease.repositoryReadiness!.wait).toHaveBeenCalledTimes(2);
      expect(leases[1]?.repositoryReadiness?.wait).toHaveBeenCalled();
      await expect(fs.access(admittedFile)).rejects.toThrow();
      await expect(fs.access(commandFile)).rejects.toThrow();
      expect(
        (
          await workspace.exec({
            ...owner,
            argv: [
              "git",
              "clone",
              "--branch",
              repository.branch,
              `http://127.0.0.1:${server.claim.port}/repo.git`,
              ".",
            ],
          })
        ).code,
      ).toBe(0);
      await setRepository("ready");
      expect(await pendingRead).toMatchObject({
        result: { dataBase64: Buffer.from("exact admitted checkout").toString("base64") },
      });
      expect(await reading).toMatchObject({
        result: { dataBase64: Buffer.from("exact admitted checkout").toString("base64") },
      });
      expect(await starting).toHaveProperty("result");
      expect(await processExited.promise).toMatchObject({
        processId: "exact-branch-command",
        exitCode: 0,
      });
      expect(
        await direct("process/read", {
          processId: "exact-branch-command",
          afterSeq: 0,
          waitMs: 1000,
        }),
      ).toMatchObject({ result: { exited: true, exitCode: 0 } });
      expect(await fs.readFile(commandFile, "utf8")).toBe(`fixture/admitted
${head}
`);
      expect((await git("git", ["-C", placement.cwd, "rev-parse", "HEAD"])).stdout.trim()).toBe(
        head,
      );
      expect(
        (await git("git", ["-C", placement.cwd, "symbolic-ref", "--short", "HEAD"])).stdout.trim(),
      ).toBe(repository.branch);
      await turn(4);
      expect(modelRequests.slice(1)).toEqual([
        { authenticated: true, model: "codex-test-model" },
        { authenticated: true, model: "codex-test-model" },
      ]);
      return id;
    });
    await connection(async (_frames, request) => {
      expect(await request(2, "thread/resume", { threadId })).toMatchObject({
        result: { thread: { id: threadId } },
      });
    });
    await setRepository("failed");
    expect(
      await direct("fs/writeFile", {
        path: pathToFileURL(admittedFile).href,
        dataBase64: Buffer.from("forbidden").toString("base64"),
      }),
    ).toMatchObject({ error: { message: expect.stringContaining("operation did not run") } });
    expect(await fs.readFile(admittedFile, "utf8")).toBe("exact admitted checkout");
    expect(
      JSON.parse(await fs.readFile(path.join(configDir, "auth-attempt.json"), "utf8")),
    ).toEqual({ providerPairPresent: true, platformTrustPresent: true });
    expect(identityRequests.length).toBeGreaterThan(0);
    expect(
      identityRequests.every(
        (observation) => observation.headerMatches && observation.purposeMatches,
      ),
    ).toBe(true);
    expect(raw.join("\n")).toContain("CA_TRUST_PASS");
    expect(raw.join("\n")).not.toContain(header);
    expect(raw.join("\n")).not.toContain(bearer);
    const sessionHomes = await fs.readdir(path.join(configDir, "sessions"));
    expect(sessionHomes).toHaveLength(1);
    for (const directory of sessionHomes) {
      const saved = await fs.readFile(
        path.join(configDir, "sessions", directory, "config.toml"),
        "utf8",
      );
      expect(saved).not.toContain(header);
      expect(saved).not.toContain(bearer);
      expect(saved).not.toContain("IDENTITY_HEADER");
    }
  } finally {
    directAbort.abort();
    socket.terminate();
    await carrier.close();
    directLease.release();
    await command.onDisconnect?.();
    for (const lease of leases) expect(lease.release).toHaveBeenCalledOnce();
    workspace.repositoryReadiness.close();
    await workspace.processes.close();
    fixture.setManagedCodexPluginRoot(undefined);
    server.listener.closeAllConnections();
    await server.releaseListener();
    await server.claim.release();
  }
}, 45_000);
