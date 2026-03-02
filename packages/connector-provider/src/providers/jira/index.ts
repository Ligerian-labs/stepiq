import type {
  BuildPayloadArgs,
  ConnectorProviderAdapter,
  ProviderCallContext,
  ProviderCapability,
} from "../../contracts.js";
import { makeActionResult } from "../shared/action-result.js";

const ACTIONS = ["create_issue", "comment_issue"] as const;

const capabilities: ProviderCapability[] = ACTIONS.map((id) => ({
  id,
  direction: "action",
  title: id,
  description: `Jira action ${id}`,
  requires_target: false,
  required_auth_fields: ["access_token"],
}));

function isSupportedAction(capabilityId: string): capabilityId is (typeof ACTIONS)[number] {
  return (ACTIONS as readonly string[]).includes(capabilityId);
}

export const jiraAdapter: ConnectorProviderAdapter = {
  provider: "jira",
  getCapabilities() {
    return capabilities;
  },
  buildPayload(args: BuildPayloadArgs) {
    if (!isSupportedAction(args.capability_id)) {
      throw new Error(`Unsupported capability \"${args.capability_id}\" for provider \"jira\"`);
    }
    return { ...args.input };
  },
  async callTool(
    capability_id: string,
    payload: Record<string, unknown>,
    context: ProviderCallContext,
  ) {
    if (!isSupportedAction(capability_id)) {
      throw new Error(`Unsupported capability \"${capability_id}\" for provider \"jira\"`);
    }
    return {
      kind: "action",
      result: makeActionResult("jira", capability_id, {
        target: context.target,
        title: typeof payload.title === "string" ? payload.title : null,
        status: typeof payload.status === "string" ? payload.status : null,
      }),
    };
  },
};
