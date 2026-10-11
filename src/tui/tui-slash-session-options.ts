import { modelKey } from "../shared/model-key.js";
import { resolveModelRuntimeEntry, runtimeOffersUltrafast } from "../shared/model-runtime-entry.js";
import type { TuiBackend, TuiModelChoice } from "./tui-backend.js";
import { captureTuiSessionSelection } from "./tui-session-events.js";
import type { TuiStateAccess } from "./tui-types.js";

/**
 * Session-dependent slash-command options. Ultrafast comes only from the selected model's
 * catalog tiers: a missing catalog, model, or tier keeps it out of completions.
 */
export function createTuiSlashSessionOptions(
  client: Pick<TuiBackend, "listModels" | "getKnownModels">,
  state: Pick<TuiStateAccess, "currentAgentId" | "currentSessionKey" | "sessionInfo">,
  onCatalogLoaded: () => void,
) {
  let loaded: { key: string; models: TuiModelChoice[] } | undefined;
  let pendingKey: string | undefined;
  const offersUltrafast = () => {
    const { modelProvider, model, agentRuntime } = state.sessionInfo;
    if (!modelProvider || !model) {
      return false;
    }
    const scope = captureTuiSessionSelection(state);
    const key = JSON.stringify([scope.agentId, scope.sessionKey, modelProvider, model]);
    // Backends without a live catalog cache load once per selected model.
    const models = client.getKnownModels?.(scope) ?? (loaded?.key === key ? loaded.models : null);
    if (!models) {
      if (pendingKey !== key) {
        pendingKey = key;
        void client.listModels(scope).then(
          (next) => {
            if (pendingKey === key) {
              pendingKey = undefined;
              loaded = { key, models: next };
              onCatalogLoaded();
            }
          },
          () => {
            if (pendingKey === key) {
              pendingKey = undefined;
            }
          },
        );
      }
      return false;
    }
    const selected = modelKey(modelProvider, model);
    const entry = models.find(
      (candidate) => modelKey(candidate.provider, candidate.id) === selected,
    );
    return runtimeOffersUltrafast(resolveModelRuntimeEntry(entry, agentRuntime?.id));
  };
  return () => ({
    provider: state.sessionInfo.modelProvider,
    model: state.sessionInfo.model,
    agentRuntime: state.sessionInfo.agentRuntime?.id,
    thinkingLevels: state.sessionInfo.thinkingLevels,
    ultrafast: offersUltrafast(),
  });
}
