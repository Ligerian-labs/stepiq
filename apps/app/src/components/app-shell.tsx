import { cn } from "@stepiq/ui";
import { useQuery } from "@tanstack/react-query";
import { Link, useLocation, useNavigate } from "@tanstack/react-router";
import { type ReactNode, useState } from "react";
import { trackLogout } from "../lib/analytics";
import { type UserMe, apiFetch } from "../lib/api";
import { clearToken } from "../lib/auth";

const navItems = [
  { to: "/dashboard", label: "Dashboard", icon: "dashboard" },
  { to: "/pipelines", label: "Pipelines", icon: "workflow" },
  { to: "/builder", label: "Builder", icon: "magic-wand" },
  { to: "/runs", label: "Runs", icon: "play" },
  { to: "/schedules", label: "Schedules", icon: "timer" },
  { to: "/templates", label: "Templates", icon: "layout-template" },
];

function NavIcon({
  name,
  className,
}: {
  name: string;
  className?: string;
}) {
  if (name === "dashboard") {
    return (
      <svg
        aria-hidden="true"
        focusable="false"
        className={className}
        width="18"
        height="18"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <rect x="3" y="3" width="7" height="7" rx="1.2" />
        <rect x="14" y="3" width="7" height="7" rx="1.2" />
        <rect x="3" y="14" width="7" height="7" rx="1.2" />
        <rect x="14" y="14" width="7" height="7" rx="1.2" />
      </svg>
    );
  }
  if (name === "workflow") {
    return (
      <svg
        aria-hidden="true"
        focusable="false"
        className={className}
        width="18"
        height="18"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <circle cx="6" cy="6" r="2" />
        <circle cx="18" cy="6" r="2" />
        <circle cx="12" cy="18" r="2" />
        <path d="M8 6h8M7.5 7.5l3.5 8M16.5 7.5l-3.5 8" />
      </svg>
    );
  }
  if (name === "magic-wand") {
    return (
      <svg
        aria-hidden="true"
        focusable="false"
        className={className}
        width="18"
        height="18"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M15 4V2M15 16v-2M8 9h2M20 9h2M17.8 11.8l1.4 1.4M17.8 6.2l1.4-1.4M3 21l9-9M12.2 6.2l-1.4-1.4" />
        <path d="M15 9a2 2 0 100 4 2 2 0 000-4z" />
      </svg>
    );
  }
  if (name === "play") {
    return (
      <svg
        aria-hidden="true"
        focusable="false"
        className={className}
        width="18"
        height="18"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <polygon points="8 6 18 12 8 18 8 6" />
      </svg>
    );
  }
  if (name === "timer") {
    return (
      <svg
        aria-hidden="true"
        focusable="false"
        className={className}
        width="18"
        height="18"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <circle cx="12" cy="13" r="8" />
        <path d="M12 9v4l3 2M9 3h6" />
      </svg>
    );
  }
  return (
    <svg
      aria-hidden="true"
      focusable="false"
      className={className}
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <rect x="3" y="4" width="8" height="7" rx="1.2" />
      <rect x="13" y="4" width="8" height="7" rx="1.2" />
      <rect x="3" y="13" width="8" height="7" rx="1.2" />
      <rect x="13" y="13" width="8" height="7" rx="1.2" />
    </svg>
  );
}

