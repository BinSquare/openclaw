import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { afterEach, describe, expect, it, vi } from "vitest";

const phaseLog = vi.hoisted(() => vi.fn());
vi.mock("openclaw/plugin-sdk/diagnostic-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/diagnostic-runtime")>()),
  createSubsystemLogger: () => ({ info: phaseLog }),
}));

function scopedRequests(
  api: typeof import("./github-api.js"),
  fetchImpl: typeof fetch,
  baseUrl: string,
) {
  return (url: string, token?: string, graphql?: Parameters<typeof api.fetchGitHubApi>[7]) =>
    api.fetchGitHubApi(
      url,
      fetchImpl,
      token,
      undefined,
      undefined,
      undefined,
      undefined,
      graphql,
      baseUrl,
    );
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function useRequestClock() {
  vi.useFakeTimers();
  phaseLog.mockReset();
  // Native AbortSignal timers do not use Vitest's deterministic clock.
  vi.spyOn(AbortSignal, "timeout").mockImplementation((ms) => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(new DOMException("Timed out", "TimeoutError")), ms);
    return controller.signal;
  });
}

// Only external bytes, readiness and scope-observation live here. The request owner
// performs admission, starts its deadline and releases the scopes itself.
function scriptedTransport() {
  const caller = new AbortController();
  const scopes: ReturnType<typeof vi.fn>[] = [];
  const hops = Array.from({ length: 2 }, () => ({
    sent: createDeferred<void>(),
    headers: createDeferred<Response>(),
    reading: createDeferred<void>(),
    body: createDeferred<Uint8Array>(),
  }));
  const fetchImpl = vi.fn<typeof fetch>(async (_url, init) => {
    const hop = hops[fetchImpl.mock.calls.length - 1];
    if (!hop || !init?.signal) throw new Error("Unexpected or uncancellable transport");
    const signal = init.signal;
    signal.throwIfAborted();
    hop.sent.resolve();
    return await new Promise<Response>((resolve, reject) => {
      const abort = () => reject(signal.reason);
      signal.addEventListener("abort", abort, { once: true });
      void hop.headers.promise
        .then(resolve, reject)
        .finally(() => signal.removeEventListener("abort", abort));
    });
  });
  const upstream = vi.fn(() => {
    const release = vi.fn();
    scopes.push(release);
    return { signal: caller.signal, release };
  });
  const stream = (index: number) => {
    const hop = hops[index];
    const signal = fetchImpl.mock.calls[index]?.[1]?.signal;
    if (!signal) throw new Error("Body requires dispatched transport");
    return new Response(
      new ReadableStream<Uint8Array>(
        {
          start(controller) {
            signal.addEventListener("abort", () => controller.error(signal.reason), { once: true });
          },
          async pull(controller) {
            hop.reading.resolve();
            const bytes = await hop.body.promise;
            controller.enqueue(bytes);
            controller.close();
          },
        },
        { highWaterMark: 0 },
      ),
    );
  };
  return { caller, scopes, hops, fetchImpl, upstream, stream };
}

async function reached(entered: Promise<void>, settled: Promise<unknown>) {
  expect(await Promise.race([entered.then(() => "entered"), settled.then(() => "settled")])).toBe(
    "entered",
  );
}

function expectPhase(name: string, status: "success" | "error") {
  const records = phaseLog.mock.calls.map(([, fields]) => fields);
  const entry = records.find((record) => record.name === name && record.status === "entry");
  expect(entry).toMatchObject({ traceId: expect.stringMatching(/^[a-f0-9]{32}$/u) });
  expect(records).toContainEqual(
    expect.objectContaining({
      traceId: entry.traceId,
      requestSpanId: entry.requestSpanId,
      spanId: entry.spanId,
      name,
      status,
      durationMs: expect.any(Number),
    }),
  );
  return entry;
}

