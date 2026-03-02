import type { ConnectorProvider } from "@stepiq/core";

export type ProviderDirection = "fetch" | "action";

export type ProviderAuthField = "access_token" | "bot_token";

export interface ProviderCapability {
  id: string;
  direction: ProviderDirection;
  title: string;
  description: string;
  requires_target: boolean;
  required_auth_fields: ProviderAuthField[];
}

export interface BuildPayloadArgs {
  capability_id: string;
  input: Record<string, unknown>;
}

export interface ProviderCallContext {
  auth?: {
    access_token?: string;
    bot_token?: string;
  };
  target?: string;
  dry_run?: boolean;
  trace_id?: string;
}

export interface FetchedInboundItem {
  event_id: string;
  event_type: string;
  workspace_id?: string;
  channel_id?: string;
  user_id?: string;
  message_id?: string;
  text?: string;
  entities?: Record<string, unknown>;
}

export interface ProviderActionResult {
  ok: boolean;
  provider: ConnectorProvider;
  action: string;
  external_id: string;
  executed_at: string;
  details: Record<string, unknown>;
}

export type ProviderCallResult =
  | {
      kind: "fetch";
      items: FetchedInboundItem[];
    }
  | {
      kind: "action";
      result: ProviderActionResult;
    };

export interface ConnectorProviderAdapter {
  provider: ConnectorProvider;
  getCapabilities(): ProviderCapability[];
  buildPayload(args: BuildPayloadArgs): Record<string, unknown>;
  callTool(
    capability_id: string,
    payload: Record<string, unknown>,
    context: ProviderCallContext,
  ): Promise<ProviderCallResult>;
}
