import type { ConnectorConnectionFactory } from "@pibot/protocol-base";
import { argumentValidator } from "./arguments.ts";

/** One factory owns its validators/connections; the SDK is unused by first-screen reads. */
export function createConnectorConnectionFactory(
  networkFetch?: typeof fetch,
): ConnectorConnectionFactory {
  let pending: Promise<ConnectorConnectionFactory> | undefined;
  const load = () => {
    pending ??= import("./connection.ts").then((module) =>
      module.createConnectorConnectionFactory(networkFetch),
    );
    void pending.catch(() => {
      pending = undefined;
    });
    return pending;
  };
  return {
    async connect(options) {
      options.signal.throwIfAborted();
      const factory = await load();
      options.signal.throwIfAborted();
      return factory.connect(options);
    },
    async authorizeOAuth(input) {
      input.signal.throwIfAborted();
      const factory = await load();
      input.signal.throwIfAborted();
      return factory.authorizeOAuth?.(input);
    },
    validateArguments: argumentValidator(),
  };
}
