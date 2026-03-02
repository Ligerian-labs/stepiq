import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { AppShell } from "../components/app-shell";
import {
  trackApiKeyCreated,
  trackBillingCheckout,
  trackSecretCreated,
  trackSecretDeleted,
  trackSecretUpdated,
  trackSettingsViewed,
} from "../lib/analytics";
import {
  ApiError,
  type ApiKeyRecord,
  type BillingCheckoutRequest,
  type BillingCheckoutResponse,
  type BillingPortalResponse,
  type CreatedApiKeyRecord,
  type SecretRecord,
  type UsageRecord,
  type UserMe,
  apiFetch,
} from "../lib/api";
import { PLAN_BILLING_PRICES, YEARLY_DISCOUNT_PERCENT } from "../lib/billing";

const tabs = ["Profile", "API Keys", "Secrets", "Billing"] as const;

export function SettingsPage() {
  const queryClient = useQueryClient();
  const [tab, setTab] = useState<(typeof tabs)[number]>("Profile");
  const [secretName, setSecretName] = useState("");
  const [secretValue, setSecretValue] = useState("");
  const [secretUpdateName, setSecretUpdateName] = useState<string | null>(null);
  const [secretUpdateValue, setSecretUpdateValue] = useState("");
  const [secretError, setSecretError] = useState<string | null>(null);
  const [secretSuccess, setSecretSuccess] = useState<string | null>(null);
  const [apiKeyName, setApiKeyName] = useState("");
  const [apiKeyError, setApiKeyError] = useState<string | null>(null);
  const [apiKeySuccess, setApiKeySuccess] = useState<string | null>(null);
  const [newApiKeyValue, setNewApiKeyValue] = useState<string | null>(null);
  const [billingInterval, setBillingInterval] = useState<"month" | "year">(
    "month",
  );
  const [billingTargetPlan, setBillingTargetPlan] = useState<
    "starter" | "pro" | null
  >(null);
  const [billingMessage, setBillingMessage] = useState<string | null>(null);
  const [billingError, setBillingError] = useState<string | null>(null);
  const [discountCode, setDiscountCode] = useState("");
  const meQ = useQuery({
    queryKey: ["me"],
    queryFn: () => apiFetch<UserMe>("/api/user/me"),
  });
  const usageQ = useQuery({
    queryKey: ["usage"],
    queryFn: () => apiFetch<UsageRecord>("/api/user/usage"),
  });
  const secretsQ = useQuery({
    queryKey: ["user-secrets"],
    queryFn: () => apiFetch<SecretRecord[]>("/api/user/secrets"),
  });
  const apiKeysQ = useQuery({
    queryKey: ["user-api-keys"],
    queryFn: () => apiFetch<ApiKeyRecord[]>("/api/user/api-keys"),
  });
  const usage = useMemo(() => usageQ.data, [usageQ.data]);

  const createSecretMut = useMutation({
    mutationFn: (payload: { name: string; value: string }) =>
      apiFetch<SecretRecord>("/api/user/secrets", {
        method: "POST",
        body: JSON.stringify(payload),
      }),
    onSuccess: () => {
      trackSecretCreated("user");
      setSecretName("");
      setSecretValue("");
      setSecretError(null);
      setSecretSuccess("Secret saved");
      queryClient.invalidateQueries({ queryKey: ["user-secrets"] });
    },
    onError: (err) => {
      const message =
        err instanceof ApiError ? err.message : "Failed to create secret";
      setSecretSuccess(null);
      setSecretError(message);
    },
  });

  const deleteSecretMut = useMutation({
    mutationFn: (name: string) =>
      apiFetch<{ deleted: boolean }>(
        `/api/user/secrets/${encodeURIComponent(name)}`,
        { method: "DELETE" },
      ),
    onSuccess: () => {
      trackSecretDeleted("user");
      setSecretError(null);
      setSecretSuccess("Secret removed");
      queryClient.invalidateQueries({ queryKey: ["user-secrets"] });
    },
    onError: (err) => {
      const message =
        err instanceof ApiError ? err.message : "Failed to delete secret";
      setSecretSuccess(null);
      setSecretError(message);
    },
  });

  const updateSecretMut = useMutation({
    mutationFn: (payload: { name: string; value: string }) =>
      apiFetch<SecretRecord>(
        `/api/user/secrets/${encodeURIComponent(payload.name)}`,
        {
          method: "PUT",
          body: JSON.stringify({ value: payload.value }),
        },
      ),
    onSuccess: (_, payload) => {
      trackSecretUpdated("user");
      setSecretUpdateValue("");
      setSecretUpdateName(null);
      setSecretError(null);
      setSecretSuccess(`Secret "${payload.name}" updated`);
      queryClient.invalidateQueries({ queryKey: ["user-secrets"] });
    },
    onError: (err) => {
      const message =
        err instanceof ApiError ? err.message : "Failed to update secret";
      setSecretSuccess(null);
      setSecretError(message);
    },
  });

  const checkoutMut = useMutation({
    mutationFn: (payload: BillingCheckoutRequest) =>
      apiFetch<BillingCheckoutResponse>("/api/billing/checkout", {
        method: "POST",
        body: JSON.stringify(payload),
      }),
    onSuccess: (res, payload) => {
      trackBillingCheckout(payload.plan, payload.interval);
      window.location.href = res.url;
    },
    onError: (err) => {
      setBillingMessage(null);
      setBillingError(
        err instanceof ApiError ? err.message : "Failed to start checkout",
      );
    },
  });

  const portalMut = useMutation({
    mutationFn: () =>
      apiFetch<BillingPortalResponse>("/api/billing/portal", {
        method: "POST",
      }),
    onSuccess: (res) => {
      window.location.href = res.url;
    },
    onError: (err) => {
      setBillingMessage(null);
      setBillingError(
        err instanceof ApiError ? err.message : "Failed to open billing portal",
      );
    },
  });

  const createApiKeyMut = useMutation({
    mutationFn: (payload: { name?: string; scopes: string[] }) =>
      apiFetch<CreatedApiKeyRecord>("/api/user/api-keys", {
        method: "POST",
        body: JSON.stringify(payload),
      }),
    onSuccess: (created) => {
      trackApiKeyCreated();
      setApiKeyName("");
      setApiKeyError(null);
      setApiKeySuccess(
        "API key created. Copy it now, it won't be shown again.",
      );
      setNewApiKeyValue(created.key);
      queryClient.invalidateQueries({ queryKey: ["user-api-keys"] });
    },
    onError: (err) => {
      setApiKeySuccess(null);
      setNewApiKeyValue(null);
      setApiKeyError(
        err instanceof ApiError ? err.message : "Failed to create API key",
      );
    },
  });

  const revokeApiKeyMut = useMutation({
    mutationFn: (id: string) =>
      apiFetch<{ deleted: boolean }>(`/api/user/api-keys/${id}`, {
        method: "DELETE",
      }),
    onSuccess: () => {
      setApiKeyError(null);
      setApiKeySuccess("API key revoked");
      queryClient.invalidateQueries({ queryKey: ["user-api-keys"] });
    },
    onError: (err) => {
      setApiKeySuccess(null);
      setApiKeyError(
        err instanceof ApiError ? err.message : "Failed to revoke API key",
      );
    },
  });

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const tabParam = params.get("tab");
    const intervalParam = params.get("interval");
    const planParam = params.get("plan");
    const discountParam = params.get("discount");
    const checkoutParam = params.get("checkout");

    if (tabParam === "Billing") {
      setTab("Billing");
      trackSettingsViewed("Billing");
    } else {
      trackSettingsViewed("Profile");
    }
    if (intervalParam === "month" || intervalParam === "year") {
      setBillingInterval(intervalParam);
    }
    if (planParam === "starter" || planParam === "pro") {
      setBillingTargetPlan(planParam);
    }
    if (discountParam) {
      setDiscountCode(discountParam.toUpperCase());
    }
    if (checkoutParam === "success") {
      setBillingMessage("Checkout completed. Your subscription is updating.");
    } else if (checkoutParam === "cancel") {
      setBillingMessage("Checkout canceled.");
    }
  }, []);

  function submitSecret() {
    setSecretSuccess(null);
    const normalizedName = secretName.trim().toUpperCase();
    if (!normalizedName || !secretValue.trim()) {
      setSecretError("Name and value are required");
      return;
    }
    createSecretMut.mutate({
      name: normalizedName,
      value: secretValue,
    });
  }

  function submitSecretUpdate() {
    if (!secretUpdateName || !secretUpdateValue.trim()) {
      setSecretError("New secret value is required");
      return;
    }
    setSecretSuccess(null);
    updateSecretMut.mutate({
      name: secretUpdateName,
      value: secretUpdateValue,
    });
  }

  function createApiKey() {
    setApiKeySuccess(null);
    setApiKeyError(null);
    createApiKeyMut.mutate({
      name: apiKeyName.trim() || undefined,
      scopes: ["pipelines:read", "pipelines:execute", "webhooks:trigger"],
    });
  }

  async function copyApiKey() {
    if (!newApiKeyValue) return;
    try {
      await navigator.clipboard.writeText(newApiKeyValue);
      setApiKeySuccess("API key copied to clipboard");
    } catch {
      setApiKeyError("Failed to copy API key");
    }
  }

  function formatCents(cents: number): string {
    return `€${(cents / 100).toFixed(0)}`;
  }

  function openPlanSwitcher() {
    const currentPlan = (meQ.data?.plan || "free").toLowerCase();
    setBillingError(null);
    setBillingMessage(null);
    setTab("Billing");

    if (currentPlan === "free") {
      setBillingTargetPlan("starter");
      return;
    }
    if (currentPlan === "starter") {
      setBillingTargetPlan("pro");
      return;
    }
    setBillingTargetPlan(null);
  }

  return (
    <AppShell
      title="Settings"
      subtitle="Manage your account, API keys, and billing"
    >
      <div className="flex flex-col gap-6 md:flex-row">
        {/* Tab sidebar — horizontal on mobile, vertical on desktop */}
        <div className="flex w-full gap-1 overflow-x-auto md:w-[200px] md:shrink-0 md:flex-col">
          {tabs.map((item) => (
            <button
              key={item}
              type="button"
              onClick={() => setTab(item)}
              className={`whitespace-nowrap rounded-lg px-3 py-2.5 text-left text-sm transition-colors md:w-full ${
                tab === item
                  ? "bg-[var(--bg-surface)] font-medium text-[var(--text-primary)]"
                  : "text-[var(--text-secondary)] hover:bg-[var(--bg-surface)]"
              }`}
            >
              {item}
            </button>
          ))}
        </div>

        {/* Panel */}
        <div className="flex flex-1 flex-col gap-5">
          {tab === "Profile" ? (
            <>
              {/* Profile card — cornerRadius 12, padding 20 */}
              <div className="rounded-xl border border-[var(--divider)] bg-[var(--bg-surface)] p-5">
                <h2 className="mb-4 text-[15px] font-semibold">
                  Profile Information
                </h2>
                {meQ.isLoading ? (
                  <p className="text-sm text-[var(--text-tertiary)]">
                    Loading...
                  </p>
                ) : null}
                {meQ.data ? (
                  <div className="flex flex-col gap-4">
                    {/* Name / Email row — inputs cornerRadius 6 */}
                    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 sm:gap-4">
                      <label className="flex flex-col gap-1.5">
                        <span className="text-xs font-medium text-[var(--text-secondary)]">
                          Name
                        </span>
                        <input
                          className="w-full rounded-[6px] border border-[var(--divider)] bg-[var(--bg-inset)] px-3.5 py-2.5 text-[13px] focus:border-[var(--accent)] focus:outline-none"
                          defaultValue={meQ.data.name || ""}
                          placeholder="Your name"
                        />
                      </label>
                      <label className="flex flex-col gap-1.5">
                        <span className="text-xs font-medium text-[var(--text-secondary)]">
                          Email
                        </span>
                        <input
                          className="w-full rounded-[6px] border border-[var(--divider)] bg-[var(--bg-inset)] px-3.5 py-2.5 text-[13px] focus:border-[var(--accent)] focus:outline-none"
                          defaultValue={meQ.data.email}
                          readOnly
                        />
                      </label>
                    </div>
                    {/* Save button — cornerRadius 8 */}
                    <button
                      type="button"
                      className="w-fit rounded-lg bg-[var(--accent)] px-4 py-2 text-sm font-semibold text-[var(--bg-primary)]"
                    >
                      Save changes
                    </button>
                  </div>
                ) : null}
              </div>

              {/* Plan card — cornerRadius 12 */}
              <div className="rounded-xl border border-[var(--divider)] bg-[var(--bg-surface)] p-5">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <h2 className="text-[15px] font-semibold">Current Plan</h2>
                    {/* Badge — cornerRadius 100 */}
                    <span
                      className="rounded-full px-2.5 py-0.5 text-[11px] font-semibold capitalize"
                      style={{
                        background: "rgba(34,211,238,0.15)",
                        color: "var(--accent)",
                        fontFamily: "var(--font-mono)",
                      }}
                    >
                      {meQ.data?.plan || "Free"}
                    </span>
                  </div>
                  <button
                    type="button"
                    onClick={openPlanSwitcher}
                    className="rounded-lg border border-[var(--text-muted)] px-4 py-2 text-sm font-medium text-[var(--text-secondary)]"
                  >
                    Upgrade Plan
                  </button>
                </div>
                {/* Usage bar — track cornerRadius 4, fill cornerRadius 4 */}
                <div className="mt-4">
                  <div className="mb-2 flex items-center justify-between text-sm">
                    <span className="text-[var(--text-secondary)]">
                      Credit usage
                    </span>
                    <span style={{ fontFamily: "var(--font-mono)" }}>
                      {usage?.credits_used ?? 0} /{" "}
                      {(usage?.credits_used ?? 0) +
                        (usage?.credits_remaining ?? 0)}
                    </span>
                  </div>
                  <div className="h-2 rounded bg-[var(--bg-inset)]">
                    <div
                      className="h-2 rounded bg-[var(--accent)]"
                      style={{
                        width:
                          (usage?.credits_used ?? 0) +
                            (usage?.credits_remaining ?? 0) >
                          0
                            ? `${(((usage?.credits_used ?? 0) / ((usage?.credits_used ?? 0) + (usage?.credits_remaining ?? 0))) * 100).toFixed(0)}%`
                            : "0%",
                      }}
                    />
                  </div>
                </div>
              </div>

              {/* Danger zone — cornerRadius 12 */}
              <div className="rounded-xl border border-red-500/30 bg-[var(--bg-surface)] p-5">
                <h2 className="mb-2 text-[15px] font-semibold text-red-400">
                  Danger Zone
                </h2>
                <p className="mb-4 text-sm text-[var(--text-tertiary)]">
                  Permanently delete your account and all pipeline data. This
                  cannot be undone.
                </p>
                <button
                  type="button"
                  className="rounded-lg border border-red-500/40 px-4 py-2 text-sm font-medium text-red-300 opacity-60"
                  disabled
                >
                  Delete account
                </button>
              </div>
            </>
          ) : null}

          {tab === "API Keys" ? (
            <div className="rounded-xl border border-[var(--divider)] bg-[var(--bg-surface)] p-5">
              <h2 className="mb-2 text-[15px] font-semibold">API Keys</h2>
              <p className="mb-4 text-sm text-[var(--text-tertiary)]">
                Manage credentials for webhook triggers and API integrations.
              </p>

              <div className="mb-4 grid grid-cols-[1fr_auto] gap-3">
                <input
                  value={apiKeyName}
                  onChange={(e) => setApiKeyName(e.target.value)}
                  placeholder="Key name (optional)"
                  className="w-full rounded-[6px] border border-[var(--divider)] bg-[var(--bg-inset)] px-3.5 py-2.5 text-[13px] focus:border-[var(--accent)] focus:outline-none"
                />
                <button
                  type="button"
                  onClick={createApiKey}
                  disabled={createApiKeyMut.isPending}
                  className="cursor-pointer rounded-lg bg-[var(--accent)] px-4 py-2 text-sm font-semibold text-[var(--bg-primary)] disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {createApiKeyMut.isPending ? "Creating..." : "Create key"}
                </button>
              </div>

              {newApiKeyValue ? (
                <div className="mb-4 rounded-[10px] border border-amber-500/30 bg-amber-500/10 p-4">
                  <p className="text-xs font-semibold uppercase text-amber-200">
                    New key (shown once)
                  </p>
                  <code className="mt-2 block break-all rounded border border-amber-500/30 bg-[var(--bg-primary)] p-2 font-[var(--font-mono)] text-xs text-amber-100">
                    {newApiKeyValue}
                  </code>
                  <div className="mt-3 flex gap-2">
                    <button
                      type="button"
                      onClick={copyApiKey}
                      className="cursor-pointer rounded-lg border border-amber-500/40 px-3 py-1.5 text-xs text-amber-100"
                    >
                      Copy
                    </button>
                    <button
                      type="button"
                      onClick={() => setNewApiKeyValue(null)}
                      className="cursor-pointer rounded-lg border border-amber-500/40 px-3 py-1.5 text-xs text-amber-100"
                    >
                      Hide
                    </button>
                  </div>
                </div>
              ) : null}

              {apiKeyError ? (
                <p className="mb-3 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-300">
                  {apiKeyError}
                </p>
              ) : null}
              {apiKeySuccess ? (
                <p className="mb-3 rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-sm text-emerald-300">
                  {apiKeySuccess}
                </p>
              ) : null}

              <div className="rounded-[10px] border border-[var(--divider)] bg-[var(--bg-inset)]">
                <div className="flex items-center justify-between border-b border-[var(--divider)] px-4 py-3">
                  <h3 className="text-sm font-semibold">Active keys</h3>
                  <span
                    className="text-xs text-[var(--text-tertiary)]"
                    style={{ fontFamily: "var(--font-mono)" }}
                  >
                    only prefixes are stored
                  </span>
                </div>
                {apiKeysQ.isLoading ? (
                  <p className="px-4 py-4 text-sm text-[var(--text-tertiary)]">
                    Loading keys...
                  </p>
                ) : null}
                {apiKeysQ.isError ? (
                  <p className="px-4 py-4 text-sm text-red-300">
                    Failed to load API keys
                  </p>
                ) : null}
                {apiKeysQ.data && apiKeysQ.data.length === 0 ? (
                  <p className="px-4 py-4 text-sm text-[var(--text-tertiary)]">
                    No API keys yet
                  </p>
                ) : null}
                {apiKeysQ.data?.map((key) => (
                  <div
                    key={key.id}
                    className="flex items-center justify-between border-t border-[var(--divider)] px-4 py-3 first:border-t-0"
                  >
                    <div>
                      <p className="text-sm font-medium">
                        {key.name || "Unnamed key"}
                      </p>
                      <p
                        className="text-xs text-[var(--text-tertiary)]"
                        style={{ fontFamily: "var(--font-mono)" }}
                      >
                        {(key.keyPrefix ?? key.key_prefix) || "sk_live_..."} •{" "}
                        {new Date(
                          key.createdAt ?? key.created_at ?? Date.now(),
                        ).toLocaleString()}
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={() => revokeApiKeyMut.mutate(key.id)}
                      disabled={revokeApiKeyMut.isPending}
                      className="cursor-pointer rounded-lg border border-red-500/30 px-3 py-1.5 text-xs text-red-300 disabled:cursor-not-allowed disabled:opacity-60"
                    >
                      Revoke
                    </button>
                  </div>
                ))}
              </div>
            </div>
          ) : null}

          {tab === "Secrets" ? (
            <div className="rounded-xl border border-[var(--divider)] bg-[var(--bg-surface)] p-5">
              <h2 className="mb-2 text-[15px] font-semibold">Secrets</h2>
              <p className="mb-4 text-sm text-[var(--text-tertiary)]">
                Store global secrets shared across pipelines. For pipeline-only
                secrets, use the pipeline editor.
              </p>
              <div className="mb-4 rounded-[10px] border border-[var(--divider)] bg-[var(--bg-inset)] px-4 py-3">
                <p className="text-xs font-medium text-[var(--text-secondary)]">
                  Supported provider secret names
                </p>
                <div
                  className="mt-2 flex flex-wrap gap-2 text-[11px] text-[var(--text-tertiary)]"
                  style={{ fontFamily: "var(--font-mono)" }}
                >
                  <span className="rounded border border-[var(--divider)] px-2 py-1">
                    OPENAI_API_KEY
                  </span>
                  <span className="rounded border border-[var(--divider)] px-2 py-1">
                    ANTHROPIC_API_KEY
                  </span>
                  <span className="rounded border border-[var(--divider)] px-2 py-1">
                    GEMINI_API_KEY
                  </span>
                  <span className="rounded border border-[var(--divider)] px-2 py-1">
                    GOOGLE_API_KEY
                  </span>
                  <span className="rounded border border-[var(--divider)] px-2 py-1">
                    MISTRAL_API_KEY
                  </span>
                  <span className="rounded border border-[var(--divider)] px-2 py-1">
                    ZAI_API_KEY
                  </span>
                </div>
              </div>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 sm:gap-4">
                <label className="flex flex-col gap-1.5">
                  <span className="text-xs font-medium text-[var(--text-secondary)]">
                    Secret name
                  </span>
                  <input
                    className="w-full rounded-[6px] border border-[var(--divider)] bg-[var(--bg-inset)] px-3.5 py-2.5 font-[var(--font-mono)] text-[13px] uppercase focus:border-[var(--accent)] focus:outline-none"
                    value={secretName}
                    onChange={(e) => setSecretName(e.target.value)}
                    placeholder="OPENAI_API_KEY"
                  />
                </label>
                <label className="flex flex-col gap-1.5">
                  <span className="text-xs font-medium text-[var(--text-secondary)]">
                    Secret value
                  </span>
                  <input
                    type="password"
                    className="w-full rounded-[6px] border border-[var(--divider)] bg-[var(--bg-inset)] px-3.5 py-2.5 font-[var(--font-mono)] text-[13px] focus:border-[var(--accent)] focus:outline-none"
                    value={secretValue}
                    onChange={(e) => setSecretValue(e.target.value)}
                    placeholder="sk-..."
                  />
                </label>
              </div>
              <div className="mt-4 flex items-center gap-3">
                <button
                  type="button"
                  onClick={submitSecret}
                  disabled={createSecretMut.isPending}
                  className="cursor-pointer rounded-lg bg-[var(--accent)] px-4 py-2 text-sm font-semibold text-[var(--bg-primary)] disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {createSecretMut.isPending ? "Saving..." : "Save secret"}
                </button>
                <p className="text-xs text-[var(--text-tertiary)]">
                  Use in prompts with{" "}
                  <code className="font-[var(--font-mono)]">
                    {"{{env.SECRET_NAME}}"}
                  </code>
                </p>
              </div>

              {secretError ? (
                <p className="mt-3 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-300">
                  {secretError}
                </p>
              ) : null}
              {secretSuccess ? (
                <p className="mt-3 rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-sm text-emerald-300">
                  {secretSuccess}
                </p>
              ) : null}

              <div className="mt-5 rounded-[10px] border border-[var(--divider)] bg-[var(--bg-inset)]">
                <div className="flex items-center justify-between border-b border-[var(--divider)] px-4 py-3">
                  <h3 className="text-sm font-semibold">Stored secrets</h3>
                  <span
                    className="text-xs text-[var(--text-tertiary)]"
                    style={{ fontFamily: "var(--font-mono)" }}
                  >
                    values are never returned
                  </span>
                </div>
                {secretsQ.isLoading ? (
                  <p className="px-4 py-4 text-sm text-[var(--text-tertiary)]">
                    Loading secrets...
                  </p>
                ) : null}
                {secretsQ.isError ? (
                  <p className="px-4 py-4 text-sm text-red-300">
                    Failed to load secrets
                  </p>
                ) : null}
                {secretsQ.data && secretsQ.data.length === 0 ? (
                  <p className="px-4 py-4 text-sm text-[var(--text-tertiary)]">
                    No secrets yet
                  </p>
                ) : null}
                {secretsQ.data?.map((secret) => (
                  <div
                    key={secret.id}
                    className="flex items-center justify-between border-t border-[var(--divider)] px-4 py-3 first:border-t-0"
                  >
                    <div>
                      <p
                        className="text-sm font-medium"
                        style={{ fontFamily: "var(--font-mono)" }}
                      >
                        {secret.name}
                      </p>
                      <p className="text-xs text-[var(--text-tertiary)]">
                        Updated{" "}
                        {new Date(
                          secret.updatedAt ?? secret.updated_at ?? Date.now(),
                        ).toLocaleString()}
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={() => {
                        setSecretError(null);
                        setSecretSuccess(null);
                        setSecretUpdateValue("");
                        setSecretUpdateName(secret.name);
                      }}
                      className="cursor-pointer rounded-lg border border-[var(--divider)] px-3 py-1.5 text-xs text-[var(--text-secondary)] disabled:cursor-not-allowed disabled:opacity-60"
                    >
                      Rotate value
                    </button>
                    <button
                      type="button"
                      onClick={() => deleteSecretMut.mutate(secret.name)}
                      disabled={deleteSecretMut.isPending}
                      className="cursor-pointer rounded-lg border border-red-500/30 px-3 py-1.5 text-xs text-red-300 disabled:cursor-not-allowed disabled:opacity-60"
                    >
                      Delete
                    </button>
                  </div>
                ))}
              </div>

              {secretUpdateName ? (
                <div className="mt-4 rounded-[10px] border border-[var(--divider)] bg-[var(--bg-inset)] p-4">
                  <h3 className="text-sm font-semibold">Rotate secret value</h3>
                  <p
                    className="mt-1 text-xs text-[var(--text-tertiary)]"
                    style={{ fontFamily: "var(--font-mono)" }}
                  >
                    {secretUpdateName}
                  </p>
                  <label className="mt-3 flex flex-col gap-1.5">
                    <span className="text-xs font-medium text-[var(--text-secondary)]">
                      New value
                    </span>
                    <input
                      type="password"
                      className="w-full rounded-[6px] border border-[var(--divider)] bg-[var(--bg-surface)] px-3.5 py-2.5 font-[var(--font-mono)] text-[13px] focus:border-[var(--accent)] focus:outline-none"
                      value={secretUpdateValue}
                      onChange={(e) => setSecretUpdateValue(e.target.value)}
                      placeholder="Enter new secret value"
                    />
                  </label>
                  <div className="mt-3 flex items-center gap-2">
                    <button
                      type="button"
                      onClick={submitSecretUpdate}
                      disabled={updateSecretMut.isPending}
                      className="cursor-pointer rounded-lg bg-[var(--accent)] px-4 py-2 text-sm font-semibold text-[var(--bg-primary)] disabled:cursor-not-allowed disabled:opacity-60"
                    >
                      {updateSecretMut.isPending
                        ? "Updating..."
                        : "Update value"}
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setSecretUpdateName(null);
                        setSecretUpdateValue("");
                      }}
                      className="cursor-pointer rounded-lg border border-[var(--divider)] px-4 py-2 text-sm text-[var(--text-secondary)]"
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              ) : null}
            </div>
          ) : null}

          {tab === "Billing" ? (
            <div className="rounded-xl border border-[var(--divider)] bg-[var(--bg-surface)] p-5">
              <h2 className="mb-2 text-[15px] font-semibold">Billing</h2>
              <p className="mb-4 text-sm text-[var(--text-tertiary)]">
                View usage and manage your subscription.
              </p>
              <p className="mb-4 rounded-lg border border-[var(--divider)] bg-[var(--bg-inset)] px-3 py-2 text-xs text-[var(--text-secondary)]">
                Starter and Pro credits run on StepIQ-managed provider keys.
                When credits are exhausted, add your own provider keys in the
                Secrets tab to continue running pipelines.
              </p>
              <div className="mb-4 flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => setBillingInterval("month")}
                  className={`cursor-pointer rounded-lg px-3 py-1.5 text-xs font-semibold ${
                    billingInterval === "month"
                      ? "bg-[var(--accent)] text-[var(--bg-primary)]"
                      : "border border-[var(--divider)] text-[var(--text-secondary)]"
                  }`}
                >
                  Monthly
                </button>
                <button
                  type="button"
                  onClick={() => setBillingInterval("year")}
                  className={`cursor-pointer rounded-lg px-3 py-1.5 text-xs font-semibold ${
                    billingInterval === "year"
                      ? "bg-[var(--accent)] text-[var(--bg-primary)]"
                      : "border border-[var(--divider)] text-[var(--text-secondary)]"
                  }`}
                >
                  Yearly (save {YEARLY_DISCOUNT_PERCENT}%)
                </button>
              </div>

              <div className="mb-4">
                <label
                  className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-[var(--text-tertiary)]"
                  htmlFor="discount-code"
                >
                  Discount code
                </label>
                <input
                  id="discount-code"
                  type="text"
                  value={discountCode}
                  onChange={(event) =>
                    setDiscountCode(event.target.value.toUpperCase())
                  }
                  placeholder="Optional"
                  className="w-full rounded-lg border border-[var(--divider)] bg-[var(--bg-primary)] px-3 py-2 text-sm text-[var(--text-primary)] outline-none focus:border-[var(--accent)]"
                />
              </div>

              <div className="mb-5 grid grid-cols-1 gap-3 sm:grid-cols-2 sm:gap-4">
                {(["starter", "pro"] as const).map((plan) => {
                  const currentPlan = (meQ.data?.plan || "free").toLowerCase();
                  const isCurrent = currentPlan === plan;
                  const monthly = PLAN_BILLING_PRICES[plan].monthly_cents;
                  const yearly = PLAN_BILLING_PRICES[plan].yearly_cents;
                  const selectedPrice =
                    billingInterval === "month" ? monthly : yearly;
                  return (
                    <div
                      key={plan}
                      className={`rounded-[10px] border p-4 ${
                        billingTargetPlan === plan
                          ? "border-[var(--accent)]"
                          : "border-[var(--divider)]"
                      }`}
                    >
                      <div className="mb-2 flex items-center justify-between">
                        <h3 className="text-sm font-semibold capitalize">
                          {plan}
                        </h3>
                        {isCurrent ? (
                          <span className="rounded-full bg-[var(--accent)]/20 px-2 py-0.5 text-[10px] font-semibold uppercase text-[var(--accent)]">
                            Current
                          </span>
                        ) : null}
                      </div>
                      <p className="text-2xl font-bold">
                        {formatCents(selectedPrice)}
                        <span className="ml-1 text-xs font-medium text-[var(--text-tertiary)]">
                          /{billingInterval === "month" ? "month" : "year"}
                        </span>
                      </p>
                      <p className="mt-1 text-xs text-[var(--text-tertiary)]">
                        {billingInterval === "year"
                          ? `${formatCents(monthly * 12 - yearly)} saved yearly`
                          : `${formatCents(yearly)}/year with yearly billing`}
                      </p>
                      <button
                        type="button"
                        disabled={isCurrent || checkoutMut.isPending}
                        onClick={() => {
                          setBillingError(null);
                          setBillingMessage(null);
                          checkoutMut.mutate({
                            plan,
                            interval: billingInterval,
                            ...(discountCode.trim()
                              ? { discount_code: discountCode.trim() }
                              : {}),
                          });
                        }}
                        className="mt-3 w-full cursor-pointer rounded-lg bg-[var(--accent)] px-3 py-2 text-sm font-semibold text-[var(--bg-primary)] disabled:cursor-not-allowed disabled:opacity-60"
                      >
                        {checkoutMut.isPending
                          ? "Redirecting..."
                          : isCurrent
                            ? "Current plan"
                            : `Choose ${plan}`}
                      </button>
                    </div>
                  );
                })}
              </div>

              <div className="mb-4">
                <button
                  type="button"
                  onClick={() => {
                    setBillingError(null);
                    setBillingMessage(null);
                    portalMut.mutate();
                  }}
                  disabled={portalMut.isPending}
                  className="cursor-pointer rounded-lg border border-[var(--divider)] px-4 py-2 text-sm font-medium text-[var(--text-secondary)] disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {portalMut.isPending ? "Opening..." : "Manage billing"}
                </button>
              </div>

              {billingMessage ? (
                <p className="mb-4 rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-sm text-emerald-300">
                  {billingMessage}
                </p>
              ) : null}
              {billingError ? (
                <p className="mb-4 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-300">
                  {billingError}
                </p>
              ) : null}
              <div className="grid grid-cols-2 gap-3 md:grid-cols-4 md:gap-4">
                <Tile
                  label="Credits used"
                  value={String(usage?.credits_used ?? 0)}
                />
                <Tile
                  label="Credits left"
                  value={String(usage?.credits_remaining ?? 0)}
                />
                <Tile
                  label="Runs today"
                  value={String(usage?.runs_today ?? 0)}
                />
                <Tile
                  label="Total cost"
                  value={`€${((usage?.total_cost_cents ?? 0) / 100).toFixed(2)}`}
                />
              </div>
            </div>
          ) : null}
        </div>
      </div>
    </AppShell>
  );
}

function Tile({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-[10px] border border-[var(--divider)] bg-[var(--bg-inset)] p-4">
      <p
        className="text-[10px] font-semibold uppercase text-[var(--text-tertiary)]"
        style={{ fontFamily: "var(--font-mono)", letterSpacing: "1.5px" }}
      >
        {label}
      </p>
      <p
        className="mt-2 text-lg font-bold"
        style={{ fontFamily: "var(--font-mono)" }}
      >
        {value}
      </p>
    </div>
  );
}
