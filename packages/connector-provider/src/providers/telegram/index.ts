import type {
  BuildPayloadArgs,
  ConnectorProviderAdapter,
  ProviderCallContext,
  ProviderCapability,
} from "../../contracts.js";
import { makeActionResult } from "../shared/action-result.js";

const ACTIONS = ["send_message", "send_document"] as const;

const capabilities: ProviderCapability[] = ACTIONS.map((id) => ({
  id,
  direction: "action",
  title: id,
  description: `Telegram action ${id}`,
  requires_target: true,
  required_auth_fields: ["access_token"],
}));

function isSupportedAction(capabilityId: string): capabilityId is (typeof ACTIONS)[number] {
  return (ACTIONS as readonly string[]).includes(capabilityId);
}

export const telegramAdapter: ConnectorProviderAdapter = {
  provider: "telegram",
  getCapabilities() {
    return capabilities;
  },
  buildPayload(args: BuildPayloadArgs) {
    if (!isSupportedAction(args.capability_id)) {
      throw new Error(`Unsupported capability \"${args.capability_id}\" for provider \"telegram\"`);
    }
    return { ...args.input };
  },
  async callTool(
    capability_id: string,
    payload: Record<string, unknown>,
    context: ProviderCallContext,
  ) {
    if (!isSupportedAction(capability_id)) {
      throw new Error(`Unsupported capability \"${capability_id}\" for provider \"telegram\"`);
    }
    return {
      kind: "action",
      result: makeActionResult("telegram", capability_id, {
        target: context.target,
        text: typeof payload.text === "string" ? payload.text : null,
        file_url: typeof payload.file_url === "string" ? payload.file_url : null,
      }),
    };
  },
};
