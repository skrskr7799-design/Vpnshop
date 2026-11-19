import "@fontsource-variable/geologica";
import "./styles/global.css";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router";
import { App } from "./App";
import { bindSessionExpiry } from "./features/auth/session";
import { configureZodMessages } from "./features/auth/zod-messages";

configureZodMessages();

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: 1 } },
});
bindSessionExpiry(queryClient);

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </QueryClientProvider>
  </StrictMode>,
);
