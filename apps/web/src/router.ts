import { useCallback, useEffect, useState } from "react";

export type View = "profiles" | "accounts" | "platforms" | "jobs" | "updates" | "guide" | "mcp";
export type DetailTab =
  | "overview"
  | "settings"
  | "accounts"
  | "tasks"
  | "sessions"
  | "updates";
export type AppRoute =
  | { kind: "page"; view: View; jobId?: string }
  | { kind: "profile"; profileId: string; tab: DetailTab; jobId?: string }
  | { kind: "create"; from: "accounts"; accountId: string }
  | { kind: "not-found"; path: string };

const profileIdPattern = /^cf_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const views: View[] = ["profiles", "accounts", "platforms", "jobs", "updates", "guide"];
const detailTabs: DetailTab[] = [
  "overview", "settings", "accounts", "tasks", "sessions", "updates",
];

interface LocationParts {
  pathname: string;
  search?: string;
  hash?: string;
}

function optionalId(query: URLSearchParams, name: string) {
  const value = query.get(name);
  return value && value.length <= 200 && /^[a-zA-Z0-9_-]+$/.test(value)
    ? value
    : undefined;
}

function createRoute(query: URLSearchParams): AppRoute {
  const accountId = optionalId(query, "account");
  return accountId
    ? { kind: "create", from: "accounts", accountId }
    : { kind: "page", view: "accounts" };
}

/** Parse only known application paths. Secrets and arbitrary query keys are never routed. */
export function parseRoute(location: LocationParts): AppRoute {
  const path = location.pathname.replace(/\/+$/, "") || "/";
  let query = new URLSearchParams(location.search || "");
  // Older bookmarked creation links used a hash on the single-page root.
  if ((path === "/" || path === "/profiles") && /^#create(?:\?|$)/.test(location.hash || "")) {
    query = new URLSearchParams(location.hash!.split("?")[1] || "");
    return createRoute(query);
  }
  if (path === "/") return { kind: "page", view: "profiles" };
  if (path === "/profiles/new") {
    return createRoute(query);
  }
  // /mcp belongs to the Streamable HTTP protocol endpoint, not the SPA.
  if (path === "/integrations/mcp") return { kind: "page", view: "mcp" };
  const page = views.find((view) => path === `/${view}`);
  if (page) return { kind: "page", view: page, ...(page === "jobs" ? { jobId: optionalId(query, "job") } : {}) };
  const match = path.match(/^\/profiles\/([^/]+)(?:\/([^/]+))?$/);
  if (match) {
    let profileId: string;
    try { profileId = decodeURIComponent(match[1]); }
    catch { return { kind: "not-found", path }; }
    const tab = match[2] || "overview";
    if (profileIdPattern.test(profileId) && detailTabs.includes(tab as DetailTab)) {
      return {
        kind: "profile", profileId, tab: tab as DetailTab,
        ...(tab === "tasks" ? { jobId: optionalId(query, "job") } : {}),
      };
    }
  }
  return { kind: "not-found", path };
}

export function routePath(route: AppRoute): string {
  if (route.kind === "not-found") return route.path;
  const query = new URLSearchParams();
  let path: string;
  if (route.kind === "create") {
    path = "/profiles/new";
    query.set("from", route.from);
    query.set("account", route.accountId);
  } else {
    path = route.kind === "profile"
      ? `/profiles/${encodeURIComponent(route.profileId)}/${route.tab}`
      : route.view === "mcp" ? "/integrations/mcp" : `/${route.view}`;
    if (route.jobId && ((route.kind === "profile" && route.tab === "tasks") || (route.kind === "page" && route.view === "jobs"))) {
      query.set("job", route.jobId);
    }
  }
  return `${path}${query.size ? `?${query}` : ""}`;
}

export function resolveRoute(location: LocationParts) {
  const route = parseRoute(location);
  return { route, path: routePath(route) };
}

/** All navigation uses the same parser, including refresh, back and forward. */
export function useAppRoute() {
  const [route, setRoute] = useState(() => parseRoute(window.location));
  useEffect(() => {
    const sync = () => {
      const next = resolveRoute(window.location);
      if (`${window.location.pathname}${window.location.search}${window.location.hash}` !== next.path) {
        window.history.replaceState(window.history.state, "", `${window.location.origin}${next.path}`);
      }
      setRoute(next.route);
    };
    sync();
    window.addEventListener("popstate", sync);
    return () => window.removeEventListener("popstate", sync);
  }, []);
  const navigate = useCallback((destination: AppRoute, replace = false) => {
    const [pathname, search = ""] = routePath(destination).split("?");
    const next = resolveRoute({ pathname, search });
    const current = `${window.location.pathname}${window.location.search}${window.location.hash}`;
    if (current === next.path) return;
    window.history[replace ? "replaceState" : "pushState"](null, "", `${window.location.origin}${next.path}`);
    setRoute(next.route);
  }, []);
  return { route, navigate };
}
