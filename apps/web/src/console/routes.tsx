import { Navigate, Route } from "react-router-dom";
import { useAuth, type Role } from "../lib/auth";
import { ConsoleLayout, RoleGate } from "./ConsoleLayout";
import { AdminAccounts } from "./pages/admin/Accounts";
import { AdminDashboard } from "./pages/admin/Dashboard";
import { AdminGroups } from "./pages/admin/Groups";
import { AdminKeys } from "./pages/admin/Keys";
import { AdminModels } from "./pages/admin/Models";
import { AdminNodes } from "./pages/admin/Nodes";
import { AdminTeams } from "./pages/admin/Teams";
import { AdminNodeMonitor } from "./pages/admin/NodeMonitor";
import { AdminOnboarders } from "./pages/admin/Onboarders";
import { AdminRedeem } from "./pages/admin/Redeem";
import { AdminSettings } from "./pages/admin/Settings";
import { AdminUsage } from "./pages/admin/Usage";
import { AdminErrors } from "./pages/admin/Errors";
import { AdminFinance } from "./pages/admin/Finance";
import { AdminUsers } from "./pages/admin/Users";
import { ProviderAccounts } from "./pages/provider/Accounts";
import { ProviderEarnings } from "./pages/provider/Earnings";
import { ProviderGuide } from "./pages/provider/Guide";
import { ProviderNodes } from "./pages/provider/Nodes";
import { ProviderOverview } from "./pages/provider/Overview";
import { ProviderSettlements } from "./pages/provider/Settlements";
import { OnboardPage } from "./pages/shared/Onboard";
import { UserGuide } from "./pages/user/Guide";
import { UserKeys } from "./pages/user/Keys";
import { UserModels } from "./pages/user/Models";
import { UserOverview } from "./pages/user/Overview";
import { UserUsage } from "./pages/user/Usage";
import { UserWallet } from "./pages/user/Wallet";

function Home() {
  const { me } = useAuth();
  if (me?.role === "admin") return <AdminDashboard />;
  if (me?.role === "provider") return <ProviderOverview />;
  if (me?.role === "ops") return <Navigate to="/console/admin/accounts" replace />;
  return <UserOverview />;
}

function Guide() {
  const { me } = useAuth();
  return me?.role === "provider" ? <ProviderGuide /> : <UserGuide />;
}

const consumerish = ["consumer", "admin"] as const;
const g = (roles: readonly Role[], el: JSX.Element) => (
  <RoleGate roles={[...roles]}>{el}</RoleGate>
);

/** <Route> tree for /console/* (docs/v3-design.md §9). */
export const consoleRoutes = (
  <Route path="console" element={<ConsoleLayout />}>
    <Route index element={<Home />} />
    <Route path="guide" element={<Guide />} />
    {/* consumer (admins can use these for their own keys) */}
    <Route path="keys" element={g(consumerish, <UserKeys />)} />
    <Route path="usage" element={g(consumerish, <UserUsage />)} />
    <Route path="wallet" element={g(["consumer"], <UserWallet />)} />
    <Route path="models" element={g(consumerish, <UserModels />)} />
    {/* provider */}
    <Route path="nodes" element={g(["provider"], <ProviderNodes />)} />
    <Route path="accounts" element={g(["provider"], <ProviderAccounts />)} />
    <Route path="provider/onboard" element={g(["provider"], <OnboardPage scope="provider" />)} />
    <Route path="earnings" element={g(["provider"], <ProviderEarnings />)} />
    <Route path="settlements" element={g(["provider"], <ProviderSettlements />)} />
    {/* admin */}
    <Route path="admin/users" element={g(["admin"], <AdminUsers />)} />
    <Route path="admin/keys" element={g(["admin"], <AdminKeys />)} />
    <Route path="admin/groups" element={g(["admin"], <AdminGroups />)} />
    {/* account pool: admin + ops (账号管理员) */}
    <Route path="admin/accounts" element={g(["admin", "ops"], <AdminAccounts />)} />
    <Route path="admin/onboard" element={g(["admin", "ops"], <OnboardPage scope="admin" />)} />
    <Route path="admin/onboarders" element={g(["admin"], <AdminOnboarders />)} />
    <Route path="admin/models" element={g(["admin"], <AdminModels />)} />
    <Route path="admin/redeem" element={g(["admin"], <AdminRedeem />)} />
    <Route path="admin/finance" element={g(["admin"], <AdminFinance />)} />
    <Route path="admin/usage" element={g(["admin"], <AdminUsage />)} />
    <Route path="admin/errors" element={g(["admin"], <AdminErrors />)} />
    <Route path="admin/nodes" element={g(["admin"], <AdminNodes />)} />
    <Route path="admin/teams" element={g(["admin"], <AdminTeams />)} />
    <Route path="admin/node-monitor" element={g(["admin"], <AdminNodeMonitor />)} />
    <Route path="admin/settings" element={g(["admin"], <AdminSettings />)} />
    <Route path="*" element={<Home />} />
  </Route>
);
