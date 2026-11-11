import { Navigate, Route, Routes } from "react-router-dom";
import { Layout } from "./components/Layout";
import { consoleRoutes } from "./console/routes";
import { CostCalculator } from "./pages/CostCalculator";
import { Docs } from "./pages/Docs";
import { DocsEndpoints } from "./pages/DocsEndpoints";
import { Home } from "./pages/Home";
import { Login } from "./pages/Login";
import { Models } from "./pages/Models";
import { NotFound } from "./pages/NotFound";
import { OnboardSite } from "./pages/OnboardSite";
import { Pool } from "./pages/Pool";
import { Pricing } from "./pages/Pricing";
import { Provider } from "./pages/Provider";
import { Tech } from "./pages/Tech";

export default function App() {
  return (
    <Routes>
      {consoleRoutes}
      <Route path="dashboard/*" element={<Navigate to="/console" replace />} />
      <Route element={<Layout />}>
        <Route index element={<Home />} />
        <Route path="models" element={<Models />} />
        <Route path="pool" element={<Pool />} />
        <Route path="onboard" element={<OnboardSite />} />
        <Route path="pricing" element={<Pricing />} />
        <Route path="docs" element={<Docs />} />
        <Route path="docs/endpoints" element={<DocsEndpoints />} />
        <Route path="tech" element={<Tech />} />
        <Route path="tools/verify" element={<Navigate to="/tech" replace />} />
        <Route path="tools/claude-api-cost-calculator" element={<CostCalculator />} />
        <Route path="provider" element={<Provider />} />
        <Route path="login" element={<Login />} />
        <Route path="register" element={<Navigate to="/login" replace />} />
        <Route path="referral" element={<Navigate to="/" replace />} />
        <Route path="*" element={<NotFound />} />
      </Route>
    </Routes>
  );
}
