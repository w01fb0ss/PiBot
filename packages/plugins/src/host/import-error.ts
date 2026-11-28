import { looksLikeCredentialValue, RpcError, RpcErrorCodes } from "@pibot/plugins-contract/full";

export function rejectSymlink(item?: string): never {
  // The brain checks its registered secrets against the complete label. Shortening it here
  // could preserve part of a credential while making the original unrecognizable.
  const label = item && item.length <= 120 && !looksLikeCredentialValue(item) ? item : undefined;
  throw new RpcError(
    RpcErrorCodes.pluginImportInvalid,
    label ? `connector_import_symlink:${label}` : "connector_import_symlink",
  );
}