describe("GitHub API base URL", () => {
  it("defaults to public GitHub", async () => {
    const { GITHUB_API_BASE_URL, GITHUB_API_ORIGIN } = await import("../api.js");
    expect(GITHUB_API_BASE_URL).toBe("https://api.github.com");
    expect(GITHUB_API_ORIGIN).toBe("https://api.github.com");
  });

  it("routes Enterprise Server REST and GraphQL requests to their API paths", async () => {
    const api = await import("./github-api.js");
    const { baseUrl, graphqlUrl } = api.resolveGitHubApiUrls("https://ghe.example.test/api/v3/");
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response("{}"));
    const request = scopedRequests(api, fetchImpl, baseUrl);
    await request(`${baseUrl}/repos/acme/private-repo`, "synthetic-token");
    await request(graphqlUrl, "synthetic-token", {
      query: "query { viewer { login } }",
      variables: {},
    });
    expect(fetchImpl.mock.calls.map(([url]) => url)).toEqual([
      "https://ghe.example.test/api/v3/repos/acme/private-repo",
      "https://ghe.example.test/api/graphql",
    ]);
    await expect(request("https://ghe.example.test/settings", "synthetic-token")).rejects.toThrow(
      "Invalid GitHub API URL",
    );
  });

  it("retains GraphQL quota on its admitted API while public requests are interleaved", async () => {
    const api = await import("./github-api.js");
    vi.spyOn(Date, "now").mockReturnValue(1_800_000_000_000);
    const enterpriseBase = "https://ghe.example.test/api/v3";
    const token = "synthetic-quota-token";
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ errors: [{ type: "RATE_LIMITED" }] }), { status: 403 }),
      )
      .mockImplementation(async () => new Response("{}"));
    const enterprise = scopedRequests(api, fetchImpl, enterpriseBase);
    const response = await enterprise(api.resolveGitHubApiUrls(enterpriseBase).graphqlUrl, token, {
      query: "query { viewer { login } }",
      variables: {},
    });
    await expect(api.readGitHubGraphQLResponse(response, fetchImpl, token)).rejects.toMatchObject({
      statusCode: 429,
      retryAfterMs: 60_000,
    });
    await expect(
      api.fetchGitHubApi("https://api.github.com/repos/acme/repo", fetchImpl, token),
    ).resolves.toBeInstanceOf(Response);
    await expect(enterprise(`${enterpriseBase}/repos/acme/repo`, token)).rejects.toMatchObject({
      statusCode: 429,
      retryAfterMs: 60_000,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    await expect(
      enterprise(`${enterpriseBase}/repos/acme/repo`, "synthetic-rotated-token"),
    ).resolves.toBeInstanceOf(Response);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it("keeps a configured HTTPS API port on Enterprise requests", async () => {
    const api = await import("./github-api.js");
    const { baseUrl } = api.resolveGitHubApiUrls("https://ghe.example.test:8443/api/v3");
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response("{}"));
    const request = scopedRequests(api, fetchImpl, baseUrl);
    await request(`${baseUrl}/repos/acme/private-repo`);
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://ghe.example.test:8443/api/v3/repos/acme/private-repo",
      expect.any(Object),
    );
    await expect(
      request("https://ghe.example.test/api/v3/repos/acme/private-repo"),
    ).rejects.toThrow("Invalid GitHub API URL");
  });

  it.each([
    "http://api.ghe.example.test",
    "https://user@example.com",
    "https://api.ghe.example.test/other",
  ])("rejects unsafe configured API origin %s", async (origin) => {
    const api = await import("./github-api.js");
    expect(() => api.resolveGitHubApiUrls(origin)).toThrow(
      "gateway.github.apiBaseUrl must be an HTTPS GitHub API base URL",
    );
  });
});

