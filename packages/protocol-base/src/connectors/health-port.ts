/**
 * What the connections capability tells the default Pi's health check about connections that do
 * not come up, and the restart it offers (the same one as 测试连接 / "Test connection"). Looked up
 * through `CapabilityContext.ports`; a brain without connections has no such port.
 */
export const CONNECTION_HEALTH_PORT = "connections.health";

export interface FailedConnection {
  id: string;
  name: string;
  revision: number;
  /** The connector's fixed status detail code (e.g. a classified start reason), if any. */
  detail: string | null;
  /** When the connection last changed state. */
  since: string;
}

export interface ConnectionHealthPort {
  /** Enabled connections in the failed state, oldest first, at most `limit`. */
  failed(limit: number): FailedConnection[];
  /** The same connection now, or undefined when it is no longer failed. */
  failedOne(id: string): FailedConnection | undefined;
  /** The restart of "Test connection"; refused when the revision moved on. */
  restart(
    id: string,
    expectedRevision: number,
    signal: AbortSignal,
  ): Promise<{ operationId: string }>;
}
