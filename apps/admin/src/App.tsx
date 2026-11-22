import { Skeleton } from "@vpn/ui";
import { lazy, Suspense } from "react";
import { BrowserRouter, Route, Routes } from "react-router";
import { Login } from "./session";

const Workspace = lazy(() => import("./AdminWorkspace"));

export function App() {
  return <BrowserRouter><Routes>
    <Route path="/login" element={<Login />} />
    <Route path="/invitation" element={<Login invitation />} />
    <Route path="*" element={<Suspense fallback={<main className="login"><Skeleton /></main>}><Workspace /></Suspense>} />
  </Routes></BrowserRouter>;
}