describe("GitHub request lifetime", () => {
  it.each([
    "admission error",
    "admission cancel",
    "credential",
    "selection",
    "headers error",
    "headers cancel",
    "body cancel",
  ] as const)("settles %s at its reached boundary without exposing private data", async (fault) => {
    const api = await import("./github-api.js");
    useRequestClock();
    const wire = scriptedTransport();
    const entered = createDeferred<void>();
    const admission = createDeferred<void>();
    const privateError = new Error("synthetic-private-token-and-request-body");
    let current = true;
    if (fault === "admission cancel")
      phaseLog.mockImplementationOnce(() => {
        throw new Error("sink unavailable");
      });
    const pending = api
      .fetchGitHubApi(
        "https://api.github.com/repos/acme/private-repo?private-query=secret",
        wire.fetchImpl,
        "synthetic-private-token",
        undefined,
        {
          revalidate: async () => {
            entered.resolve();
            await admission.promise;
            if (fault === "credential" && !current) throw privateError;
          },
          assertSelected: () => {
            if (fault === "selection" && !current) throw privateError;
          },
        },
        undefined,
        fault === "admission cancel" ? wire.caller.signal : wire.upstream,
      )
      .then((response) => api.readBoundedResponse(response, 1024));
    const settled = vi.fn();
    const outcome = pending.then(
      (value) => settled({ value }),
      (error) => settled({ error }),
    );
    try {
      await reached(entered.promise, outcome);
      expect(wire.fetchImpl).not.toHaveBeenCalled();
      expect(wire.upstream).not.toHaveBeenCalled();
      // The sink-failure row tests cancellation, not successful observation delivery.
      if (fault !== "admission cancel")
        expect(phaseLog).toHaveBeenCalledWith(
          "github api phase",
          expect.objectContaining({
            traceId: expect.stringMatching(/^[a-f0-9]{32}$/u),
            name: "credentialRevalidation",
            status: "entry",
          }),
        );
      if (fault === "admission error") admission.reject(privateError);
      else {
        if (fault === "credential" || fault === "selection") current = false;
        if (fault === "admission cancel") wire.caller.abort();
        admission.resolve();
        if (fault.startsWith("headers") || fault === "body cancel") {
          await reached(wire.hops[0].sent.promise, outcome);
          expect(phaseLog).toHaveBeenCalledWith(
            "github api phase",
            expect.objectContaining({
              traceId: expect.stringMatching(/^[a-f0-9]{32}$/u),
              name: "responseHeaders",
              status: "entry",
            }),
          );
          expectPhase("credentialRevalidation", "success");
          if (fault === "headers error") wire.hops[0].headers.reject(privateError);
          else {
            if (fault === "body cancel") {
              wire.hops[0].headers.resolve(wire.stream(0));
              await reached(wire.hops[0].reading.promise, outcome);
            }
            await vi.advanceTimersByTimeAsync(1_000);
            wire.caller.abort(new DOMException("synthetic-private-cancel-reason", "AbortError"));
          }
        }
      }
      if (["admission error", "admission cancel", "credential", "selection"].includes(fault)) {
        expect(
          await Promise.race([
            outcome.then(() => "settled"),
            wire.hops[0].sent.promise.then(() => "sent"),
          ]),
        ).toBe("settled");
      }
      await outcome;
      const sent = fault.startsWith("headers") || fault === "body cancel";
      expect(wire.fetchImpl).toHaveBeenCalledTimes(sent ? 1 : 0);
      expect(wire.scopes).toHaveLength(sent ? 1 : 0);
      for (const release of wire.scopes) expect(release).toHaveBeenCalledOnce();
      const error = settled.mock.calls[0]?.[0].error;
      expect(error).toBeInstanceOf(Error);
      if (fault === "admission cancel") expect(error).toMatchObject({ name: "AbortError" });
      if (["admission error", "credential", "selection"].includes(fault))
        expect(error).toBe(privateError);
      if (fault === "headers error") {
        expect(error).toMatchObject({ message: "Could not reach GitHub" });
        const entry = expectPhase("responseHeaders", "error");
        expect(phaseLog).toHaveBeenCalledWith(
          "github api failed",
          expect.objectContaining({
            traceId: entry.traceId,
            requestSpanId: entry.requestSpanId,
            diagnosticCode: "transport_error",
          }),
        );
      }
      if (fault === "admission error") expectPhase("credentialRevalidation", "error");
      if (fault === "headers cancel")
        expect(phaseLog).toHaveBeenCalledWith(
          "github api failed",
          expect.objectContaining({ diagnosticCode: "caller_aborted" }),
        );
      expect(JSON.stringify(phaseLog.mock.calls)).not.toMatch(
        /private-repo|private-query|secret|token|body|cancel-reason/,
      );
    } finally {
      admission.resolve();
      wire.caller.abort();
      await outcome;
    }
  });

  it.each(["rest", "graphql", "lazy upstream"] as const)(
    "gives %s a full eight-second dispatch budget after slow admission",
    async (kind) => {
      const api = await import("./github-api.js");
      useRequestClock();
      const wire = scriptedTransport();
      const entered = createDeferred<void>();
      const admission = createDeferred<void>();
      const settled = vi.fn();
      const outcome = api
        .fetchGitHubApi(
          kind === "graphql"
            ? api.GITHUB_GRAPHQL_URL
            : api.GITHUB_API_BASE_URL + "/repos/acme/repo",
          wire.fetchImpl,
          "synthetic-deadline-token",
          undefined,
          {
            revalidate: async () => {
              entered.resolve();
              await admission.promise;
            },
            assertSelected: () => {},
          },
          undefined,
          kind === "lazy upstream" ? wire.upstream : wire.caller.signal,
          kind === "graphql" ? { query: "query { viewer { login } }", variables: {} } : undefined,
        )
        .then(
          (value) => settled({ value }),
          (error) => settled({ error }),
        );
      try {
        await reached(entered.promise, outcome);
        await vi.advanceTimersByTimeAsync(9_000);
        expect(wire.fetchImpl).not.toHaveBeenCalled();
        expect(wire.upstream).not.toHaveBeenCalled();
        admission.resolve();
        await reached(wire.hops[0].sent.promise, outcome);
        await vi.advanceTimersByTimeAsync(7_999);
        expect(settled).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(1);
        await outcome;
        expect(settled).toHaveBeenCalledExactlyOnceWith({
          error: expect.objectContaining({ statusCode: 502, retryable: true }),
        });
        // Post-send timeout is a failure, not proof of no effects or permission to retry.
        expect(wire.fetchImpl).toHaveBeenCalledOnce();
        expect(wire.scopes).toHaveLength(kind === "lazy upstream" ? 1 : 0);
        for (const release of wire.scopes) expect(release).toHaveBeenCalledOnce();
        expect(phaseLog).toHaveBeenCalledWith(
          "github api failed",
          expect.objectContaining({ diagnosticCode: "deadline_expired" }),
        );
      } finally {
        admission.resolve();
        wire.caller.abort();
        await outcome;
      }
    },
  );

  it.each(["headers", "body", "redirect admission", "success"] as const)(
    "retains the first deadline and response ownership across redirect to %s",
    async (stage) => {
      const api = await import("./github-api.js");
      useRequestClock();
      const wire = scriptedTransport();
      const redirectEntered = createDeferred<void>();
      const redirectAdmission = createDeferred<void>();
      let admissions = 0;
      const settled = vi.fn();
      let response: Response | undefined;
      const outcome = api
        .fetchGitHubApi(
          api.GITHUB_API_BASE_URL + "/repos/acme/repo",
          wire.fetchImpl,
          "synthetic-redirect-token",
          undefined,
          {
            revalidate: async () => {
              if (++admissions === 2) {
                redirectEntered.resolve();
                await redirectAdmission.promise;
              }
            },
            assertSelected: () => {},
          },
          undefined,
          wire.upstream,
        )
        .then((value) => {
          response = value;
          return api.readBoundedResponse(value, 1024);
        })
        .then(
          (value) => settled({ value }),
          (error) => settled({ error }),
        );
      try {
        await reached(wire.hops[0].sent.promise, outcome);
        await vi.advanceTimersByTimeAsync(5_000);
        wire.hops[0].headers.resolve(
          new Response(null, {
            status: 302,
            headers: { location: api.GITHUB_API_BASE_URL + "/repos/acme/moved" },
          }),
        );
        await reached(redirectEntered.promise, outcome);
        expect(wire.scopes[0]).toHaveBeenCalledOnce();
        if (stage !== "redirect admission") {
          redirectAdmission.resolve();
          await reached(wire.hops[1].sent.promise, outcome);
          if (stage !== "headers") {
            wire.hops[1].headers.resolve(wire.stream(1));
            await reached(wire.hops[1].reading.promise, outcome);
          }
        }
        await vi.advanceTimersByTimeAsync(2_999);
        expect(settled).not.toHaveBeenCalled();
        if (stage === "success") wire.hops[1].body.resolve(new TextEncoder().encode("{}"));
        else await vi.advanceTimersByTimeAsync(1);
        redirectAdmission.resolve();
        await vi.advanceTimersByTimeAsync(0);
        if (stage !== "success") expect(settled).toHaveBeenCalledOnce();
        await outcome;
        expect(settled).toHaveBeenCalledExactlyOnceWith(
          stage === "success" ? { value: Buffer.from("{}") } : { error: expect.any(Error) },
        );
        expect(admissions).toBe(2);
        expect(wire.fetchImpl).toHaveBeenCalledTimes(stage === "redirect admission" ? 1 : 2);
        if (stage !== "success" && stage !== "redirect admission")
          expect(wire.fetchImpl.mock.calls[1]?.[1]?.signal?.aborted).toBe(true);
        if (response) await api.discardResponse(response);
        for (const release of wire.scopes) expect(release).toHaveBeenCalledOnce();
      } finally {
        redirectAdmission.resolve();
        wire.caller.abort();
        await outcome;
      }
    },
  );
});
