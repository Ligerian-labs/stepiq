import type {
  BuildPayloadArgs,
  ConnectorProviderAdapter,
  ProviderCallContext,
  ProviderCapability,
} from "../../contracts.js";
import { makeActionResult } from "../shared/action-result.js";

const ACTIONS = ["put_object", "copy_object"] as const;

const capabilities: ProviderCapability[] = ACTIONS.map((id) => ({
  id,
  direction: "action",
  title: id,
  description: `S3 action ${id}`,
  requires_target: false,
  required_auth_fields: ["access_token"],
}));

function isSupportedAction(capabilityId: string): capabilityId is (typeof ACTIONS)[number] {
  return (ACTIONS as readonly string[]).includes(capabilityId);
}

export const s3Adapter: ConnectorProviderAdapter = {
  provider: "s3",
  getCapabilities() {
    return capabilities;
  },
  buildPayload(args: BuildPayloadArgs) {
    if (!isSupportedAction(args.capability_id)) {
      throw new Error(`Unsupported capability \"${args.capability_id}\" for provider \"s3\"`);
    }
    return { ...args.input };
  },
  async callTool(
    capability_id: string,
    payload: Record<string, unknown>,
    _context: ProviderCallContext,
  ) {
    if (!isSupportedAction(capability_id)) {
      throw new Error(`Unsupported capability \"${capability_id}\" for provider \"s3\"`);
    }
    return {
      kind: "action",
      result: makeActionResult("s3", capability_id, {
        bucket: typeof payload.bucket === "string" ? payload.bucket : null,
        key: typeof payload.key === "string" ? payload.key : null,
      }),
    };
  },
};
