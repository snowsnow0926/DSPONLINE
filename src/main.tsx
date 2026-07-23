import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";
import "./theme.css";
import { installAnalytics } from "./game/analytics";
import { installClientMonitoring } from "./game/monitoring";
import { registerPwa } from "./pwa";

installClientMonitoring();
const adminRoute = /^\/admin\/?$/.test(window.location.pathname);
if (!adminRoute) installAnalytics();

async function mountApplication(): Promise<void> {
  const application = adminRoute
    ? await import("./components/AdminDashboard").then(({ AdminDashboard }) => <AdminDashboard />)
    : await import("./GameLauncher").then(({ App }) => <App />);
  createRoot(document.getElementById("root")!).render(<StrictMode>{application}</StrictMode>);
}

void mountApplication();

if (import.meta.env.PROD) window.addEventListener("load", () => void registerPwa());
