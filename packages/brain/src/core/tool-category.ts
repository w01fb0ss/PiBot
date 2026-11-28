import { type CapabilityToolRegistry, declaredPermission } from "@pibot/protocol-base";

const permissionCategories = [
  "run_command",
  "connector",
  "read_file",
  "read_messages",
  "list_dir",
  "write_file",
  "web",
  "computer",
] as const;
type PermissionCategory = (typeof permissionCategories)[number];

// A category this module cannot judge (send_out, planning, phone_data …) stays undefined, as before:
// the tools that declare one keep their own approval path.
function asPermissionCategory(value: string | undefined): PermissionCategory | undefined {
  return (permissionCategories as readonly string[]).includes(value ?? "")
    ? (value as PermissionCategory)
    : undefined;
}

/**
 * The category now comes from the tool's registration — the kernel catalog declares its
 * own attributes and a capability declares its policy request — instead of a hand-written table
 * here. `office_template_fill` deliberately has no category (it never had one); it only has to
 * report that it writes a file.
 */
export function toolPermissionCategory(
  tool: string,
  registry: CapabilityToolRegistry,
): PermissionCategory | undefined {
  // App capability tools declare "connector" in their spec. Without this, "Never" did not hide
  // them and their approval card had no valid category. Capability-specific
  // categories (phone_data, routine_proposal) stay their own.
  const spec = registry.specs[tool];
  return asPermissionCategory(
    declaredPermission(tool) ?? spec?.attributes?.permission ?? spec?.policy.category,
  );
}
