const PREFIX = "--pibot-island-open=";

export const islandOpenArgument = (id: string) => `${PREFIX}${id}`;

export function readIslandOpenArgument(argv: readonly string[]) {
  for (const argument of argv) {
    if (!argument.startsWith(PREFIX)) continue;
    const id = argument.slice(PREFIX.length);
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(id)) return id;
  }
}