export function AppShell({
  title,
  subtitle,
  actions,
  children,
}: {
  title?: string;
  subtitle?: string;
  actions?: ReactNode;
  children: ReactNode;
}) {
  const location = useLocation();
  const navigate = useNavigate();
  const meQ = useQuery({
    queryKey: ["me"],
    queryFn: () => apiFetch<UserMe>("/api/user/me"),
  });

  const displayName = meQ.data?.name?.trim() || meQ.data?.email || "User";
  const planName = `${(meQ.data?.plan || "free").toString()} plan`;
  const isAdmin = Boolean(meQ.data?.isAdmin);
  const initials = getInitials(displayName);

  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

  return (
    <div className="flex min-h-screen bg-[var(--bg-primary)] text-[var(--text-primary)]">
      {/* Mobile top bar */}
      <div className="fixed inset-x-0 top-0 z-30 flex items-center justify-between border-b border-[var(--divider)] bg-[var(--bg-inset)] px-4 py-3 md:hidden">
        <div className="flex items-center gap-2">
          <div className="grid size-7 place-items-center rounded-[6px] bg-[var(--accent)] text-[var(--bg-primary)]">
            <svg
              aria-hidden="true"
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <rect x="3" y="3" width="7" height="7" rx="1.5" />
              <rect x="14" y="14" width="7" height="7" rx="1.5" />
              <path d="M7 10v4a3 3 0 0 0 3 3h4" />
              <circle cx="17.5" cy="6.5" r="3.5" />
            </svg>
          </div>
          <span
            className="text-base font-bold"
            style={{ fontFamily: "var(--font-mono)" }}
          >
            stepIQ
          </span>
        </div>
        <button
          type="button"
          className="rounded-md p-1.5 text-[var(--text-secondary)] hover:bg-[var(--bg-surface)]"
          onClick={() => setMobileMenuOpen(!mobileMenuOpen)}
          aria-label="Toggle menu"
        >
          {mobileMenuOpen ? (
            <svg
              aria-hidden="true"
              width="20"
              height="20"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          ) : (
            <svg
              aria-hidden="true"
              width="20"
              height="20"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <line x1="3" y1="6" x2="21" y2="6" />
              <line x1="3" y1="12" x2="21" y2="12" />
              <line x1="3" y1="18" x2="21" y2="18" />
            </svg>
          )}
        </button>
      </div>

      {/* Mobile slide-out menu */}
      {mobileMenuOpen ? (
        <>
          <div
            className="fixed inset-0 z-40 bg-black/50 md:hidden"
            onClick={() => setMobileMenuOpen(false)}
            onKeyDown={() => {}}
            role="presentation"
          />
          <aside
            className="fixed inset-y-0 left-0 z-50 flex w-[280px] flex-col border-r border-[var(--divider)] bg-[var(--bg-inset)] px-5 py-6 md:hidden"
            style={{ gap: 32 }}
          >
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <div className="grid size-7 place-items-center rounded-[6px] bg-[var(--accent)] text-[var(--bg-primary)]">
                  <svg
                    aria-hidden="true"
                    width="16"
                    height="16"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <rect x="3" y="3" width="7" height="7" rx="1.5" />
                    <rect x="14" y="14" width="7" height="7" rx="1.5" />
                    <path d="M7 10v4a3 3 0 0 0 3 3h4" />
                    <circle cx="17.5" cy="6.5" r="3.5" />
                  </svg>
                </div>
                <span
                  className="text-base font-bold"
                  style={{ fontFamily: "var(--font-mono)" }}
                >
                  stepIQ
                </span>
              </div>
              <button
                type="button"
                className="rounded-md p-1.5 text-[var(--text-tertiary)] hover:text-[var(--text-secondary)]"
                onClick={() => setMobileMenuOpen(false)}
                aria-label="Close menu"
              >
                <svg
                  aria-hidden="true"
                  width="18"
                  height="18"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <line x1="18" y1="6" x2="6" y2="18" />
                  <line x1="6" y1="6" x2="18" y2="18" />
                </svg>
              </button>
            </div>
            <nav className="flex flex-col gap-1">
              {navItems.map((item) => {
                const active = item.to && location.pathname.startsWith(item.to);
                const isPlaceholder =
                  item.to !== "/dashboard" &&
                  item.to !== "/pipelines" &&
                  item.to !== "/builder" &&
                  item.to !== "/runs" &&
                  item.to !== "/schedules";
                if (isPlaceholder) {
                  return (
                    <span
                      key={item.label}
                      className="flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm text-[var(--text-secondary)]"
                    >
                      <NavIcon
                        name={item.icon}
                        className="w-[18px] text-[var(--text-tertiary)]"
                      />
                      {item.label}
                    </span>
                  );
                }
                return (
                  <Link
                    key={item.to}
                    to={item.to}
                    className={cn(
                      "flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm transition-colors",
                      active
                        ? "bg-[var(--bg-surface)] font-medium text-[var(--text-primary)]"
                        : "text-[var(--text-secondary)] hover:bg-[var(--bg-surface)]",
                    )}
                    onClick={() => setMobileMenuOpen(false)}
                  >
                    <NavIcon
                      name={item.icon}
                      className={cn(
                        "w-[18px]",
                        active
                          ? "text-[var(--accent)]"
                          : "text-[var(--text-tertiary)]",
                      )}
                    />
                    {item.label}
                  </Link>
                );
              })}
            </nav>
            <div className="flex-1" />
            <Link
              to="/settings"
              className={cn(
                "flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm transition-colors",
                location.pathname.startsWith("/settings")
                  ? "bg-[var(--bg-surface)] font-medium text-[var(--text-primary)]"
                  : "text-[var(--text-secondary)] hover:bg-[var(--bg-surface)]",
              )}
              onClick={() => setMobileMenuOpen(false)}
            >
              <svg
                aria-hidden="true"
                className={cn(
                  "w-[18px]",
                  location.pathname.startsWith("/settings")
                    ? "text-[var(--accent)]"
                    : "text-[var(--text-tertiary)]",
                )}
                width="18"
                height="18"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <circle cx="12" cy="12" r="3" />
                <path d="M19.4 15a1.7 1.7 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.7 1.7 0 0 0-1.82-.33 1.7 1.7 0 0 0-1 1.54V21a2 2 0 0 1-4 0v-.09a1.7 1.7 0 0 0-1-1.54 1.7 1.7 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.7 1.7 0 0 0 .33-1.82 1.7 1.7 0 0 0-1.54-1H3a2 2 0 0 1 0-4h.09a1.7 1.7 0 0 0 1.54-1 1.7 1.7 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.7 1.7 0 0 0 1.82.33h.01a1.7 1.7 0 0 0 1-1.54V3a2 2 0 0 1 4 0v.09a1.7 1.7 0 0 0 1 1.54 1.7 1.7 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.7 1.7 0 0 0-.33 1.82v.01a1.7 1.7 0 0 0 1.54 1H21a2 2 0 0 1 0 4h-.09a1.7 1.7 0 0 0-1.54 1Z" />
              </svg>
              Settings
            </Link>
            {isAdmin ? (
              <Link
                to="/admin"
                className={cn(
                  "flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm transition-colors",
                  location.pathname.startsWith("/admin")
                    ? "bg-[var(--bg-surface)] font-medium text-[var(--text-primary)]"
                    : "text-[var(--text-secondary)] hover:bg-[var(--bg-surface)]",
                )}
                onClick={() => setMobileMenuOpen(false)}
              >
                <span className="w-[18px] text-center text-[var(--text-tertiary)]">
                  #
                </span>
                Admin
              </Link>
            ) : null}
            <div className="-mx-5 h-px bg-[var(--divider)]" />
            <div className="flex items-center gap-3">
              <div
                className="grid size-8 shrink-0 place-items-center rounded-full bg-[var(--bg-surface)] text-[11px] font-semibold text-[var(--text-secondary)]"
                style={{ fontFamily: "var(--font-mono)" }}
              >
                {initials}
              </div>
              <div className="min-w-0 flex-1">
                <p className="truncate text-[13px] font-medium">
                  {displayName}
                </p>
                <p
                  className="truncate text-[11px] text-[var(--text-tertiary)]"
                  style={{ fontFamily: "var(--font-mono)" }}
                >
                  {planName}
                </p>
              </div>
              <button
                type="button"
                title="Log out"
                className="rounded-md p-1.5 text-[var(--text-tertiary)] hover:bg-[var(--bg-surface)] hover:text-[var(--text-secondary)]"
                onClick={() => {
                  trackLogout();
                  clearToken();
                  navigate({ to: "/login" });
                }}
              >
                <svg
                  aria-hidden="true"
                  width="16"
                  height="16"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
                  <polyline points="16 17 21 12 16 7" />
                  <line x1="21" y1="12" x2="9" y2="12" />
                </svg>
              </button>
            </div>
          </aside>
        </>
      ) : null}

      {/* Desktop sidebar — 260px, hidden on mobile */}
      <aside
        className="hidden w-[260px] shrink-0 flex-col border-r border-[var(--divider)] bg-[var(--bg-inset)] px-5 py-6 md:flex"
        style={{ gap: 32 }}
      >
        {/* Logo — 28x28, cornerRadius 6, gap 8 */}
        <div className="flex items-center gap-2">
          <div className="grid size-7 place-items-center rounded-[6px] bg-[var(--accent)] text-[var(--bg-primary)]">
            <svg
              aria-hidden="true"
              focusable="false"
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <rect x="3" y="3" width="7" height="7" rx="1.5" />
              <rect x="14" y="14" width="7" height="7" rx="1.5" />
              <path d="M7 10v4a3 3 0 0 0 3 3h4" />
              <circle cx="17.5" cy="6.5" r="3.5" />
            </svg>
          </div>
          <span
            className="font-[var(--font-mono)] text-base font-bold"
            style={{ fontFamily: "var(--font-mono)" }}
          >
            stepIQ
          </span>
        </div>

        {/* Main nav — gap 4 */}
        <nav className="flex flex-col gap-1">
          {navItems.map((item) => {
            const active = item.to && location.pathname.startsWith(item.to);
            const isPlaceholder =
              item.to !== "/dashboard" &&
              item.to !== "/pipelines" &&
              item.to !== "/builder" &&
              item.to !== "/runs" &&
              item.to !== "/schedules";
            if (isPlaceholder) {
              return (
                <span
                  key={item.label}
                  className="flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm text-[var(--text-secondary)]"
                >
                  <NavIcon
                    name={item.icon}
                    className="w-[18px] text-[var(--text-tertiary)]"
                  />
                  {item.label}
                </span>
              );
            }
            return (
              <Link
                key={item.to}
                to={item.to}
                className={cn(
                  "flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm transition-colors",
                  active
                    ? "bg-[var(--bg-surface)] font-medium text-[var(--text-primary)]"
                    : "text-[var(--text-secondary)] hover:bg-[var(--bg-surface)]",
                )}
              >
                <NavIcon
                  name={item.icon}
                  className={cn(
                    "w-[18px]",
                    active
                      ? "text-[var(--accent)]"
                      : "text-[var(--text-tertiary)]",
                  )}
                />
                {item.label}
              </Link>
            );
          })}
        </nav>

        {/* Spacer */}
        <div className="flex-1" />

        {/* Settings — gap 4 */}
        <nav className="flex flex-col gap-1">
          <Link
            to="/settings"
            className={cn(
              "flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm transition-colors",
              location.pathname.startsWith("/settings")
                ? "bg-[var(--bg-surface)] font-medium text-[var(--text-primary)]"
                : "text-[var(--text-secondary)] hover:bg-[var(--bg-surface)]",
            )}
          >
            <svg
              aria-hidden="true"
              focusable="false"
              className={cn(
                "w-[18px]",
                location.pathname.startsWith("/settings")
                  ? "text-[var(--accent)]"
                  : "text-[var(--text-tertiary)]",
              )}
              width="18"
              height="18"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <circle cx="12" cy="12" r="3" />
              <path d="M19.4 15a1.7 1.7 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.7 1.7 0 0 0-1.82-.33 1.7 1.7 0 0 0-1 1.54V21a2 2 0 0 1-4 0v-.09a1.7 1.7 0 0 0-1-1.54 1.7 1.7 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.7 1.7 0 0 0 .33-1.82 1.7 1.7 0 0 0-1.54-1H3a2 2 0 0 1 0-4h.09a1.7 1.7 0 0 0 1.54-1 1.7 1.7 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.7 1.7 0 0 0 1.82.33h.01a1.7 1.7 0 0 0 1-1.54V3a2 2 0 0 1 4 0v.09a1.7 1.7 0 0 0 1 1.54 1.7 1.7 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.7 1.7 0 0 0-.33 1.82v.01a1.7 1.7 0 0 0 1.54 1H21a2 2 0 0 1 0 4h-.09a1.7 1.7 0 0 0-1.54 1Z" />
            </svg>
            Settings
          </Link>
          {isAdmin ? (
            <Link
              to="/admin"
              className={cn(
                "flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm transition-colors",
                location.pathname.startsWith("/admin")
                  ? "bg-[var(--bg-surface)] font-medium text-[var(--text-primary)]"
                  : "text-[var(--text-secondary)] hover:bg-[var(--bg-surface)]",
              )}
            >
              <span className="w-[18px] text-center text-[var(--text-tertiary)]">
                #
              </span>
              Admin
            </Link>
          ) : null}
        </nav>

        {/* Divider */}
        <div className="-mx-5 h-px bg-[var(--divider)]" />

        {/* User row — gap 12 */}
        <div className="flex items-center gap-3">
          <div
            className="grid size-8 shrink-0 place-items-center rounded-full bg-[var(--bg-surface)] text-[11px] font-semibold text-[var(--text-secondary)]"
            style={{ fontFamily: "var(--font-mono)" }}
          >
            {initials}
          </div>
          <div className="min-w-0 flex-1">
            <p className="truncate text-[13px] font-medium">{displayName}</p>
            <p
              className="truncate text-[11px] text-[var(--text-tertiary)]"
              style={{ fontFamily: "var(--font-mono)" }}
            >
              {planName}
            </p>
          </div>
          <button
            type="button"
            title="Log out"
            className="rounded-md p-1.5 text-[var(--text-tertiary)] hover:bg-[var(--bg-surface)] hover:text-[var(--text-secondary)]"
            onClick={() => {
              trackLogout();
              clearToken();
              navigate({ to: "/login" });
            }}
          >
            <svg
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              role="img"
              aria-label="Log out"
            >
              <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
              <polyline points="16 17 21 12 16 7" />
              <line x1="21" y1="12" x2="9" y2="12" />
            </svg>
          </button>
        </div>
      </aside>

      {/* Main content — responsive padding */}
      <main
        className="flex flex-1 flex-col overflow-auto px-4 pt-[68px] pb-6 md:px-10 md:pt-8 md:pb-8"
        style={{ gap: 24 }}
      >
        {/* Top bar */}
        {title || subtitle || actions ? (
          <header className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
            <div className="flex flex-col gap-1">
              {title ? (
                <h1 className="text-xl font-bold md:text-2xl">{title}</h1>
              ) : null}
              {subtitle ? (
                <p className="text-xs text-[var(--text-tertiary)] md:text-sm">
                  {subtitle}
                </p>
              ) : null}
            </div>
            {actions ? (
              <div className="flex items-center gap-2 md:gap-3">{actions}</div>
            ) : null}
          </header>
        ) : null}
        {children}
      </main>
    </div>
  );
}

function getInitials(value: string): string {
  const parts = value
    .split(/\s+/)
    .map((part) => part.trim())
    .filter(Boolean);
  if (parts.length === 0) return "U";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return `${parts[0][0] || ""}${parts[1][0] || ""}`.toUpperCase();
}
