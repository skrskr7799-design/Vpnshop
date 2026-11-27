import { Skeleton } from "@vpn/ui";
import { lazy, Suspense, useEffect } from "react";
import { BrowserRouter, Route, Routes } from "react-router";
import { useProductBrand } from "./config";
import { Login } from "./session";

const Workspace = lazy(() => import("./AdminWorkspace"));

export function App() {
  const brand = useProductBrand();
  useEffect(() => { document.title = `Администрирование — ${brand}`; }, [brand]);
  return <BrowserRouter><Routes>
    <Route path="/login" element={<Login />} />
    <Route path="/invitation" element={<Login invitation />} />
    <Route path="*" element={<Suspense fallback={<main className="login"><Skeleton /></main>}><Workspace /></Suspense>} />
  </Routes></BrowserRouter>;
}
