/* @vitest-environment jsdom */
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { gatewayPresentationScope } from "../../app/gateway-presentation-scope.ts";
import {
  createGatewayEvent,
  createGatewayStoreTestStore,
  GATEWAY_STORE_TEST_HELLO,
} from "../../app/gateway-store.test-support.ts";
import { i18n } from "../../i18n/index.ts";
import { setAvatarGatewayOrigin } from "../../lib/identity-avatar-context.ts";
import { waitForFast } from "../../test-helpers/wait-for.ts";
import {
  createConnectedContext,
  modelAccountProfile,
  mountProfilePage,
} from "./profile-page.test-support.ts";

beforeEach(async () => {
  await i18n.setLocale("en");
});
afterEach(() => {
  document.body.replaceChildren();
  setAvatarGatewayOrigin(null);
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it.each([undefined, false, true])(
  "publishes verified identity and explicit consent through the real store (initial eligible: %s)",
  async (initialEligible) => {
    const { gateway, current, clients } = createGatewayStoreTestStore();
    const profile = {
      ...modelAccountProfile,
      id: "factory-profile",
      displayName: "Galin-Iliev",
      emails: [],
      githubIdentity: null,
    };
    const identity = {
      host: "microsoft.ghe.com",
      accountId: 1358766,
      login: "Galin-Iliev",
      profileUrl: "https://microsoft.ghe.com/Galin-Iliev",
    };
    const principal = "github:microsoft.ghe.com:1358766";
    let eligible = initialEligible;
    const result = () => ({
      profile,
      authenticatedGitHubIdentity: {
        ...identity,
        ...(eligible === undefined ? {} : { gitCoauthorEligible: eligible }),
      },
    });
    const request = vi.fn(async (method: string, params: unknown) => {
      if (method === "users.self") return result();
      if (method === "users.prefs.get") return { status: "ok", entries: {} };
      if (method === "users.prefs.set")
        return { status: "ok", entries: (params as { entries: unknown }).entries };
      if (method === "users.listModelAccounts")
        return { profileId: profile.id, accounts: [], links: [] };
      throw new Error("unexpected method: " + method);
    });
    const hello = (client: ReturnType<typeof current>, id = profile.id, name = principal) =>
      client.opts.onHello?.({
        ...GATEWAY_STORE_TEST_HELLO,
        auth: { role: "operator", scopes: ["operator.read", "operator.write"] },
        snapshot: {
          presence: [
            {
              instanceId: client.instanceId,
              user: { id, name, email: name, avatarUrl: "/api/users/" + id + "/avatar?v=1" },
            },
          ],
        },
      });
    gateway.start();
    current().request.mockImplementation(request);
    hello(current());
    // Reuse only unrelated app capabilities; ProfilePage receives the real store.
    const page = mountProfilePage({ ...createConnectedContext(vi.fn()).context, gateway });
    const toggle = () => page.querySelector<HTMLElement & { checked: boolean }>("wa-switch")!;
    try {
      await waitForFast(() => {
        expect(page.querySelector<HTMLInputElement>(".identity-name-control input")?.value).toBe(
          profile.displayName,
        );
        expect(page.querySelector<HTMLButtonElement>(".profile-refresh")?.disabled).toBe(false);
      });
      expect(request).toHaveBeenCalledWith("users.self", {});
      expect(gatewayPresentationScope(gateway).displayUser?.name).toBe(profile.displayName);
      expect(page.querySelector(".profile-hero__name")?.textContent).toBe(profile.displayName);
      expect(page.querySelector<HTMLAnchorElement>(".settings-account")?.href).toBe(
        identity.profileUrl,
      );
      expect(page.querySelector(".settings-account")?.textContent).toContain("@Galin-Iliev");
      expect(page.textContent).toContain("Verified from your GitHub-backed sign-in");
      expect(page.textContent).not.toContain(principal);
      expect(page.textContent).not.toContain("Linked emails");
      let presenceSeq = 0;
      const publishPresence = (avatarUrl?: string) =>
        current().opts.onEvent?.(
          createGatewayEvent(
            "presence",
            {
              presence: [
                {
                  instanceId: current().instanceId,
                  user: { id: profile.id, name: principal, email: principal, avatarUrl },
                },
              ],
            },
            ++presenceSeq,
          ),
        );
      publishPresence("/api/users/factory-profile/avatar?v=2");
      expect(gatewayPresentationScope(gateway).displayUser).toMatchObject({
        name: profile.displayName,
        avatarUrl: "/api/users/factory-profile/avatar?v=2",
      });
      expect(gateway.snapshot.selfUser?.email).toBeUndefined();
      if (!initialEligible) {
        expect(toggle().hasAttribute("disabled")).toBe(true);
        expect(page.textContent).toContain(
          "Git co-author credit is unavailable for this GitHub Enterprise account.",
        );
        expect(page.textContent).not.toContain("Refresh to retry");
        expect(request.mock.calls.filter(([method]) => method === "users.prefs.get")).toHaveLength(
          0,
        );
        eligible = true;
        await gateway.loadSelfProfile();
      }
      await waitForFast(() => expect(toggle().hasAttribute("disabled")).toBe(false));
      expect(toggle().checked).toBe(false);
      expect(request.mock.calls.filter(([method]) => method === "users.prefs.get")).toEqual([
        ["users.prefs.get", { keys: ["git.coauthor.enabled"] }],
      ]);
      expect(request.mock.calls.filter(([method]) => method === "users.prefs.set")).toHaveLength(0);
      toggle().checked = true;
      toggle().dispatchEvent(new Event("change", { bubbles: true }));
      await waitForFast(() =>
        expect(request.mock.calls.filter(([method]) => method === "users.prefs.set")).toEqual([
          ["users.prefs.set", { entries: { "git.coauthor.enabled": true } }],
        ]),
      );
      gateway.updateSelfUser?.({ name: "Preferred name" });
      publishPresence();
      expect(gatewayPresentationScope(gateway).displayUser?.name).toBe("Preferred name");
      await waitForFast(() =>
        expect(page.querySelector(".profile-hero__name")?.textContent).toBe("Preferred name"),
      );
      expect(gateway.snapshot.selfUser?.avatarUrl).toBe("/api/users/factory-profile/avatar?v=2");

      const oldResult = createDeferred<ReturnType<typeof result>>();
      current().request.mockImplementation((method, params) =>
        method === "users.self" ? oldResult.promise : request(method, params),
      );
      const oldRead = gateway.loadSelfProfile();
      gateway.connect({ gatewayUrl: "wss://replacement.example.test" });
      const freshResult = createDeferred<ReturnType<typeof result>>();
      current().request.mockImplementation((method, params) =>
        method === "users.self" ? freshResult.promise : request(method, params),
      );
      const freshPrincipal = "github:microsoft.ghe.com:246810";
      hello(current(), "new-profile", freshPrincipal);
      const freshRead = gateway.loadSelfProfile();
      oldResult.resolve({ ...result(), profile: { ...profile, displayName: "Stale person" } });
      expect(await oldRead).toBeNull();
      expect(gateway.snapshot.selfUser?.name).toBe(freshPrincipal);
      await page.updateComplete;
      expect(page.textContent).not.toContain("Stale person");
      freshResult.resolve({
        profile: { ...profile, id: "new-profile", displayName: "New name" },
        authenticatedGitHubIdentity: {
          ...identity,
          accountId: 246810,
          login: "New",
          gitCoauthorEligible: false,
        },
      });
      await freshRead;
      await waitForFast(() =>
        expect(page.querySelector(".profile-hero__name")?.textContent).toBe("New name"),
      );
      await waitForFast(() =>
        expect(page.querySelector<HTMLInputElement>(".identity-name-control input")?.value).toBe(
          "New name",
        ),
      );
    } finally {
      page.remove();
      gateway.stop();
      expect(clients.every((client) => client.stopped === 1)).toBe(true);
    }
  },
);
