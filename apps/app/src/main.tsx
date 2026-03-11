import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  Outlet,
  RouterProvider,
  createRootRoute,
  createRoute,
  createRouter,
  redirect,
} from "@tanstack/react-router";
import { StrictMode, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { initAnalytics, trackPageView } from "./lib/analytics";
import { isAuthenticated } from "./lib/auth";
import { AdminPage } from "./pages/admin";
import { AuthPage } from "./pages/auth-page";
import { BuilderPage } from "./pages/builder";
import { DashboardPage } from "./pages/dashboard";
import { NewSchedulePage } from "./pages/new-schedule";
import { NotFoundPage } from "./pages/not-found";
import { PipelineEditorPage } from "./pages/pipeline-editor";
import { PipelinesListPage } from "./pages/pipelines-list";
import { RunDetailPage } from "./pages/run-detail";
import { RunsListPage } from "./pages/runs-list";
import { SchedulesPage } from "./pages/schedules";
import { SettingsPage } from "./pages/settings";
import "./styles.css";

const queryClient = new QueryClient();

// Initialize PostHog
initAnalytics();

function RootLayout() {
  return <Outlet />;
}

const rootRoute = createRootRoute({
  component: RootLayout,
  notFoundComponent: NotFoundPage,
});

function requireAuth() {
  if (!isAuthenticated()) throw redirect({ to: "/login" });
}

function redirectIfAuth() {
  if (isAuthenticated()) throw redirect({ to: "/dashboard" });
}

const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  beforeLoad: () => {
    if (isAuthenticated()) throw redirect({ to: "/dashboard" });
    throw redirect({ to: "/login" });
  },
});

const loginRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/login",
  beforeLoad: redirectIfAuth,
  component: () => <AuthPage mode="login" />,
});

const loginNestedRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/login/$",
  beforeLoad: redirectIfAuth,
  component: () => <AuthPage mode="login" />,
});

const registerRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/register",
  beforeLoad: redirectIfAuth,
  component: () => <AuthPage mode="register" />,
});

const registerNestedRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/register/$",
  beforeLoad: redirectIfAuth,
  component: () => <AuthPage mode="register" />,
});

const dashboardRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/dashboard",
  beforeLoad: requireAuth,
  component: DashboardPage,
});

const pipelinesRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/pipelines",
  beforeLoad: requireAuth,
  component: PipelinesListPage,
});

const editorRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/pipelines/$pipelineId/edit",
  beforeLoad: requireAuth,
  component: PipelineEditorPage,
});

const builderRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/builder",
  beforeLoad: requireAuth,
  component: BuilderPage,
});

const builderSessionRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/builder/$sessionId",
  beforeLoad: requireAuth,
  component: BuilderPage,
});

const runsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/runs",
  beforeLoad: requireAuth,
  component: RunsListPage,
});

const runRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/runs/$runId",
  beforeLoad: requireAuth,
  component: RunDetailPage,
});

const schedulesRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/schedules",
  beforeLoad: requireAuth,
  component: SchedulesPage,
});

const newScheduleRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/schedules/new",
  beforeLoad: requireAuth,
  component: NewSchedulePage,
});

const settingsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/settings",
  beforeLoad: requireAuth,
  component: SettingsPage,
});

const adminRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/admin",
  beforeLoad: requireAuth,
  component: AdminPage,
});

const routeTree = rootRoute.addChildren([
  indexRoute,
  loginRoute,
  loginNestedRoute,
  registerRoute,
  registerNestedRoute,
  dashboardRoute,
  pipelinesRoute,
  editorRoute,
  builderRoute,
  builderSessionRoute,
  runsRoute,
  runRoute,
  schedulesRoute,
  newScheduleRoute,
  settingsRoute,
  adminRoute,
]);

const router = createRouter({ routeTree });

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}

// Track page views on navigation
router.subscribe("onResolved", ({ toLocation }) => {
  trackPageView(toLocation.pathname);
});

const rootElement = document.getElementById("root");
if (!rootElement) throw new Error("Root element not found");

createRoot(rootElement).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  </StrictMode>,
);
