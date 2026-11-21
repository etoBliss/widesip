"use client";

import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState, type ReactNode } from "react";

const api=process.env.NEXT_PUBLIC_API_URL??"http://localhost:4000";
const authEntryPaths=new Set(["/","/sign-in","/sign-up","/forgot-password"]);

export function AuthPageGate({children}:{children:ReactNode}) {
  const pathname=usePathname();
  const router=useRouter();
  const shouldCheck=authEntryPaths.has(pathname);
  const [checking,setChecking]=useState(shouldCheck);
  useEffect(()=>{
    if(!shouldCheck){setChecking(false);return;}
    let active=true;
    setChecking(true);
    fetch(`${api}/api/auth/get-session`,{credentials:"include",cache:"no-store"})
      .then(response=>response.ok?response.json():null)
      .then(session=>{if(!active)return;if(session?.user)router.replace("/app");else setChecking(false);})
      .catch(()=>{if(active)setChecking(false);});
    return ()=>{active=false;};
  },[pathname,router,shouldCheck]);
  if(shouldCheck && checking) return <main className="auth-route-loading" aria-label="Checking sign-in status"><span className="loading-orbit"/><span>Loading your workspace…</span></main>;
  return <>{children}</>;
}
