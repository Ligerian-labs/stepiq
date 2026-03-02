import type { ConnectorProvider } from "@stepiq/core";
import type { ConnectorProviderAdapter, ProviderCapability } from "./contracts.js";
import { discordAdapter } from "./providers/discord/index.js";
import { githubAdapter } from "./providers/github/index.js";
import { gmailAdapter } from "./providers/gmail/index.js";
import { jiraAdapter } from "./providers/jira/index.js";
import { linearAdapter } from "./providers/linear/index.js";
import { mondayAdapter } from "./providers/monday/index.js";
import { s3Adapter } from "./providers/s3/index.js";
import { slackAdapter } from "./providers/slack/index.js";
import { telegramAdapter } from "./providers/telegram/index.js";

const providerRegistry: Record<ConnectorProvider, ConnectorProviderAdapter> = {
  gmail: gmailAdapter,
  github: githubAdapter,
  slack: slackAdapter,
  discord: discordAdapter,
  telegram: telegramAdapter,
  linear: linearAdapter,
  jira: jiraAdapter,
  monday: mondayAdapter,
  s3: s3Adapter,
};

export function getProviderAdapter(
  provider: ConnectorProvider,
): ConnectorProviderAdapter {
  return providerRegistry[provider];
}

export function listProviderCapabilities(
  provider: ConnectorProvider,
): ProviderCapability[] {
  return getProviderAdapter(provider).getCapabilities();
}
