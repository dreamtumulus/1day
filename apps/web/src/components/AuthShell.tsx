import type { ReactNode } from "react";
import { LogoMark } from "./Icon";

export function AuthShell({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  return (
    <div className="container-x flex justify-center py-16 sm:py-24">
      <div className="card w-full max-w-md p-6 sm:p-8">
        <div className="flex items-center gap-2.5">
          <LogoMark size={26} />
          <h1 className="font-display text-xl font-bold tracking-[-0.02em] text-on-surface">
            {title}
          </h1>
        </div>
        <div className="mt-6">{children}</div>
      </div>
    </div>
  );
}
