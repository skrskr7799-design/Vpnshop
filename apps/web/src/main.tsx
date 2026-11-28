import "@vpn/ui/style.css";
import "./styles/global.css";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router";
import { App } from "./App";
import { StorefrontUpdate } from "./components/StorefrontUpdate";
import { motionDisabled } from "./features/auth/entry";
import { bindSessionExpiry } from "./features/auth/session";
import { configureZodMessages } from "./features/auth/zod-messages";

configureZodMessages();
document.documentElement.toggleAttribute("data-mzt-reduce-motion", motionDisabled());

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: 1 } },
});
bindSessionExpiry(queryClient);

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <App />
        <StorefrontUpdate />
      </BrowserRouter>
    </QueryClientProvider>
  </StrictMode>,
);
