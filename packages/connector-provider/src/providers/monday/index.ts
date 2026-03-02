import type {
  BuildPayloadArgs,
  ConnectorProviderAdapter,
  ProviderCallContext,
  ProviderCapability,
} from "../../contracts.js";
import { makeActionResult } from "../shared/action-result.js";

const ACTIONS = ["create_item", "add_update"] as const;

const capabilities: ProviderCapability[] = ACTIONS.map((id) => ({
  id,
  direction: "action",
  title: id,
  description: `Monday action ${id}`,
  requires_target: false,
  required_auth_fields: ["access_token"],
}));

function isSupportedAction(capabilityId: string): capabilityId is (typeof ACTIONS)[number] {
  return (ACTIONS as readonly string[]).includes(capabilityId);
}

export const mondayAdapter: ConnectorProviderAdapter = {
  provider: "monday",
  getCapabilities() {
    return capabilities;
  },
  buildPayload(args: BuildPayloadArgs) {
    if (!isSupportedAction(args.capability_id)) {
      throw new Error(`Unsupported capability \"${args.capability_id}\" for provider \"monday\"`);
    }
    return { ...args.input };
  },
  async callTool(
    capability_id: string,
    payload: Record<string, unknown>,
    context: ProviderCallContext,
  ) {
    if (!isSupportedAction(capability_id)) {
      throw new Error(`Unsupported capability \"${capability_id}\" for provider \"monday\"`);
    }
    return {
      kind: "action",
      result: makeActionResult("monday", capability_id, {
        target: context.target,
        title: typeof payload.title === "string" ? payload.title : null,
        status: typeof payload.status === "string" ? payload.status : null,
      }),
    };
  },
};
